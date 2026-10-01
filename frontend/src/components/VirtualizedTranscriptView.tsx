'use client';

import { useCallback, useMemo, useRef, useReducer, startTransition, useEffect, useState, memo } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { motion } from "framer-motion";
import { Trash2 } from "lucide-react";
import { TranscriptSegmentData } from "@/types";
import { useSpeakerNames, speakerLabel, SpeakerNamesApi, LIVE_SPEAKER_NAMES_KEY } from "@/hooks/useSpeakerNames";
import { ME_LABEL } from "@/lib/speakerStats";
import { formatTs, initialsOf } from "@/lib/meetingFormat";
import { Avatar } from "@/components/Unified/primitives";

/**
 * Имена участников, заданные ВО ВРЕМЯ записи (встречи в базе ещё нет).
 * Живут в сессии до сохранения встречи, потом переносятся в неё.
 * (Константа переехала в hooks/useSpeakerNames, экспорт оставлен для совместимости.)
 */
export { LIVE_SPEAKER_NAMES_KEY };

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    /** true на экране встречи. Пустой транскрипт тогда = «в этой встрече
     *  ничего не записано» + удалить, а не приглашение начать запись. */
    isMeetingView?: boolean;
    /** Удалить эту (пустую) встречу - кнопка на экране встречи. */
    onDeleteMeeting?: () => void;
    /** id встречи. Нужен, чтобы дать переименовать участников
     *  («Собеседник 1» -> «Иван») и запомнить это для встречи. */
    meetingId?: string;

    // --- Главный экран INmeet (мессенджер) ---
    /** Имена участников снаружи - общие с шапкой встречи и панелью «Участники».
     *  Без них лента сама грузит и хранит имена (useSpeakerNames). */
    speakerNames?: SpeakerNamesApi;
    /** «назвать» у безымянного голоса: своё действие (на записи - поле имени в панели «Участники»).
     *  Без него открывается окно «Имя участника». */
    onNameRequest?: (speakerKey: string) => void | boolean;
    /** Подсветить совпадения поиска. */
    highlight?: string;
    /** Текст, если реплик нет (например, поиск ничего не нашёл). */
    emptyText?: string;
    /** Отступы ленты (класс). По умолчанию - как в расшифровке встречи. */
    contentClassName?: string;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

/** Подсветка совпадений поиска внутри реплики. */
function highlightText(text: string, query?: string) {
    const q = (query || '').trim();
    if (!q) return text;
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${esc})`, 'gi'));
    return parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase()
            ? <mark key={i} className="rounded-[3px] bg-[#FFE8A3] px-px text-inherit">{part}</mark>
            : part
    );
}

/** Одна реплика мессенджером: собеседники слева (круглый аватар), мои - справа, голубым. */
const MessageRow = memo(function MessageRow({
    id,
    timestamp,
    text,
    speakerKey,
    label,
    isMe,
    unnamed,
    firstOfRun,
    lastOfRun,
    isFirst,
    confidence,
    showConfidence,
    highlight,
    onRename,
    onNameRequest,
}: {
    id: string;
    timestamp: number;
    text: string;
    speakerKey?: string;
    label?: string;
    isMe: boolean;
    unnamed: boolean;
    firstOfRun: boolean;
    lastOfRun: boolean;
    isFirst: boolean;
    confidence?: number;
    showConfidence: boolean;
    highlight?: string;
    onRename?: () => void;
    onNameRequest?: () => void;
}) {
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '…' : text);
    const time = formatTs(timestamp);
    const timeTitle = confidence !== undefined && showConfidence
        ? `Уверенность распознавания ${Math.round(confidence * 100)}%`
        : undefined;
    const pad = isFirst ? '' : firstOfRun ? 'pt-3' : 'pt-[3px]';
    const name = label ? (
        onRename ? (
            <button
                type="button"
                onClick={onRename}
                className="rounded-md hover:text-im-on-tone hover:underline hover:decoration-dotted hover:underline-offset-2"
                title="Нажмите, чтобы задать имя участника"
            >
                {label}
            </button>
        ) : <span>{label}</span>
    ) : null;
    const bubble = 'text-[14.5px] leading-[21px] pl-3.5 pr-3.5 pt-[9px] pb-2.5 [overflow-wrap:anywhere] im-doc';
    const inBubbleTime = !firstOfRun && time ? (
        <time className="float-right -mb-[3px] -mr-0.5 ml-3 mt-[3px] text-[11.5px] leading-[18px] text-im-mut im-num" title={timeTitle}>{time}</time>
    ) : null;

    if (isMe) {
        return (
            <div id={`segment-${id}`} className={`flex justify-end ${pad}`}>
                <div className="flex min-w-0 max-w-[84%] flex-col items-end">
                    {firstOfRun && (
                        <div className="mx-1 mb-1 flex h-[18px] items-center gap-1.5 text-[12.5px] font-semibold leading-[18px] text-im-mut">
                            <time className="font-normal im-num" title={timeTitle}>{time}</time>
                            {name}
                        </div>
                    )}
                    <div className={`${bubble} rounded-[18px_6px_18px_18px] bg-im-tone text-im-on-tone`}>
                        {inBubbleTime}{highlightText(displayText, highlight)}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div id={`segment-${id}`} className={`flex items-end gap-2 ${pad}`}>
            <div className="mb-px w-[30px] flex-none">
                {lastOfRun && speakerKey && (
                    <Avatar initials={unnamed ? '?' : initialsOf(label)} size={30} fontSize={11} title={label} />
                )}
            </div>
            <div className="flex min-w-0 max-w-[calc(90%-38px)] flex-col items-start">
                {firstOfRun && (
                    <div className="mb-1 ml-0.5 mr-1 flex h-[18px] items-center gap-1.5 text-[12.5px] font-semibold leading-[18px] text-im-mut">
                        {name}
                        <time className="font-normal im-num" title={timeTitle}>{time}</time>
                        {unnamed && onNameRequest && (
                            <button
                                type="button"
                                onClick={onNameRequest}
                                className="rounded-md text-[12.5px] font-semibold text-im-on-tone hover:underline hover:underline-offset-[3px]"
                            >
                                назвать
                            </button>
                        )}
                    </div>
                )}
                <div
                    className={`${bubble} rounded-[6px_18px_18px_18px] text-im-ink ${
                        unnamed ? 'bg-white shadow-[inset_0_0_0_1.5px_var(--im-line2)]' : 'bg-im-bub'
                    }`}
                >
                    {inBubbleTime}{highlightText(displayText, highlight)}
                </div>
            </div>
        </div>
    );
});

/** Индикатор «Слушаю…»: живая форма перетекает печенька -> клевер. */
function ListeningPill({ paused, className = 'self-start' }: { paused: boolean; className?: string }) {
    return (
        <div
            className={`inline-flex h-[38px] flex-none items-center gap-2.5 rounded-[19px] bg-im-bub pl-[11px] pr-4 text-[13.5px] text-im-mut ${paused ? 'im-paused' : ''} ${className}`}
            aria-live="polite"
        >
            <i className="im-morph im-sh-cookie9 block h-[18px] w-[18px] bg-im-acc" aria-hidden="true" />
            {paused ? 'Запись на паузе' : 'Слушаю…'}
        </div>
    );
}

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    isMeetingView = false,
    onDeleteMeeting,
    meetingId,
    speakerNames,
    onNameRequest,
    highlight,
    emptyText,
    contentClassName = 'px-4 pb-6 pt-1.5',
}) => {
    // Пользовательские имена участников: "system_1" -> "Иван".
    // Если имена пришли снаружи (главный экран) - свои не грузим.
    const ownNames = useSpeakerNames(meetingId, !speakerNames);
    const names = speakerNames ?? ownNames;
    const [renamingKey, setRenamingKey] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    // Имя - на все метки голоса этого человека (слитые голоса с той же подписью), иначе после
    // переименования слитый голос снова отделился бы.
    const saveSpeakerName = useCallback(async (key: string, name: string) => {
        setRenamingKey(null);
        const label = names.labelFor(key);
        const keys = new Set<string>([key]);
        for (const seg of segments) {
            const sp = (seg as any).speaker as string | undefined;
            if (sp && sp !== 'mic' && names.labelFor(sp) === label) keys.add(sp);
        }
        for (const k of keys) await names.saveName(k, name);
    }, [names, segments]);

    // Слить голос с уже известным участником (Geo 30.09: в разговоре один на один речь собеседника
    // местами уходит в других «Собеседников»): «Вы» и имена, уже данные другим голосам.
    const mergeTargetsFor = useCallback((key: string) => {
        const own = (names.labelFor(key) || '').trim().toLowerCase();
        const seen = new Set<string>();
        const out: string[] = [];
        const others = new Set<string>();
        for (const seg of segments) {
            const sp = (seg as any).speaker as string | undefined;
            if (sp && sp !== 'mic' && sp !== key) others.add(names.labelFor(sp) || '');
        }
        for (const n of [ME_LABEL, ...Object.entries(names.names).filter(([k]) => k !== key).map(([, v]) => v), ...others]) {
            const t = (n || '').trim();
            const low = t.toLowerCase();
            if (!t || low === own || seen.has(low)) continue;
            seen.add(low);
            out.push(t);
        }
        return out;
    }, [names, segments]);

    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Подсказка про доступ к микрофону: если запись идёт, не на паузе, а реплик нет
    // дольше ~12 сек - вероятно нет сигнала с микрофона. На Windows доступ к микрофону
    // часто слетает после обновления, и раньше приложение это никак не показывало
    // (немой экран «Слушаю речь...»). Теперь подсказываем и ведём в настройки.
    const [showMicHint, setShowMicHint] = useState(false);
    useEffect(() => {
        if (isRecording && !isPaused && segments.length === 0) {
            const t = setTimeout(() => setShowMicHint(true), 12000);
            return () => clearTimeout(t);
        }
        setShowMicHint(false);
    }, [isRecording, isPaused, segments.length]);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 64, // Estimated height per message
        // Высота запоминается за самой репликой, а не за её номером: при подгрузке страниц реплики
        // сортируются по времени и встают в середину, номера сдвигаются - и прежние высоты доставались
        // чужим репликам, реплики наезжали друг на друга (Geo 01.10: «бывает глючит наслоение»).
        getItemKey: (index) => segments[index]?.id ?? index,
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Живая запись: при открытии ленты (в том числе при возврате к записи из прошлой встречи
    // или после перезагрузки с уже распознанными репликами) - сразу к последней реплике.
    const didInitialScrollRef = useRef(false);
    useEffect(() => {
        if (!isRecording || didInitialScrollRef.current || segments.length === 0) return;
        didInitialScrollRef.current = true;
        const toBottom = () => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
        };
        if (segments.length >= VIRTUALIZATION_THRESHOLD) {
            virtualizer.scrollToIndex(segments.length - 1, { align: 'end' });
        }
        // Высоты реплик измеряются после первого кадра - докручиваем ещё пару раз.
        requestAnimationFrame(toBottom);
        [120, 300, 700].forEach((ms) => setTimeout(toBottom, ms));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRecording, segments.length]);

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    const labelFor = names.labelFor;
    // Переименовывать можно и в сохранённой встрече, и прямо во время записи.
    const renameHandlerFor = useCallback(
        (sp?: string) => {
            if (!sp) return undefined;
            return () => { setRenamingKey(sp); setRenameValue(names.names[sp] || ''); };
        },
        [names.names]
    );
    const nameRequestFor = useCallback(
        (sp?: string) => {
            if (!sp) return undefined;
            return () => {
                // Экран записи сам показывает поле имени; если поля нет (голос скрыт) - наше окно.
                if (onNameRequest && onNameRequest(sp) !== false) return;
                setRenamingKey(sp);
                setRenameValue(names.names[sp] || '');
            };
        },
        [names.names, onNameRequest]
    );

    const renderRow = (index: number) => {
        const segment = segments[index];
        const sp = (segment as any).speaker as string | undefined;
        const prevSp = index > 0 ? (segments[index - 1] as any).speaker : '__none__';
        const nextSp = index < segments.length - 1 ? (segments[index + 1] as any).speaker : '__none__';
        // Голос, слитый с вашим (имя «Вы»), показываем как ваши реплики; подряд идущие реплики одного
        // человека (даже под разными метками голоса) - одной группой.
        const isMe = sp === 'mic' || names.names[sp ?? '']?.trim() === ME_LABEL;
        const unnamed = !!sp && !isMe && !names.names[sp];
        const sameAs = (other?: string) => other !== '__none__' && labelFor(other) === labelFor(sp);
        return (
            <MessageRow
                id={segment.id}
                timestamp={segment.timestamp}
                text={getDisplayText(segment)}
                speakerKey={sp}
                label={labelFor(sp)}
                isMe={isMe}
                unnamed={unnamed}
                firstOfRun={index === 0 || !sameAs(prevSp)}
                lastOfRun={index === segments.length - 1 || !sameAs(nextSp)}
                isFirst={index === 0}
                confidence={segment.confidence}
                showConfidence={showConfidence}
                highlight={highlight}
                onRename={renameHandlerFor(sp)}
                onNameRequest={unnamed ? nameRequestFor(sp) : undefined}
            />
        );
    };

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;
    const showListening = !isStopping && isRecording && !isProcessing && segments.length > 0;

    const loadMoreBlock = (hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
        <div ref={loadMoreTriggerRef} className="mt-2 flex items-center justify-center py-4">
            {isLoadingMore ? (
                <div className="flex items-center gap-2 text-im-mut">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-im-line border-t-im-acc" />
                    <span className="text-[13px]">Загружаю ещё…</span>
                </div>
            ) : hasMore && totalCount > 0 ? (
                <span className="text-[13px] text-im-mut">Показано {loadedCount} из {totalCount} реплик</span>
            ) : null}
        </div>
    );

    return (
        <div ref={scrollRef} className={`im-scroll im-fade-y flex h-full flex-col overflow-y-auto ${contentClassName}`}>
            {/* Окно «Имя участника»: клик по подписи спикера -> задать своё имя.
                Имя применяется ко ВСЕМ репликам этого голоса и запоминается за встречей. */}
            {/* Окно - поверх всего экрана (портал в body): внутри колонки расшифровки оно оказывалось
                под соседней колонкой, и видно было только размытую ленту. */}
            {renamingKey && typeof document !== 'undefined' && createPortal(
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-[#101828]/30 font-sans backdrop-blur-[2px]"
                    onClick={() => setRenamingKey(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Имя участника"
                        className="w-[340px] rounded-[22px] bg-white p-5 shadow-float"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="mb-1 text-[15px] font-bold text-im-ink">Имя участника</p>
                        <p className="mb-3 text-[12.5px] leading-[17px] text-im-mut">
                            {meetingId
                                ? `Заменит подпись «${speakerLabel(renamingKey)}» во всей расшифровке этой встречи. Чтобы имя попало в резюме, сделайте резюме заново.`
                                : `Заменит подпись «${speakerLabel(renamingKey)}» во всех репликах - и попадёт в резюме после встречи.`}
                        </p>
                        {mergeTargetsFor(renamingKey).length > 0 && (
                            <div className="mb-3">
                                <p className="mb-1.5 text-[12px] leading-4 text-im-mut">Это кто-то из участников:</p>
                                <div className="flex flex-wrap gap-1.5">
                                {mergeTargetsFor(renamingKey).map((t) => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => saveSpeakerName(renamingKey, t)}
                                        className="h-7 max-w-[150px] truncate rounded-[14px] bg-im-tone px-2.5 text-[12.5px] font-semibold text-im-on-tone transition-colors hover:bg-im-tone-h"
                                        title={`Отдать реплики «${speakerLabel(renamingKey)}» участнику «${t}»`}
                                    >
                                        {t}
                                    </button>
                                ))}
                                </div>
                            </div>
                        )}
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') saveSpeakerName(renamingKey, renameValue);
                                if (e.key === 'Escape') setRenamingKey(null);
                            }}
                            placeholder="Например: Иван Петров"
                            className="h-10 w-full rounded-[20px] border-[1.5px] border-im-line2 bg-white px-3.5 text-[14px] text-im-ink outline-none placeholder:text-im-mut focus:border-im-acc"
                        />
                        <div className="mt-4 flex items-center justify-between">
                            <button
                                type="button"
                                onClick={() => saveSpeakerName(renamingKey, '')}
                                className="text-[12.5px] font-medium text-im-mut hover:text-im-ink"
                            >
                                Сбросить
                            </button>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setRenamingKey(null)}
                                    className="h-9 rounded-[18px] bg-white px-3.5 text-[13.5px] font-semibold text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] hover:bg-im-hover"
                                >
                                    Отмена
                                </button>
                                <button
                                    type="button"
                                    onClick={() => saveSpeakerName(renamingKey, renameValue)}
                                    className="h-9 rounded-[18px] bg-im-acc px-4 text-[13.5px] font-semibold text-white hover:bg-im-acc-h"
                                >
                                    Сохранить
                                </button>
                            </div>
                        </div>
                    </div>
                </div>,
                document.body,
            )}

            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex flex-1 flex-col items-center justify-center px-6 text-center"
                >
                    {isRecording ? (
                        <>
                            <ListeningPill paused={isPaused} className="self-center" />
                            <p className="mt-3 max-w-[300px] text-[13px] leading-[19px] text-im-mut">
                                {isPaused ? 'Нажмите «Продолжить», чтобы возобновить запись' : 'Говорите - расшифровка появится здесь в реальном времени'}
                            </p>
                            {showMicHint && !isPaused && (
                                <div className="mt-5 max-w-sm rounded-[18px] bg-[#FFF6E5] px-4 py-3 text-left">
                                    <p className="text-[12.5px] font-semibold text-[#93370D]">Не слышу звук с микрофона</p>
                                    <p className="mt-1 text-[12px] leading-relaxed text-[#93370D]/80">
                                        Похоже, у приложения нет доступа к микрофону. После обновления системе иногда нужно разрешить его заново.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => { import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_microphone_settings').catch(() => {})); }}
                                        className="mt-2 text-[12.5px] font-semibold text-[#93370D] underline underline-offset-2 hover:opacity-80"
                                    >
                                        Открыть настройки микрофона
                                    </button>
                                </div>
                            )}
                        </>
                    ) : emptyText ? (
                        <p className="text-[13px] text-im-mut">{emptyText}</p>
                    ) : isMeetingView ? (
                        /* Открыта пустая встреча: не было записано ни одной реплики.
                           Понятный статус + возможность удалить, чтобы не копить мусор. */
                        <div className="flex flex-col items-center">
                            <h3 className="mb-1.5 text-[15px] font-bold text-im-ink">В этой встрече ничего не записано</h3>
                            <p className="mb-5 max-w-xs text-[13px] leading-[19px] text-im-mut">
                                Похоже, запись была пустой или не получилась. Можно удалить встречу, чтобы не хранить лишнее.
                            </p>
                            {onDeleteMeeting && (
                                <button
                                    type="button"
                                    onClick={onDeleteMeeting}
                                    className="inline-flex h-9 items-center gap-2 rounded-[18px] bg-white px-4 text-[13.5px] font-semibold text-im-ink2 shadow-[inset_0_0_0_1px_var(--im-line2)] transition-colors hover:bg-im-hover"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    Удалить встречу
                                </button>
                            )}
                        </div>
                    ) : (
                        <p className="text-[13px] text-im-mut">Начните запись, чтобы увидеть расшифровку</p>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                            flex: 'none',
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    {renderRow(virtualRow.index)}
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {loadMoreBlock}

                    {/* Listening indicator when recording */}
                    {showListening && <div className="pt-3"><ListeningPill paused={isPaused} /></div>}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="flex-none">
                        {segments.map((segment, index) => (
                            <motion.div
                                key={segment.id}
                                initial={{ opacity: 0, y: 5 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.15 }}
                            >
                                {renderRow(index)}
                            </motion.div>
                        ))}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {loadMoreBlock}

                    {/* Listening indicator when recording */}
                    {showListening && <div className="pt-3"><ListeningPill paused={isPaused} /></div>}
                </>
            )}
        </div>
    );
};

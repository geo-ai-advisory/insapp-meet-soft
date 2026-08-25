'use client';

import { useCallback, useMemo, useRef, useReducer, startTransition, useEffect, useState, memo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData } from "@/types";

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

    /** true на экране встречи (meeting-details). Пустой транскрипт тогда = «в этой встрече
     *  ничего не записано» + удалить, а не онбординг «начни запись» (тот для главного экрана). */
    isMeetingView?: boolean;
    /** Удалить эту (пустую) встречу - кнопка на экране встречи. */
    onDeleteMeeting?: () => void;
    /** id встречи. Нужен, чтобы дать переименовать участников
     *  («Собеседник 1» -> «Иван») и запомнить это для встречи. */
    meetingId?: string;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

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

// Цвет имени спикера - стабильный по имени (цветные спикеры как в макете встречи).
// Палитра 1:1 с эталоном scr-meet: первый спикер синий (#2563EB), второй teal (#14B8A6),
// далее фиолетовый/янтарь/розовый по кругу.
const SPEAKER_COLOR_CLASSES = [
    'text-[hsl(var(--brand-blue))]',
    'text-teal-500',
    'text-violet-600',
    'text-amber-600',
    'text-rose-600',
    'text-cyan-600',
];
// Цвет назначается по порядку ПЕРВОГО появления спикера во встрече (эталон scr-meet:
// 1й голос синий, 2й teal, далее violet/amber/...), а НЕ по хешу имени - чтобы главный
// спикер всегда был фирменным синим.
function speakerColorByIndex(index: number): string {
    return SPEAKER_COLOR_CLASSES[index % SPEAKER_COLOR_CLASSES.length];
}

// Подпись спикера:
//   "mic"       - канал микрофона            -> «Вы»
//   "system"    - собеседник не распознан    -> «Собеседник»
//   "system_N"  - распознанный собеседник N  -> «Собеседник N»
function speakerLabel(sp?: string): string | undefined {
    if (!sp) return undefined;
    if (sp === 'mic') return 'Вы';
    if (sp === 'system') return 'Собеседник';
    const guest = /^system_(\d+)$/.exec(sp);
    if (guest) return `Собеседник ${guest[1]}`;
    return sp;
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    speaker,
    speakerColor,
    confidence,
    isStreaming,
    showConfidence,
    onRenameSpeaker,
}: {
    id: string;
    timestamp: number;
    text: string;
    speaker?: string;
    speakerColor?: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    /** Клик по имени участника - переименовать (доступно на экране встречи). */
    onRenameSpeaker?: () => void;
}) {
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);

    return (
        <div id={`segment-${id}`} className="mb-3.5">
            {/* Тайм-код отдельной строкой над репликой (эталон scr-meet): приглушённый, tabular-nums. */}
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="block text-xs text-muted-foreground tabular-nums mb-0.5 w-fit">
                        {formatRecordingTime(timestamp)}
                    </span>
                </TooltipTrigger>
                <TooltipContent>
                    {confidence !== undefined && showConfidence && (
                        <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                    )}
                </TooltipContent>
            </Tooltip>
            {isStreaming ? (
                <div className="bg-secondary border border-border rounded-lg px-3 py-2">
                    <p className="text-[15px] text-foreground leading-relaxed">
                        {speaker && (
                            <span
                                className={`font-semibold ${speakerColor || ''} ${onRenameSpeaker ? 'cursor-pointer hover:underline decoration-dotted underline-offset-2' : ''}`}
                                onClick={onRenameSpeaker}
                                title={onRenameSpeaker ? 'Нажми, чтобы задать имя участника' : undefined}
                            >
                                {speaker}:&nbsp;
                            </span>
                        )}
                        {displayText}
                    </p>
                </div>
            ) : (
                <p className="text-[15px] text-foreground leading-relaxed">
                    {speaker && (
                        <span
                            className={`font-semibold ${speakerColor || ''} ${onRenameSpeaker ? 'cursor-pointer hover:underline decoration-dotted underline-offset-2' : ''}`}
                            onClick={onRenameSpeaker}
                            title={onRenameSpeaker ? 'Нажми, чтобы задать имя участника' : undefined}
                        >
                            {speaker}:&nbsp;
                        </span>
                    )}
                    {displayText}
                </p>
            )}
        </div>
    );
});

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
}) => {
    // Пользовательские имена участников: "system_1" -> "Иван".
    // Грузим для встречи и подставляем вместо автоподписи «Собеседник 1».
    const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
    const [renamingKey, setRenamingKey] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    useEffect(() => {
        if (!meetingId) return;
        let alive = true;
        import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke<Record<string, string>>('api_get_speaker_names', { meetingId }))
            .then((names) => { if (alive && names) setSpeakerNames(names); })
            .catch(() => { /* имён ещё нет - показываем автоподписи */ });
        return () => { alive = false; };
    }, [meetingId]);

    const saveSpeakerName = useCallback(async (key: string, name: string) => {
        setSpeakerNames((prev) => {
            const next = { ...prev };
            if (name.trim()) next[key] = name.trim(); else delete next[key];
            return next;
        });
        setRenamingKey(null);
        if (!meetingId) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('api_set_speaker_name', { meetingId, speakerKey: key, displayName: name.trim() });
        } catch (e) {
            console.warn('[insapp-meet] не удалось сохранить имя участника', e);
        }
    }, [meetingId]);

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
        estimateSize: () => 60, // Estimated height per segment
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

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
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

    // Стабильный цвет спикера по порядку первого появления (как эталон).
    const speakerColorIndex = useMemo(() => {
        const m = new Map<string, number>();
        let n = 0;
        for (const s of segments) {
            const sp = (s as any).speaker;
            if (sp && !m.has(sp)) m.set(sp, n++);
        }
        return m;
    }, [segments]);
    const colorFor = (sp?: string) => (sp ? speakerColorByIndex(speakerColorIndex.get(sp) ?? 0) : '');

    // Итоговая подпись: заданное пользователем имя, иначе автоматическая
    // («Вы» / «Собеседник N»).
    const labelFor = useCallback(
        (sp?: string) => (sp && speakerNames[sp]) || speakerLabel(sp),
        [speakerNames]
    );
    // Переименовывать даём на экране встречи (там встреча уже сохранена).
    const renameHandlerFor = useCallback(
        (sp?: string) => {
            if (!sp || !meetingId) return undefined;
            return () => { setRenamingKey(sp); setRenameValue(speakerNames[sp] || ''); };
        },
        [meetingId, speakerNames]
    );

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Окно «Имя участника»: клик по подписи спикера -> задать своё имя.
                Имя применяется ко ВСЕМ репликам этого голоса и запоминается за встречей. */}
            {renamingKey && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                    onClick={() => setRenamingKey(null)}
                >
                    <div
                        className="bg-background border border-border rounded-xl shadow-xl p-5 w-[320px]"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <p className="text-sm font-semibold text-foreground mb-1">Имя участника</p>
                        <p className="text-xs text-muted-foreground mb-3">
                            Заменит подпись «{speakerLabel(renamingKey)}» во всей расшифровке этой встречи.
                        </p>
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') saveSpeakerName(renamingKey, renameValue);
                                if (e.key === 'Escape') setRenamingKey(null);
                            }}
                            placeholder="Например: Иван Петров"
                            className="w-full px-3 py-2 text-sm rounded-lg border border-input bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
                        />
                        <div className="flex justify-between items-center mt-4">
                            <button
                                type="button"
                                onClick={() => saveSpeakerName(renamingKey, '')}
                                className="text-xs text-muted-foreground hover:text-foreground"
                            >
                                Сбросить
                            </button>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => setRenamingKey(null)}
                                    className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-secondary"
                                >
                                    Отмена
                                </button>
                                <button
                                    type="button"
                                    onClick={() => saveSpeakerName(renamingKey, renameValue)}
                                    className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90"
                                >
                                    Сохранить
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* Индикация записи (статус «Идёт запись» / таймер / уровень) теперь живёт в
                НИЖНЕМ ДОКЕ (RecordingDockStatus) - дубль-бар в ленте убран, чтобы текст
                расшифровки ничего не отвлекало (компоновка «нижний док», вариант B). */}

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-muted-foreground mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-muted-foreground">
                                {isPaused ? 'Запись на паузе' : 'Слушаю речь...'}
                            </p>
                            <p className="text-xs mt-1 text-muted-foreground">
                                {isPaused ? 'Нажми «Продолжить», чтобы возобновить запись' : 'Говори - расшифровка появится в реальном времени'}
                            </p>
                            {showMicHint && !isPaused && (
                                <div className="mt-5 mx-auto max-w-sm rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-left">
                                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">Не слышу звук с микрофона</p>
                                    <p className="text-[11px] mt-1 leading-relaxed text-amber-600 dark:text-amber-400/80">
                                        Похоже, у приложения нет доступа к микрофону. После обновления системе иногда нужно разрешить его заново.
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => { import('@tauri-apps/api/core').then(({ invoke }) => invoke('open_microphone_settings').catch(() => {})); }}
                                        className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 hover:opacity-80"
                                    >
                                        Открыть настройки микрофона
                                    </button>
                                </div>
                            )}
                        </>
                    ) : isMeetingView ? (
                        /* Открыта пустая встреча: не было записано ни одной реплики.
                           Понятный статус + возможность удалить, чтобы не копить мусор. */
                        <div className="flex flex-col items-center px-6">
                            <div className="w-14 h-14 mb-4 rounded-2xl bg-secondary flex items-center justify-center">
                                <svg className="w-7 h-7 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" strokeLinejoin="round"/><path d="M14 3v5h5" strokeLinejoin="round"/></svg>
                            </div>
                            <h3 className="text-base font-semibold text-foreground mb-1.5">В этой встрече ничего не записано</h3>
                            <p className="text-sm text-muted-foreground mb-5 max-w-xs leading-relaxed">
                                Похоже, запись была пустой или не получилась. Можно удалить встречу, чтобы не хранить лишнее.
                            </p>
                            {onDeleteMeeting && (
                                <button
                                    type="button"
                                    onClick={onDeleteMeeting}
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm font-medium transition-colors hover:bg-red-100 active:scale-[0.98] dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                    Удалить встречу
                                </button>
                            )}
                        </div>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Добро пожаловать в Insapp-meet!</p>
                            <p className="text-xs mt-1">Начни запись, чтобы увидеть расшифровку</p>
                        </>
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
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

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
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        speaker={labelFor((segment as any).speaker)}
                                        speakerColor={colorFor((segment as any).speaker)}
                                        onRenameSpeaker={renameHandlerFor((segment as any).speaker)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <div className="w-4 h-4 border-2 border-border border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-muted-foreground">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-muted-foreground"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        speaker={labelFor((segment as any).speaker)}
                                        speakerColor={colorFor((segment as any).speaker)}
                                        onRenameSpeaker={renameHandlerFor((segment as any).speaker)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <div className="w-4 h-4 border-2 border-border border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-muted-foreground">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-muted-foreground"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};

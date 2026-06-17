'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Settings, PanelLeftClose, PanelLeftOpen, House, Trash2, Mic, Square, Plus, Search as SearchIcon, Pencil, BookOpenText, X, FileUp, Mic2, Youtube, Moon, Sun } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import type { CurrentMeeting } from '@/components/Sidebar/SidebarProvider';
import { ConfirmationModal } from '../ConfirmationModel/confirmation-modal';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { TranscriptModelProps } from '@/components/TranscriptSettings';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { useConfig } from '@/contexts/ConfigContext';
import { UserProfileButton } from '@/components/UserProfileButton';
import { triggerUpdateCheck } from '@/components/UpdateChecker';
import { DownloadCloud } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog"
import { VisuallyHidden } from "@/components/ui/visually-hidden"

import Logo from '../Logo';
import Info from '../Info';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';

interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
}

/* ============================================================================
 *  Перенос утверждённого макета "Insapp Pro" (вариант B).
 *  Цвета берём ТОЛЬКО из дизайн-токенов в globals.css через hsl(var(--token)),
 *  чтобы и светлая, и тёмная темы были корректны без правок config/globals.
 *    фон сайдбара          -> --card (белый/тёмный, отдельный от страницы)
 *    бордер                -> --border
 *    обычный текст         -> --foreground
 *    приглушённый текст    -> --muted-foreground
 *    ховер                 -> --secondary
 *    активный пункт        -> --accent / --accent-foreground (мягко-синий)
 *    "Начать запись"       -> --destructive (красный)
 *    бейдж "скоро"         -> --secondary / --muted-foreground
 * ========================================================================== */
const T = {
  sidebar: 'bg-[hsl(var(--card))] border-[hsl(var(--border))]',
  text: 'text-[hsl(var(--foreground))]',
  muted: 'text-[hsl(var(--muted-foreground))]',
  faint: 'text-[hsl(var(--muted-foreground))]/70',
  hover: 'hover:bg-[hsl(var(--secondary))]',
  border: 'border-[hsl(var(--border))]',
  // навигационный пункт: приглушённый -> ховер делает фон secondary и текст обычным
  navRow:
    'flex items-center gap-3 px-3 py-2 rounded-[10px] text-[13.5px] font-medium text-[hsl(var(--muted-foreground))] cursor-pointer transition-colors duration-150 hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))] active:scale-[0.985]',
  navDisabled:
    'flex items-center gap-3 px-3 py-2 rounded-[10px] text-[13.5px] font-medium text-[hsl(var(--muted-foreground))]/60 cursor-default select-none',
  badgeSoon:
    'ml-auto text-[9.5px] font-semibold tracking-wide px-1.5 py-0.5 rounded-[5px] bg-[hsl(var(--secondary))] text-[hsl(var(--muted-foreground))]',
  sectionHead:
    'text-[11px] font-semibold tracking-[0.06em] uppercase text-[hsl(var(--muted-foreground))]/80 px-3 mb-1.5',
  footBtn:
    'relative w-[30px] h-[30px] rounded-lg flex items-center justify-center text-[hsl(var(--muted-foreground))] transition-colors duration-150 hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))] active:scale-[0.92]',
};

const Sidebar: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  // Версия приложения - читается из Tauri, чтобы не хардкодить и не врать после обновления
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  // ── Переключатель темы ──────────────────────────────────────────────────
  // В провайдере темы нет, поэтому держим её локально: класс .dark на
  // documentElement + сохранение в localStorage. SidebarProvider не трогаем.
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('insapp-meet-theme');
      const root = document.documentElement;
      const dark = saved ? saved === 'dark' : root.classList.contains('dark');
      root.classList.toggle('dark', dark);
      setIsDark(dark);
    } catch { /* localStorage может быть недоступен */ }
  }, []);
  const toggleTheme = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      try {
        document.documentElement.classList.toggle('dark', next);
        localStorage.setItem('insapp-meet-theme', next ? 'dark' : 'light');
      } catch { /* no-op */ }
      console.log('[insapp-meet] sidebar: переключение темы', next ? 'dark' : 'light');
      return next;
    });
  }, []);

  const {
    currentMeeting,
    setCurrentMeeting,
    sidebarItems,
    isCollapsed,
    toggleCollapse,
    handleRecordingToggle,
    searchTranscripts,
    searchResults,
    isSearching,
    meetings,
    setMeetings,
    serverAddress
  } = useSidebar();

  // Коллапс с логом (логику коллапса берём из провайдера, лишь оборачиваем)
  const handleToggleCollapse = useCallback(() => {
    console.log('[insapp-meet] sidebar: коллапс', isCollapsed ? 'развернуть' : 'свернуть');
    toggleCollapse();
  }, [isCollapsed, toggleCollapse]);

  // Старт записи с логом (вся логика - в провайдере)
  const handleStartRecording = useCallback(() => {
    console.log('[insapp-meet] sidebar: старт записи');
    handleRecordingToggle();
  }, [handleRecordingToggle]);

  // Get recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const { betaFeatures } = useConfig();
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['meetings']));
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'ollama',
    model: '',
    whisperModel: '',
    apiKey: null,
    ollamaEndpoint: null
  });
  const [transcriptModelConfig, setTranscriptModelConfig] = useState<TranscriptModelProps>({
    provider: 'parakeet',
    model: 'parakeet-tdt-0.6b-v3-int8',
  });
  const [settingsSaveSuccess, setSettingsSaveSuccess] = useState<boolean | null>(null);

  // State for edit modal
  const [editModalState, setEditModalState] = useState<{ isOpen: boolean; meetingId: string | null; currentTitle: string }>({
    isOpen: false,
    meetingId: null,
    currentTitle: ''
  });
  const [editingTitle, setEditingTitle] = useState<string>('');

  // Ensure 'meetings' folder is always expanded
  useEffect(() => {
    if (!expandedFolders.has('meetings')) {
      const newExpanded = new Set(expandedFolders);
      newExpanded.add('meetings');
      setExpandedFolders(newExpanded);
    }
  }, [expandedFolders]);

  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; itemId: string | null }>({ isOpen: false, itemId: null });

  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchModelConfig = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log('Waiting for server address to load before fetching model config');
        return;
      }

      try {
        const data = await invoke('api_get_model_config') as any;
        if (data && data.provider !== null) {
          // Fetch API key if not included and provider requires it
          if (data.provider !== 'ollama' && !data.apiKey) {
            try {
              const apiKeyData = await invoke('api_get_api_key', {
                provider: data.provider
              }) as string;
              data.apiKey = apiKeyData;
            } catch (err) {
              console.error('Failed to fetch API key:', err);
            }
          }
          setModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch model config:', error);
      }
    };

    fetchModelConfig();
  }, [serverAddress]);


  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchTranscriptSettings = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log('Waiting for server address to load before fetching transcript settings');
        return;
      }

      try {
        const data = await invoke('api_get_transcript_config') as any;
        if (data && data.provider !== null) {
          setTranscriptModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch transcript settings:', error);
      }
    };
    fetchTranscriptSettings();
  }, [serverAddress]);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<ModelConfig>('model-config-updated', (event) => {
        console.log('Sidebar received model-config-updated event:', event.payload);
        setModelConfig(event.payload);
      });

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => cleanup = fn);

    return () => {
      cleanup?.();
    };
  }, []);



  // Handle model config save
  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey,
        ollamaEndpoint: config.ollamaEndpoint,
      });

      setModelConfig(config);
      console.log('Model config saved successfully');
      setSettingsSaveSuccess(true);

      // Emit event to sync other components
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      // Track settings change
      await Analytics.trackSettingsChanged('model_config', `${config.provider}_${config.model}`);
    } catch (error) {
      console.error('Error saving model config:', error);
      setSettingsSaveSuccess(false);
    }
  };

  const handleSaveTranscriptConfig = async (updatedConfig?: TranscriptModelProps) => {
    try {
      const configToSave = updatedConfig || transcriptModelConfig;
      const payload = {
        provider: configToSave.provider,
        model: configToSave.model,
        apiKey: configToSave.apiKey ?? null
      };
      console.log('Saving transcript config with payload:', payload);

      await invoke('api_save_transcript_config', {
        provider: payload.provider,
        model: payload.model,
        apiKey: payload.apiKey,
      });


      setSettingsSaveSuccess(true);

      // Track settings change
      const transcriptConfigToSave = updatedConfig || transcriptModelConfig;
      await Analytics.trackSettingsChanged('transcript_config', `${transcriptConfigToSave.provider}_${transcriptConfigToSave.model}`);
    } catch (error) {
      console.error('Failed to save transcript config:', error);
      setSettingsSaveSuccess(false);
    }
  };

  // Handle search input changes
  const handleSearchChange = useCallback(async (value: string) => {
    setSearchQuery(value);

    // If search query is empty, just return to normal view
    if (!value.trim()) return;

    // Search through transcripts
    await searchTranscripts(value);

    // Make sure the meetings folder is expanded when searching
    if (!expandedFolders.has('meetings')) {
      const newExpanded = new Set(expandedFolders);
      newExpanded.add('meetings');
      setExpandedFolders(newExpanded);
    }
  }, [expandedFolders, searchTranscripts]);

  // Combine search results with sidebar items
  const filteredSidebarItems = useMemo(() => {
    if (!searchQuery.trim()) return sidebarItems;

    // If we have search results, highlight matching meetings
    if (searchResults.length > 0) {
      // Get the IDs of meetings that matched in transcripts
      const matchedMeetingIds = new Set(searchResults.map(result => result.id));

      return sidebarItems
        .map(folder => {
          // Always include folders in the results
          if (folder.type === 'folder') {
            if (!folder.children) return folder;

            // Filter children based on search results or title match
            const filteredChildren = folder.children.filter(item => {
              // Include if the meeting ID is in our search results
              if (matchedMeetingIds.has(item.id)) return true;

              // Or if the title matches the search query
              return item.title.toLowerCase().includes(searchQuery.toLowerCase());
            });

            return {
              ...folder,
              children: filteredChildren
            };
          }

          // For non-folder items, check if they match the search
          return (matchedMeetingIds.has(folder.id) ||
            folder.title.toLowerCase().includes(searchQuery.toLowerCase()))
            ? folder : undefined;
        })
        .filter((item): item is SidebarItem => item !== undefined); // Type-safe filter
    } else {
      // Fall back to title-only filtering if no transcript results
      return sidebarItems
        .map(folder => {
          // Always include folders in the results
          if (folder.type === 'folder') {
            if (!folder.children) return folder;

            // Filter children based on search query
            const filteredChildren = folder.children.filter(item =>
              item.title.toLowerCase().includes(searchQuery.toLowerCase())
            );

            return {
              ...folder,
              children: filteredChildren
            };
          }

          // For non-folder items, check if they match the search
          return folder.title.toLowerCase().includes(searchQuery.toLowerCase()) ? folder : undefined;
        })
        .filter((item): item is SidebarItem => item !== undefined); // Type-safe filter
    }
  }, [sidebarItems, searchQuery, searchResults, expandedFolders]);


  const handleDelete = async (itemId: string) => {
    console.log('Deleting item:', itemId);
    const payload = {
      meetingId: itemId
    };

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('api_delete_meeting', {
        meetingId: itemId,
      });
      console.log('Meeting deleted successfully');
      const updatedMeetings = meetings.filter((m: CurrentMeeting) => m.id !== itemId);
      setMeetings(updatedMeetings);

      // Track meeting deletion
      Analytics.trackMeetingDeleted(itemId);

      // Show success toast
      toast.success("Встреча удалена", {
        description: "Все связанные данные удалены"
      });

      // If deleting the active meeting, navigate to home
      if (currentMeeting?.id === itemId) {
        setCurrentMeeting({ id: 'intro-call', title: '+ Новая встреча' });
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      toast.error("Не удалось удалить встречу", {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleDeleteConfirm = () => {
    if (deleteModalState.itemId) {
      handleDelete(deleteModalState.itemId);
    }
    setDeleteModalState({ isOpen: false, itemId: null });
  };

  // Handle modal editing of meeting names
  const handleEditStart = (meetingId: string, currentTitle: string) => {
    setEditModalState({
      isOpen: true,
      meetingId: meetingId,
      currentTitle: currentTitle
    });
    setEditingTitle(currentTitle);
  };

  const handleEditConfirm = async () => {
    const newTitle = editingTitle.trim();
    const meetingId = editModalState.meetingId;

    if (!meetingId) return;

    // Prevent empty titles
    if (!newTitle) {
      toast.error("Название встречи не может быть пустым");
      return;
    }

    try {
      await invoke('api_save_meeting_title', {
        meetingId: meetingId,
        title: newTitle,
      });

      // Update local state
      const updatedMeetings = meetings.map((m: CurrentMeeting) =>
        m.id === meetingId ? { ...m, title: newTitle } : m
      );
      setMeetings(updatedMeetings);

      // Update current meeting if it's the one being edited
      if (currentMeeting?.id === meetingId) {
        setCurrentMeeting({ id: meetingId, title: newTitle });
      }

      // Track the edit
      Analytics.trackButtonClick('edit_meeting_title', 'sidebar');

      toast.success("Название встречи изменено");

      // Close modal and reset state
      setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
      setEditingTitle('');
    } catch (error) {
      console.error('Failed to update meeting title:', error);
      toast.error("Не удалось изменить название", {
        description: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const handleEditCancel = () => {
    setEditModalState({ isOpen: false, meetingId: null, currentTitle: '' });
    setEditingTitle('');
  };

  const toggleFolder = (folderId: string) => {
    // Normal toggle behavior for all folders
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    setExpandedFolders(newExpanded);
  };

  // Expose setShowModelSettings to window for Rust tray to call
  useEffect(() => {
    (window as any).openSettings = () => {
      setShowModelSettings(true);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).openSettings;
    };
  }, []);

  // Открыть встречу из бокового списка (навигация + лог + трекинг)
  const openMeeting = (item: SidebarItem) => {
    console.log('[insapp-meet] sidebar: открытие встречи', item.id);
    setCurrentMeeting({ id: item.id, title: item.title });
    const basePath = item.id.startsWith('intro-call') ? '/' :
      item.id.includes('-') ? `/meeting-details?id=${item.id}` : `/notes/${item.id}`;
    router.push(basePath);
  };

  // ── Свёрнутый сайдбар: вертикальный ряд иконок ───────────────────────────
  const renderCollapsedIcons = () => {
    if (!isCollapsed) return null;

    const isHomePage = pathname === '/';
    const isMeetingPage = pathname?.includes('/meeting-details');
    const isSettingsPage = pathname === '/settings';

    const railBtn = (active: boolean) =>
      `p-2 rounded-lg transition-colors duration-150 ${active
        ? 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]'
        : 'text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))]'}`;

    return (
      <TooltipProvider>
        <div className="flex flex-col items-center space-y-3 mt-3">
          <Logo isCollapsed={isCollapsed} />

          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => router.push('/')} className={railBtn(!!isHomePage)}>
                <House className="w-5 h-5 stroke-[1.75]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>Главная</p></TooltipContent>
          </Tooltip>

          {/* Начать запись - красная акцентная кнопка */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleStartRecording}
                disabled={isRecording}
                className={`p-2 rounded-full transition-colors duration-150 shadow-sm text-white ${isRecording ? 'bg-[hsl(var(--brand-red))] cursor-not-allowed' : 'bg-[hsl(var(--brand-red))] hover:bg-[hsl(var(--brand-red-hover))]'}`}
              >
                {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>{isRecording ? "Идёт запись..." : "Начать запись"}</p></TooltipContent>
          </Tooltip>

          {/* Загрузить запись */}
          {betaFeatures.importAndRetranscribe && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={() => openImportDialog()} className={railBtn(false)}>
                  <FileUp className="w-5 h-5 stroke-[1.75]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right"><p>Загрузить запись</p></TooltipContent>
            </Tooltip>
          )}

          {/* Встречи - раскрывает сайдбар и папку */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  if (isCollapsed) handleToggleCollapse();
                  toggleFolder('meetings');
                }}
                className={railBtn(!!isMeetingPage)}
              >
                <BookOpenText className="w-5 h-5 stroke-[1.75]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>Встречи</p></TooltipContent>
          </Tooltip>

          <div className={`w-6 border-t ${T.border} my-1`} />

          {/* Настройки */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => router.push('/settings')} className={railBtn(!!isSettingsPage)}>
                <Settings className="w-5 h-5 stroke-[1.75]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>Настройки</p></TooltipContent>
          </Tooltip>

          {/* Тема */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={toggleTheme} className={railBtn(false)} aria-label="Светлая / Тёмная">
                {isDark ? <Sun className="w-5 h-5 stroke-[1.75]" /> : <Moon className="w-5 h-5 stroke-[1.75]" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>Светлая / Тёмная</p></TooltipContent>
          </Tooltip>

          <Info isCollapsed={isCollapsed} />

          {/* Проверить обновление вручную (авто-проверка идёт при запуске) */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => triggerUpdateCheck()} className={railBtn(false)} aria-label="Проверить обновление">
                <DownloadCloud className="w-5 h-5 stroke-[1.75]" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right"><p>Проверить обновление</p></TooltipContent>
          </Tooltip>

          {/* Профиль пользователя - имя залогиненного + выход/вход */}
          <UserProfileButton collapsed={true} />
        </div>
      </TooltipProvider>
    );
  };

  // Find matching transcript snippet for a meeting item
  const findMatchingSnippet = (itemId: string) => {
    if (!searchQuery.trim() || !searchResults.length) return null;
    return searchResults.find(result => result.id === itemId);
  };

  // ── Пункт списка встреч (вариант B): точка + название, активный = мягко-синий
  //    с левой полоской, при наведении - карандаш (переименовать) и корзина (удалить).
  const renderMeetingItem = (item: SidebarItem) => {
    const isActive = currentMeeting?.id === item.id;
    const isMeetingItem = item.id.includes('-') && !item.id.startsWith('intro-call');
    const matchingResult = isMeetingItem ? findMatchingSnippet(item.id) : null;
    const hasTranscriptMatch = !!matchingResult;

    return (
      <div key={item.id}>
        <div
          onClick={() => openMeeting(item)}
          className={`relative group flex items-center gap-[9px] px-[11px] py-[7px] rounded-lg text-[12.5px] cursor-pointer transition-colors duration-150 ${isActive
            ? 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] font-semibold'
            : `text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] hover:text-[hsl(var(--foreground))] ${hasTranscriptMatch ? 'bg-[hsl(var(--accent))]/40' : ''}`
            }`}
        >
          {/* левая акцент-полоска у активного */}
          {isActive && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-[3px] bg-[hsl(var(--accent-foreground))]" />
          )}

          {isMeetingItem ? (
            <span className={`w-1.5 h-1.5 rounded-full flex-none ${isActive ? 'bg-[hsl(var(--accent-foreground))]' : 'bg-[hsl(var(--muted-foreground))]/60'}`} />
          ) : (
            <span className="flex-none flex items-center justify-center w-5 h-5 rounded-full bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]">
              <Plus className="w-3 h-3" />
            </span>
          )}

          <span className="flex-1 truncate">{item.title}</span>

          {isMeetingItem && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <button
                onClick={(e) => { e.stopPropagation(); handleEditStart(item.id, item.title); }}
                className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--accent-foreground))] hover:bg-[hsl(var(--accent))]/60 flex-shrink-0"
                aria-label="Изменить название встречи"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteModalState({ isOpen: true, itemId: item.id }); }}
                className="p-1 rounded-md text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive))]/10 flex-shrink-0"
                aria-label="Удалить встречу"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* сниппет совпадения при поиске по транскрипту */}
        {hasTranscriptMatch && (
          <div className="mt-1 ml-[26px] text-[11px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--accent))]/30 p-1.5 rounded border border-[hsl(var(--border))] line-clamp-2">
            <span className="font-medium text-[hsl(var(--accent-foreground))]">Совпадение:</span> {matchingResult!.matchContext}
          </div>
        )}
      </div>
    );
  };

  // Все встречи (плоский список) из всех folder-узлов sidebarItems
  const meetingChildren = filteredSidebarItems
    .filter(item => item.type === 'folder' && expandedFolders.has(item.id) && item.children)
    .flatMap(item => item.children!);

  const isHomePage = pathname === '/';

  return (
    <div className="fixed top-0 left-0 h-screen z-40">
      {/* Кнопка-свёртка убрана: артефакт старого Meetily (Geo: «старое сворачивание,
          которое не нужно»). Сайдбар всегда развёрнут, как в макете Insapp Pro. */}

      <div
        className={`h-screen ${T.sidebar} border-r shadow-sm flex flex-col transition-all duration-300 ${isCollapsed ? 'w-16' : 'w-[232px]'
          }`}
      >
        {/* Свёрнутый режим - вертикальный ряд иконок */}
        {isCollapsed && (
          <div className="flex-1 flex flex-col">
            {renderCollapsedIcons()}
          </div>
        )}

        {/* ── Развёрнутый сайдбар ── */}
        {!isCollapsed && (
          <>
            {/* Бренд + поиск (отступ под traffic-light на macOS) */}
            <div className="flex-shrink-0 px-2 pt-7 pb-2">
              <div className="flex items-center gap-2 px-2 pb-3.5">
                <Logo isCollapsed={isCollapsed} />
                <span className="text-[9.5px] font-bold tracking-wider text-[hsl(var(--accent-foreground))] bg-[hsl(var(--accent))] px-1.5 py-0.5 rounded-[5px]">
                  PRO
                </span>
              </div>

              {/* Поиск из сайдбара убран: в макете Insapp Pro поиск только в верхней
                  панели главного экрана (был дубль). Фильтрация списка встреч остаётся
                  доступной через верхний поиск. */}
            </div>

            {/* ── Навигация ── */}
            <nav className="flex-shrink-0 px-2 flex flex-col gap-px">
              {/* Главная */}
              <div
                onClick={() => router.push('/')}
                className={`${T.navRow} ${isHomePage && !isRecording ? 'bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))] font-semibold hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--accent-foreground))]' : ''}`}
              >
                <House className="w-[18px] h-[18px] stroke-[1.75]" />
                <span className="flex-1">Главная</span>
              </div>

              {/* Начать запись - красный акцент */}
              <button
                onClick={handleStartRecording}
                disabled={isRecording}
                className={`${T.navRow} w-full text-left text-[hsl(var(--destructive))] hover:text-[hsl(var(--destructive))] disabled:cursor-not-allowed ${isRecording ? 'bg-[hsl(var(--destructive))]/10 font-semibold' : 'hover:bg-[hsl(var(--destructive))]/10'}`}
              >
                {isRecording ? (
                  <Square className="w-[18px] h-[18px] stroke-[1.75]" />
                ) : (
                  <span className="w-[18px] h-[18px] flex items-center justify-center">
                    <span className="w-3 h-3 rounded-full bg-[hsl(var(--destructive))]" />
                  </span>
                )}
                <span className="flex-1">{isRecording ? 'Идёт запись...' : 'Начать запись'}</span>
              </button>

              {/* Загрузить запись */}
              {betaFeatures.importAndRetranscribe && (
                <button onClick={() => openImportDialog()} className={`${T.navRow} w-full text-left`}>
                  <FileUp className="w-[18px] h-[18px] stroke-[1.75]" />
                  <span className="flex-1">Загрузить запись</span>
                </button>
              )}

              {/* Диктовка - заглушка "скоро" (не навигирует) */}
              <div className={T.navDisabled} aria-disabled="true">
                <Mic2 className="w-[18px] h-[18px] stroke-[1.75]" />
                <span>Диктовка</span>
                <span className={T.badgeSoon}>скоро</span>
              </div>

              {/* YouTube - заглушка "скоро" (не навигирует) */}
              <div className={T.navDisabled} aria-disabled="true">
                <Youtube className="w-[18px] h-[18px] stroke-[1.75]" />
                <span>YouTube</span>
                <span className={T.badgeSoon}>скоро</span>
              </div>
            </nav>

            {/* ── Секция "Встречи" ── */}
            <div className="flex-1 flex flex-col min-h-0 mt-3.5 px-2">
              <div className={`${T.sectionHead} flex items-center`}>
                <span>Встречи</span>
                {searchQuery && isSearching && (
                  <span className="ml-2 normal-case tracking-normal text-[hsl(var(--accent-foreground))] animate-pulse">Ищу...</span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 flex flex-col gap-px">
                {meetingChildren.length > 0 ? (
                  meetingChildren.map(child => renderMeetingItem(child))
                ) : (
                  <div className="px-[11px] py-2 text-[12px] text-[hsl(var(--muted-foreground))]/70">
                    {searchQuery ? 'Ничего не найдено' : 'Пока нет встреч'}
                  </div>
                )}
              </div>
            </div>

            {/* ── Подвал: профиль + иконки (настройки/тема/обновление) в ОДНУ строку (как макет) ── */}
            <div className={`flex-shrink-0 mt-auto px-2 pb-3 pt-2 border-t ${T.border}`}>
              <TooltipProvider>
                <div className="flex items-center gap-1">
                  {/* Профиль (аватар-инициалы + имя) */}
                  <div className="min-w-0 flex-1">
                    <UserProfileButton collapsed={false} />
                  </div>
                  {/* Иконки управления - справа, в той же строке (3 шт, как в макете) */}
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => router.push('/settings')} className={T.footBtn} aria-label="Настройки">
                          <Settings className="w-[17px] h-[17px] stroke-[1.75]" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>Настройки</p></TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={toggleTheme} className={T.footBtn} aria-label="Светлая / Тёмная">
                          {isDark ? <Sun className="w-[17px] h-[17px] stroke-[1.75]" /> : <Moon className="w-[17px] h-[17px] stroke-[1.75]" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>Светлая / Тёмная</p></TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button onClick={() => triggerUpdateCheck()} className={T.footBtn} aria-label="Проверить обновление">
                          <DownloadCloud className="w-[17px] h-[17px] stroke-[1.75]" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top"><p>Проверить обновление</p></TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </TooltipProvider>
            </div>
          </>
        )}
      </div>

      {/* Confirmation Modal for Delete */}
      <ConfirmationModal
        isOpen={deleteModalState.isOpen}
        text="Точно удалить эту встречу? Действие не отменить."
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteModalState({ isOpen: false, itemId: null })}
      />

      {/* Edit Meeting Title Modal */}
      <Dialog open={editModalState.isOpen} onOpenChange={(open) => {
        if (!open) handleEditCancel();
      }}>
        <DialogContent className="sm:max-w-[425px]">
          <VisuallyHidden>
            <DialogTitle>Изменить название встречи</DialogTitle>
          </VisuallyHidden>
          <div className="py-4">
            <h3 className="text-lg font-semibold mb-4">Изменить название встречи</h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="meeting-title" className="block text-sm font-medium text-[hsl(var(--foreground))] mb-2">
                  Название встречи
                </label>
                <input
                  id="meeting-title"
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleEditConfirm();
                    } else if (e.key === 'Escape') {
                      handleEditCancel();
                    }
                  }}
                  className="w-full px-3 py-2 border border-[hsl(var(--border))] rounded-md bg-[hsl(var(--card))] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))] focus:border-transparent"
                  placeholder="Введите название встречи"
                  autoFocus
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={handleEditCancel}
              className="px-4 py-2 text-sm font-medium text-[hsl(var(--foreground))] bg-[hsl(var(--secondary))] hover:bg-[hsl(var(--secondary))]/80 rounded-md transition-colors"
            >
              Отмена
            </button>
            <button
              onClick={handleEditConfirm}
              className="px-4 py-2 text-sm font-medium text-white bg-[hsl(var(--primary))] hover:bg-[hsl(var(--brand-blue-hover))] rounded-md transition-colors"
            >
              Сохранить
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Sidebar;

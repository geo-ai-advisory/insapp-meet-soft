'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { User, LogOut, LogIn, Loader2, RefreshCw, DownloadCloud } from 'lucide-react';
import { triggerUpdateCheck } from '@/components/UpdateChecker';
import { toast } from 'sonner';

interface Identity {
  full_name: string;
  is_registered: boolean;
}

/**
 * Кнопка профиля пользователя в sidebar.
 *  - collapsed: только иконка; expanded: иконка + имя.
 *  - Клик раскрывает inline-меню: имя залогиненного + «Синхронизировать»,
 *    «Выйти» (сброс на экран логина) или «Войти».
 * Реализовано без Radix DropdownMenu (Portal конфликтовал с overflow sidebar) -
 * простой absolute-поповер на useState.
 */
export function UserProfileButton({ collapsed }: { collapsed: boolean }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    invoke<Identity>('insapp_get_identity')
      .then(setIdentity)
      .catch(() => setIdentity({ full_name: '', is_registered: false }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Закрытие по клику вне
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const registered = !!identity?.is_registered;
  const name = identity?.full_name?.trim() || 'Вход не выполнен';

  const handleLogout = async () => {
    setBusy(true);
    try {
      await invoke('insapp_regenerate_api_key');
      toast.success('Вы вышли из учётной записи');
      setTimeout(() => window.location.reload(), 400);
    } catch {
      toast.error('Не удалось выйти');
      setBusy(false);
    }
  };

  const handleLogin = () => {
    window.location.reload();
  };

  const handleSync = async () => {
    setBusy(true);
    try {
      const s = await invoke<{ synced: number; total: number }>('insapp_sync_from_server');
      if (s.synced > 0) {
        toast.success(`Подтянул встречи из облака: ${s.synced}`);
        setTimeout(() => window.location.reload(), 800);
      } else {
        toast.info('Новых встреч в облаке нет - всё уже здесь');
        setBusy(false);
        setOpen(false);
      }
    } catch {
      toast.error('Не удалось синхронизироваться');
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className={collapsed ? 'relative' : 'relative w-full'}>
      {/* Триггер */}
      {collapsed ? (
        <button
          onClick={() => setOpen((v) => !v)}
          className="p-2 rounded-lg transition-colors duration-150 hover:bg-gray-100 text-gray-600 relative"
          aria-label="Профиль"
          title={registered ? name : 'Профиль'}
        >
          <User className="w-5 h-5 stroke-[1.75]" />
          {registered && (
            <span className="absolute bottom-1.5 right-1.5 w-2 h-2 bg-green-500 rounded-full ring-2 ring-white" />
          )}
        </button>
      ) : (
        <div className="flex items-center gap-1 w-full">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2.5 flex-1 min-w-0 px-2.5 py-2 rounded-lg transition-colors duration-150 hover:bg-gray-100 text-left"
            aria-label="Профиль"
          >
            <span className="relative shrink-0">
              <span className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-50 text-blue-600">
                <User className="w-4 h-4 stroke-[1.75]" />
              </span>
              {registered && (
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 rounded-full ring-2 ring-white" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-gray-900 truncate">{name}</span>
              <span className="block text-xs text-gray-400">{registered ? 'В сети' : 'Нажми, чтобы войти'}</span>
            </span>
          </button>
          {/* Кнопка проверки обновления - справа от имени */}
          <button
            onClick={() => triggerUpdateCheck()}
            title="Проверить обновление"
            aria-label="Проверить обновление"
            className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 transition-colors"
          >
            <DownloadCloud className="w-4 h-4 stroke-[1.75]" />
          </button>
        </div>
      )}

      {/* Inline-меню */}
      {open && (
        <div
          className={`absolute z-50 bg-white border border-gray-200 rounded-xl shadow-xl py-1.5 ${
            collapsed ? 'left-full ml-2 bottom-0 w-56' : 'left-0 bottom-full mb-2 w-[calc(100%-0px)] min-w-[200px]'
          }`}
        >
          <div className="px-3 py-2 border-b border-gray-100">
            <div className="text-sm font-semibold text-gray-900 truncate">
              {registered ? name : 'Вход не выполнен'}
            </div>
            <div className="text-xs text-gray-400 mt-0.5">
              {registered ? 'Учётная запись Insapp' : 'Войди под своей учёткой'}
            </div>
          </div>

          {registered && (
            <button
              onClick={handleSync}
              disabled={busy}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Синхронизировать встречи
            </button>
          )}

          {registered ? (
            <button
              onClick={handleLogout}
              disabled={busy}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              Выйти
            </button>
          ) : (
            <button
              onClick={handleLogin}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
            >
              <LogIn className="w-4 h-4" />
              Войти
            </button>
          )}
        </div>
      )}
    </div>
  );
}

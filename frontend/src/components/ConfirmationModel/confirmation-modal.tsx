import React from 'react';
import { Trash2 } from 'lucide-react';

interface ConfirmationModalProps {
  onConfirm: () => void;
  onCancel: () => void;
  text: string;
  isOpen: boolean;
}

export function ConfirmationModal({ onConfirm, onCancel, text, isOpen }: ConfirmationModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-foreground/40 backdrop-blur-[2px] animate-fade-in"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-[420px] bg-card text-card-foreground border border-border rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка с иконкой */}
        <div className="flex items-center gap-3 px-[22px] pt-5 pb-3.5">
          <span className="w-[38px] h-[38px] rounded-[11px] flex-none flex items-center justify-center bg-destructive/12 text-destructive">
            <Trash2 className="w-[19px] h-[19px]" />
          </span>
          <h2 className="text-base font-semibold tracking-tight text-foreground">Подтвердите удаление</h2>
        </div>
        {/* Тело */}
        <div className="px-[22px] pb-1">
          <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
        </div>
        {/* Действия */}
        <div className="flex items-center justify-end gap-2.5 px-[22px] pt-[18px] pb-5">
          <button
            onClick={onCancel}
            className="inline-flex items-center justify-center px-[18px] py-2.5 text-sm font-semibold rounded-[11px] text-muted-foreground bg-card border border-border hover:bg-secondary hover:text-foreground transition-colors active:scale-[0.97]"
          >
            Отмена
          </button>
          <button
            onClick={onConfirm}
            className="inline-flex items-center gap-2 justify-center px-[18px] py-2.5 text-sm font-semibold rounded-[11px] bg-destructive text-destructive-foreground border border-transparent shadow-sm hover:bg-destructive/90 transition-colors active:scale-[0.97]"
          >
            <Trash2 className="w-4 h-4" />
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}

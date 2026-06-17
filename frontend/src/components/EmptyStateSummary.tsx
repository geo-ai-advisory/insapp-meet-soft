'use client';

import { motion } from 'framer-motion';
import { FileQuestion, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface EmptyStateSummaryProps {
  onGenerate: () => void;
  hasModel: boolean;
  isGenerating?: boolean;
}

export function EmptyStateSummary({ onGenerate, hasModel, isGenerating = false }: EmptyStateSummaryProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center h-full p-8 text-center"
    >
      <FileQuestion className="w-16 h-16 text-muted-foreground mb-4" />
      <h3 className="text-lg font-semibold text-foreground mb-2">
        Резюме ещё не сделано
      </h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-md">
        Сгенерируй AI-резюме встречи: ключевые моменты, решения и пункты к выполнению.
      </p>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Button
                onClick={onGenerate}
                disabled={!hasModel || isGenerating}
                className="gap-2"
              >
                <Sparkles className="w-4 h-4" />
                {isGenerating ? 'Делаю резюме...' : 'Сделать резюме'}
              </Button>
            </div>
          </TooltipTrigger>
          {!hasModel && (
            <TooltipContent>
              <p>Сначала выбери модель в Настройках</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>

      {!hasModel && (
        <p className="text-xs text-amber-600 mt-3">
          Сначала выбери модель в Настройках
        </p>
      )}
    </motion.div>
  );
}

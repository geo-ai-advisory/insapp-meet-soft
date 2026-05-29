"use client";

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import dynamic from 'next/dynamic';
import { Summary, SummaryDataResponse, SummaryFormat, BlockNoteBlock } from '@/types';
import { AISummary } from './index';
import { Block } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import "@blocknote/shadcn/style.css";
// ВАЖНО: импорт строго ПОСЛЕ blocknote/shadcn/style.css.
// Оба файла unlayered с равной specificity - побеждает тот что
// загружен позже. Так наш H1=1.5em чисто перебивает дефолт 3em
// без !important и без runtime observers.
import "./blocknote-heading-override.css";

// Dynamically import BlockNote Editor to avoid SSR issues
const Editor = dynamic(() => import('../BlockNoteEditor/Editor'), { ssr: false });

interface BlockNoteSummaryViewProps {
  summaryData: SummaryDataResponse | Summary | null;
  onSave?: (data: { markdown?: string; summary_json?: BlockNoteBlock[] }) => void;
  onSummaryChange?: (summary: Summary) => void;
  status?: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  error?: string | null;
  onRegenerateSummary?: () => void;
  meeting?: {
    id: string;
    title: string;
    created_at: string;
  };
  onDirtyChange?: (isDirty: boolean) => void;
}

export interface BlockNoteSummaryViewRef {
  saveSummary: () => Promise<void>;
  getMarkdown: () => Promise<string>;
  isDirty: boolean;
}

// Format detection helper
function detectSummaryFormat(data: any): { format: SummaryFormat; data: any } {
  if (!data) {
    return { format: 'legacy', data: null };
  }

  // Priority 1: BlockNote format (has summary_json)
  if (data.summary_json && Array.isArray(data.summary_json)) {
    console.log('✅ FORMAT: BLOCKNOTE (summary_json exists)');
    return { format: 'blocknote', data };
  }

  // Priority 2: Markdown format
  if (data.markdown && typeof data.markdown === 'string') {
    console.log('✅ FORMAT: MARKDOWN (will parse to BlockNote)');
    return { format: 'markdown', data };
  }

  // Priority 3: Legacy JSON
  const hasLegacyStructure = data.MeetingName || Object.keys(data).some(key =>
    typeof data[key] === 'object' && data[key]?.title && data[key]?.blocks
  );

  if (hasLegacyStructure) {
    console.log('✅ FORMAT: LEGACY (custom JSON)');
    return { format: 'legacy', data };
  }

  return { format: 'legacy', data: null };
}

export const BlockNoteSummaryView = forwardRef<BlockNoteSummaryViewRef, BlockNoteSummaryViewProps>(({
  summaryData,
  onSave,
  onSummaryChange,
  status = 'idle',
  error = null,
  onRegenerateSummary,
  meeting,
  onDirtyChange
}, ref) => {
  const { format, data } = detectSummaryFormat(summaryData);
  const [isDirty, setIsDirty] = useState(false);
  const [currentBlocks, setCurrentBlocks] = useState<Block[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const isContentLoaded = useRef(false);

  // Create BlockNote editor for markdown parsing
  const editor = useCreateBlockNote({
    initialContent: undefined
  });

  // Parse markdown to blocks when format is markdown
  useEffect(() => {
    if (format === 'markdown' && data?.markdown && editor) {
      const loadMarkdown = async () => {
        try {
          console.log('📝 Parsing markdown to BlockNote blocks...');
          // Убираем первый H1 (типа "# Резюме: Meeting..." - Geo не хочет дубль
          // названия встречи внутри карточки, оно и так в sidebar/URL)
          const stripped = (data.markdown as string).replace(/^#\s+[^\n]*\n+/, '');
          const blocks = await editor.tryParseMarkdownToBlocks(stripped);
          editor.replaceBlocks(editor.document, blocks);
          console.log('✅ Markdown parsed successfully');

          // Delay to ensure editor has finished rendering before allowing onChange
          setTimeout(() => {
            isContentLoaded.current = true;
          }, 100);
        } catch (err) {
          console.error('❌ Failed to parse markdown:', err);
        }
      };
      loadMarkdown();
    }
  }, [format, data?.markdown, editor]);

  // Force inline font-size на каждый heading.
  // ВАЖНО: используем абсолютные rem (НЕ em), т.к. em наследуется от
  // родительского font-size. BlockNote устанавливает 3em на parent, и тогда
  // child 1.5em становится 4.5em = по-прежнему огромным.
  // rem = relative to root (16px), стабильный размер всегда.
  useEffect(() => {
    if (!editor) return;
    const sizeByLevel: Record<string, string> = { "1": "1.5rem", "2": "1.25rem", "3": "1.1rem" };
    const sizeByTag: Record<string, string> = { H1: "1.5rem", H2: "1.25rem", H3: "1.1rem" };

    const apply = () => {
      document
        .querySelectorAll('[data-content-type="heading"], .bn-block-content[data-content-type="heading"]')
        .forEach((el) => {
          const level = el.getAttribute('data-level');
          const size = level ? sizeByLevel[level] : null;
          if (!size) return;
          const html = el as HTMLElement;
          html.style.setProperty('--level', size, 'important');
          html.style.setProperty('font-size', size, 'important');
        });
      document.querySelectorAll('.bn-container h1, .bn-container h2, .bn-container h3').forEach((el) => {
        const size = sizeByTag[el.tagName];
        if (!size) return;
        (el as HTMLElement).style.setProperty('font-size', size, 'important');
      });
      document.querySelectorAll('.bn-shadcn h1, .bn-shadcn h2, .bn-shadcn h3').forEach((el) => {
        const size = sizeByTag[el.tagName];
        if (!size) return;
        (el as HTMLElement).style.setProperty('font-size', size, 'important');
      });
    };
    apply();
    const interval = setInterval(apply, 300);
    return () => clearInterval(interval);
  }, [editor, data]);

  // Set content loaded flag for blocknote format
  useEffect(() => {
    if (format === 'blocknote' && data?.summary_json) {
      // Delay to ensure editor has finished rendering
      setTimeout(() => {
        isContentLoaded.current = true;
      }, 100);
    }
  }, [format, data?.summary_json]);

  const handleEditorChange = useCallback((blocks: Block[]) => {
    // Only set dirty flag if content has finished loading
    if (isContentLoaded.current) {
      setCurrentBlocks(blocks);
      setIsDirty(true);
    }
  }, []);

  // Notify parent of dirty state changes
  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(isDirty);
    }
  }, [isDirty, onDirtyChange]);

  const handleSave = useCallback(async () => {
    if (!onSave || !isDirty) return;

    setIsSaving(true);
    try {
      console.log('💾 Saving BlockNote content...');

      // Generate markdown from current blocks
      const markdown = await editor.blocksToMarkdownLossy(currentBlocks);

      onSave({
        markdown: markdown,
        summary_json: currentBlocks as unknown as BlockNoteBlock[]
      });

      setIsDirty(false);
      console.log('✅ Save successful');
    } catch (err) {
      console.error('❌ Save failed:', err);
      alert('Failed to save changes. Please try again.');
    } finally {
      setIsSaving(false);
    }
  }, [onSave, isDirty, currentBlocks, editor]);

  // Expose methods to parent via ref
  useImperativeHandle(ref, () => ({
    saveSummary: handleSave,
    getMarkdown: async () => {
      try {
        console.log('🔍 getMarkdown called, format:', format);
        console.log('🔍 currentBlocks length:', currentBlocks.length);
        console.log('🔍 data:', data);

        // For markdown format - use the main editor
        if (format === 'markdown' && editor) {
          console.log('📝 Using markdown editor, blocks:', editor.document.length);
          const markdown = await editor.blocksToMarkdownLossy(editor.document);
          console.log('📝 Generated markdown length:', markdown.length);
          return markdown;
        }

        // For blocknote format - use currentBlocks state
        if (format === 'blocknote') {
          console.log('📝 BlockNote format, currentBlocks:', currentBlocks.length);
          if (currentBlocks.length > 0 && editor) {
            const markdown = await editor.blocksToMarkdownLossy(currentBlocks);
            console.log('📝 Generated markdown from blocks, length:', markdown.length);
            return markdown;
          }
          // Fallback: if we have the original data with markdown
          if (data?.markdown) {
            console.log('📝 Using fallback markdown from data');
            return data.markdown;
          }
        }

        // For legacy format - return empty (handled by parent)
        console.warn('⚠️ Cannot generate markdown for legacy format, returning empty');
        return '';
      } catch (err) {
        console.error('❌ Failed to generate markdown:', err);
        return '';
      }
    },
    isDirty
  }), [handleSave, isDirty, editor, format, currentBlocks, data]);

  // Render legacy format
  if (format === 'legacy') {
    console.log('🎨 Rendering LEGACY format');
    return (
      <AISummary
        summary={summaryData as Summary}
        status={status}
        error={error}
        onSummaryChange={onSummaryChange || (() => { })}
        onRegenerateSummary={onRegenerateSummary || (() => { })}
        meeting={meeting}
      />
    );
  }

  // Render BlockNote format (has summary_json)
  if (format === 'blocknote') {
    console.log('🎨 Rendering BLOCKNOTE format (direct)');
    return (
      <div className="flex flex-col w-full">
        <div className="w-full">
          <Editor
            initialContent={data.summary_json}
            onChange={(blocks) => {
              console.log('📝 Editor blocks changed:', blocks.length);
              handleEditorChange(blocks);
            }}
            editable={true}
          />
        </div>
      </div>
    );
  }

  // Render Markdown format (parse and display in BlockNote)
  if (format === 'markdown') {
    console.log('🎨 Rendering MARKDOWN format (parsed to BlockNote)');
    return (
      <div className="flex flex-col w-full">
        {/* Inline <style> прямо в JSX - точно загружается с компонентом */}
        <style dangerouslySetInnerHTML={{ __html: `
          .insapp-bn-scope [data-content-type="heading"][data-level="1"] {
            --level: 1.5rem !important;
            font-size: 1.5rem !important;
          }
          .insapp-bn-scope [data-content-type="heading"][data-level="2"] {
            --level: 1.25rem !important;
            font-size: 1.25rem !important;
          }
          .insapp-bn-scope [data-content-type="heading"][data-level="3"] {
            --level: 1.1rem !important;
            font-size: 1.1rem !important;
          }
          .insapp-bn-scope .bn-block-content[data-content-type="heading"][data-level="1"] {
            font-size: 1.5rem !important;
          }
          .insapp-bn-scope .bn-block-content[data-content-type="heading"][data-level="2"] {
            font-size: 1.25rem !important;
          }
          .insapp-bn-scope h1, .insapp-bn-scope h2, .insapp-bn-scope h3 {
            font-size: inherit !important;
          }
        `}} />
        <div className="w-full insapp-bn-scope">
          <BlockNoteView
            editor={editor}
            editable={true}
            onChange={() => {
              if (isContentLoaded.current) {
                handleEditorChange(editor.document);
              }
            }}
            theme="light"
          />
        </div>
      </div>
    );
  }

  return null;
});

BlockNoteSummaryView.displayName = 'BlockNoteSummaryView';

-- Тип встречи: 'internal' (внутренняя) | 'external' (внешняя).
-- Старые встречи получают 'internal' по умолчанию.
ALTER TABLE meetings ADD COLUMN meeting_type TEXT NOT NULL DEFAULT 'internal';

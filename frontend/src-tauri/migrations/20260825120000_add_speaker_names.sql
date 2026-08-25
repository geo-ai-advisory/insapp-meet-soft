-- Пользовательские имена участников встречи.
-- Приложение подписывает реплики «Вы» / «Собеседник 1» / «Собеседник 2»,
-- а здесь хранится, как пользователь переименовал их вручную
-- (например «Собеседник 1» -> «Иван Петров»).
--
-- speaker_key - техническая метка источника речи: 'mic' | 'system' | 'system_1' | 'system_2' ...
CREATE TABLE IF NOT EXISTS speaker_names (
    meeting_id   TEXT NOT NULL,
    speaker_key  TEXT NOT NULL,
    display_name TEXT NOT NULL,
    PRIMARY KEY (meeting_id, speaker_key)
);

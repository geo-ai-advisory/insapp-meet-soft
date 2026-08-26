-- Отметки об успешной отправке на сервер Insapp.
-- Нужны колонкам статуса в списке встреч: видно, есть ли расшифровка и резюме
-- и доехали ли они до сервера. Раньше это нигде не хранилось, и показать
-- статус было нечем.
ALTER TABLE meetings ADD COLUMN transcript_synced_at TEXT;
ALTER TABLE meetings ADD COLUMN summary_synced_at TEXT;

-- Голоса собеседников встречи: «центр голоса» (среднее отпечатков CAM++) каждой метки
-- собеседника + сколько секунд он говорил. Вместе с speaker_names (имя метки) даёт
-- «голоса коллег»: имя, данное человеку в одной встрече, узнаётся в следующих.
-- Хранится только на этом компьютере (голос для узнавания человека - биометрия).
CREATE TABLE IF NOT EXISTS meeting_voices (
    meeting_id  TEXT NOT NULL,
    speaker_key TEXT NOT NULL,
    centroid    BLOB NOT NULL,
    seconds     REAL NOT NULL,
    PRIMARY KEY (meeting_id, speaker_key)
);

# Вопросы к Geo после автопилотной сессии

Файл создан 2026-05-27 в конце автопилотной работы над Insapp-meet. Geo, прочитай это когда вернёшься.

## Что точно нужно проверить руками

### 1. Авто-попап микрофона - точность срабатывания

Сейчас попап «Похоже у тебя встреча в Telemost. Записать?» появляется когда фоновый watcher замечает что **активное окно** = Telemost/Zoom/Meet/FaceTime/Teams/Chrome/Safari/Telegram/WhatsApp/Discord/Skype/Arc.

Это **упрощённый MVP** через polling каждые 3 секунды. Минусы:
- Промазывает если встреча в фоновом окне (например ты переключился в Slack во время Zoom-звонка) - попап не появится
- Может ложно сработать если ты открыл Chrome просто почитать новости

Точная версия требовала бы Swift bridge к CoreAudio (kAudioDevicePropertyDeviceIsRunningSomewhere) - это +1-2 часа работы. Сделать?

**Вариант B:** скрипт-watcher вокруг `lsof` который смотрит какие процессы держат `/dev/audio` - тоже точно, проще Swift, но требует sudo для надёжности.

### 2. Локализация - переведено критичное, остаток ~30 файлов

Перевёл:
- Sidebar полностью (меню, кнопки, диалоги, поиск)
- Главная (тосты восстановления)
- Recording controls (тултипы, ошибки, статусы)
- TranscriptPanel
- PermissionWarning
- StatusOverlays
- Settings tabs
- PreferenceSettings (General)
- VirtualizedTranscriptView (Welcome to meetily → Добро пожаловать в Insapp-meet)
- EmptyStateSummary
- ConfirmationModal
- About
- Logo, WelcomeStep онбординга

**Дополнительно после первой автопилотной итерации перевёл:**
- RecordingSettings (заголовок, тосты устройств, формат файла, уведомления)
- BetaSettings (Beta Features, описание импорта аудио)
- TranscriptSettings (Select provider/model, API Key, lock/unlock)
- UpdateDialog (Current/New Version, Release Date)
- LanguageSelection (тосты сохранения)
- AnalyticsConsentSwitch (Usage Analytics, Your User ID, Copy)
- DeviceSelection (Audio Devices, Microphone, System Audio, тосты «не найдено»)
- ImportDropOverlay (Drop audio file...)
- SetupOverviewStep онбординга (упрощённый, без Summary Engine)
- PermissionsStep онбординга (Grant Permissions → Выдай разрешения, Finish Setup)
- DownloadProgressStep онбординга (Summary Engine блок скрыт, остальное на русском)
- SummaryPanel «Generating AI Summary...» → «Делаю AI-резюме...»
- MeetingDetails/TranscriptPanel placeholder для контекста AI

Остаются (увижу при полном клик-туре):
- BlockNote редактор саммари (от @blocknote/react - локализуется через react-intl, отдельная задача)
- ImportAudioDialog (Meeting Title, Advanced Options - см. строки 293/335/354)
- ModelSettingsModal.tsx (старый UI выбора моделей, теперь не основной)
- Whisper/Parakeet ModelManager (внутренний UI скачивания моделей)
- Тосты ошибок Tauri-плагинов (низкоуровневые)

Если что-то увидишь по-английски в UI - присылай скрин, я допилю.

### 3. Сервер Insapp - стартует автоматически?

Сейчас в коде хардкод `http://localhost:8080` и `auto_upload=true` по дефолту. Это значит при первой встрече попытается отправить, увидит что сервер не запущен и положит в очередь.

**Тебе нужно:** убедиться что сервер из `Projects/transcribe-app/server/` запущен через `docker compose up -d` перед тестом интеграции. Иначе встречи будут копиться в очереди и ничего не покажет в `localhost:8080/admin`.

### 4. AI-резюме - CLI установлены?

Терминал-саммаризатор по дефолту ищет команду `claude` в PATH. Если у тебя установлен Claude Code как `~/.claude/local/claude` или `~/.codex/bin/codex` - надо проверить и в Настройках → AI-резюме указать полный путь, либо убедиться что эти команды есть в PATH.

В Настройках есть индикатор «Команда найдена/не найдена» - проверь после первой сборки.

### 5. Тест на реальной встрече

Я не запускаю Telemost/Zoom потому что я в фоне без UI-доступа. Когда вернёшься:
1. Запусти `/Applications/Insapp-meet.app`
2. Открой Telemost - должен появиться попап в правом верхнем углу через 3-6 секунд
3. Нажми «Да, записать»
4. Поговори 30-60 секунд
5. Нажми Стоп
6. Подожди 30 сек (Whisper обрабатывает)
7. Проверь что встреча появилась в Sidebar и на сервере (`http://localhost:8080/admin`)
8. Открой карточку встречи, нажми «Сделать AI-резюме» - должна открыться боковая панель с терминалом и запуститься claude/codex
9. Когда AI закончил - нажми «Сохранить как резюме»

## Технические особенности (на случай если что-то сломается)

### Билд

Подпись и установка делается так:
```
cd ~/dev/insapp-meet
./scripts/sign-and-install.sh
```

Скрипт сам найдёт собранный .app, подпишет (БЕЗ --deep), установит в /Applications, снимет карантин.

### Запустить вручную после правок

```
cd ~/dev/insapp-meet/frontend
pnpm tauri build           # билд (~10-15 мин)
cd ..
./scripts/sign-and-install.sh   # подпись + установка
open -a Insapp-meet
```

### Если первый запуск ломается на permissions

Bundle ID поменялся с `com.meetily.ai` на `tech.insap.meet`. macOS видит это как новое приложение, попросит разрешения заново на:
- Микрофон
- Запись экрана (для системного звука встречи)
- Accessibility (для глобальных хоткеев, если они используются)

Это нормально и однократно.

### Что было выпилено

- Встроенный саммаризатор Meetily (Ollama/llama-helper) - убран полностью
- Команды `api_process_transcript`, `api_get_summary`, `api_save_meeting_summary`, шаблоны summary и Built-in AI - убраны из invoke_handler
- `binaries/llama-helper` зависимость из tauri.conf.json
- Updater на Zackriya GitHub releases - убран

При первом запуске **никакие модели Ollama не качаются**.

### Что добавлено

- Новый модуль `insapp_server` (Rust): отправка транскриптов с очередью и retry
- Новый модуль `mic_watcher` (Rust): фоновый watcher для auto-popup
- Новый модуль `pty_terminal` (Rust): встроенный pty для AI CLI
- Tauri-команды: `insapp_*`, `mic_watcher_*`, `pty_*`, `ai_summary_*`
- Компоненты: InsappServerSettings, AiSummarySettings, MeetingAppToast, TerminalPanel, AiTerminalLauncher
- Новые табы в Settings: «AI-резюме», «Сервер Insapp»
- Кнопка «Сделать AI-резюме» в карточке встречи (поверх старой)

## Что я НЕ сделал (для будущих итераций)

1. Не делал реальный CoreAudio listener (kAudioDevicePropertyDeviceIsRunningSomewhere) - попап на polling frontmost app
2. Не переводил BlockNote-редактор - его i18n отдельная задача
3. Не вычистил мёртвый код модулей Ollama/Anthropic/Groq/OpenAI/OpenRouter - они остались в src/, но не используются (можно потом удалить)
4. Не обновил entitlements.plist под новый bundle id `tech.insap.meet` если нужно что-то специфичное - сейчас они оригинальные Meetily
5. Не делал автоматический фолловап-цикл в watcher: если ты ответил «игнорировать» для Telemost - cooldown 5 минут. После того как ты выйдешь из Telemost и вернёшься через 10 минут - попап покажется опять. Это норма, но если будет надоедать, можно увеличить cooldown до часа.

## Если будут проблемы со сборкой

Логи билда в фоновом процессе. Когда я буду запускать снова, посмотрю результат и доделаю что не получилось.

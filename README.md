# Insapp-meet

Десктоп-приложение для macOS: запись встреч, локальная транскрипция (Whisper/Parakeet на GPU Apple Silicon) и AI-резюме через встроенный терминал (Claude Code / Codex). Готовое резюме и транскрипт уходят на корпоративный сервер Insapp.

Форк [Meetily](https://github.com/Zackriya-Solutions/meetily), локализован на русский, перебрендирован под Insapp, со своей серверной интеграцией.

> Серверная часть (куда отправляются транскрипты) — в отдельном репозитории: **insapp-meet-dashboard**.

---

## Что умеет

- **Запись встречи** — микрофон + системный звук (ScreenCaptureKit), без виртуальных аудио-устройств
- **Локальная транскрипция** — Whisper.cpp / Parakeet на Metal GPU, ничего не уходит в облако на этапе расшифровки
- **AI-резюме** — встроенный терминал запускает Claude Code (или Codex), AI читает транскрипт и пишет структурированное резюме. Можно тут же попросить правки в чате
- **Авто-попап «Записать встречу?»** — когда активируется микрофон в Telegram/Zoom/Meet и т.п.
- **Отправка на сервер** — транскрипт и резюме автоматически уходят на корпоративный сервер, видно кто что загрузил
- **Само-регистрация** — при первом запуске сотрудник вводит ФИО, приложение само получает персональный ключ доступа

---

## Требования

- macOS 13+ (Ventura или новее) на Apple Silicon (M1/M2/M3/M4)
- [Node.js](https://nodejs.org/) 18+ и [pnpm](https://pnpm.io/) (`npm i -g pnpm`)
- [Rust](https://rustup.rs/) (stable)
- [Claude Code CLI](https://claude.com/claude-code) (`claude`) или Codex — для функции AI-резюме
- Xcode Command Line Tools (`xcode-select --install`)

---

## Установка из исходников

```bash
git clone https://git.insapp.pro/Geo/insapp-meet-soft.git
cd insapp-meet-soft/frontend

# Зависимости
pnpm install

# Продакшен-сборка .app (10-20 минут первый раз, дальше быстрее)
pnpm tauri build
```

Готовое приложение: `frontend/src-tauri/target/release/bundle/macos/Insapp-meet.app`

### Подпись и установка

```bash
cd ..                              # в корень репозитория
./scripts/sign-and-install.sh      # подпишет, установит в /Applications, снимет карантин
open -a Insapp-meet
```

Скрипт подписывает Apple Development-сертификатом (без `--deep`, по порядку: внутренние бинари → бандл). Если сертификат другой — поправь его ID в `scripts/sign-and-install.sh`.

### Запуск в dev-режиме (hot reload)

```bash
cd frontend
pnpm tauri dev
```

---

## Первый запуск

1. macOS попросит разрешения: **Микрофон**, **Запись экрана** (для системного звука), **Accessibility** (для хоткеев). Дать все три — это один раз.
2. Откроется экран **«Давай познакомимся»** — введи Имя и Фамилию. Приложение само зарегистрируется на сервере и получит персональный ключ. Под этим именем будут подписаны твои встречи в общих отчётах.
3. Можно начинать запись.

> Адрес сервера по умолчанию — `http://localhost:8080`. Поменять: **Настройки → Сервер Insapp**.

---

## Настройка AI-резюме

**Настройки → AI-резюме:**
- Выбери инструмент: Claude Code / Codex / своя команда
- Приложение проверит, что команда (`claude` / `codex`) доступна в системе
- Если CLI установлен нестандартно — укажи полный путь

При нажатии «Сделать AI-резюме» открывается терминал, AI читает транскрипт встречи и пишет резюме. Можно в том же окне попросить правки («сократи», «добавь раздел»). По кнопке «Сохранить как резюме» финальная версия записывается в файл и уходит на сервер.

---

## Структура проекта

```
frontend/
├── src/                      # Next.js + React UI
│   ├── app/                  # страницы (layout, главная, детали встречи, настройки)
│   ├── components/           # UI-компоненты (Sidebar, TerminalPanel, IdentityGate, ...)
│   └── contexts/             # React-контексты (онбординг, запись, ...)
├── src-tauri/                # Rust backend (Tauri 2)
│   └── src/
│       ├── audio/            # захват и микширование аудио, VAD
│       ├── whisper_engine/   # транскрипция Whisper.cpp
│       ├── parakeet_engine/  # транскрипция Parakeet
│       ├── insapp_server*.rs # интеграция с корпоративным сервером
│       ├── pty_terminal*.rs  # встроенный терминал для AI-резюме
│       └── mic_watcher*.rs   # авто-попап «Записать встречу?»
scripts/
└── sign-and-install.sh       # подпись и установка .app
```

---

## Технологии

- **Desktop:** Tauri 2 (Rust) + Next.js 14 + React 18 + Tailwind
- **Аудио:** cpal, ScreenCaptureKit, whisper-rs
- **Транскрипция:** Whisper.cpp / Parakeet (Metal GPU)
- **AI-резюме:** внешний CLI (Claude Code / Codex) через встроенный pty-терминал
- **Редактор резюме:** BlockNote

---

## Полезные команды

```bash
# Dev с подробными логами Rust
RUST_LOG=debug pnpm tauri dev

# Только Next.js dev-сервер (без Tauri)
pnpm run dev

# Пересборка после правок
cd frontend && pnpm tauri build && cd .. && ./scripts/sign-and-install.sh
```

---

## Лицензия

Внутренний инструмент Insapp. Основан на Meetily (см. `LICENSE.md`).

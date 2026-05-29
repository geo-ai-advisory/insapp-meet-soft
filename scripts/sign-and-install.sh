#!/usr/bin/env bash
# Подписать собранный Insapp-meet.app и установить в /Applications.
#
# ВАЖНО: НЕ использовать --deep флаг! Он переписывает подпись внутренних
# бинарей (ffmpeg) и ломает программу. Подписываем поэтапно:
#   1. Внутренние бинари по отдельности
#   2. Сам бандл с entitlements
#
# Использование:
#   ./scripts/sign-and-install.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILT="$REPO_ROOT/target/release/bundle/macos/Insapp-meet.app"
APP_FALLBACK="$REPO_ROOT/frontend/src-tauri/target/release/bundle/macos/Insapp-meet.app"
APP_INSTALLED="/Applications/Insapp-meet.app"

CERT="Apple Development: georgym@live.ru (XUZB4K9GZR)"
ENT="$REPO_ROOT/frontend/src-tauri/entitlements.plist"

# Найти собранный .app
APP=""
if [[ -d "$APP_BUILT" ]]; then
    APP="$APP_BUILT"
elif [[ -d "$APP_FALLBACK" ]]; then
    APP="$APP_FALLBACK"
else
    echo "✗ Не найден .app в:"
    echo "    $APP_BUILT"
    echo "    $APP_FALLBACK"
    echo "Сначала собери: pnpm tauri build"
    exit 1
fi

echo "▶ Найден .app: $APP"
echo "▶ Сертификат: $CERT"
echo "▶ Entitlements: $ENT"

# 1. Подписать внутренние бинари (без --deep, по одному)
echo ""
echo "▶ Подписываю внутренние бинари..."
for f in "$APP/Contents/MacOS"/*; do
    if [[ -f "$f" && -x "$f" ]]; then
        echo "  - $(basename "$f")"
        codesign --force --options runtime --sign "$CERT" --timestamp=none "$f" || true
    fi
done

# Helpers в Resources/sidecar
if [[ -d "$APP/Contents/Resources" ]]; then
    while IFS= read -r f; do
        if [[ -f "$f" && -x "$f" ]]; then
            echo "  - resource: $(basename "$f")"
            codesign --force --options runtime --sign "$CERT" --timestamp=none "$f" || true
        fi
    done < <(find "$APP/Contents/Resources" -type f -perm +111 2>/dev/null)
fi

# 2. Подписать сам бандл с entitlements (БЕЗ --deep)
echo ""
echo "▶ Подписываю бандл..."
codesign --force --options runtime --entitlements "$ENT" --sign "$CERT" --timestamp=none "$APP"

# 3. Проверка подписи
echo ""
echo "▶ Проверка подписи..."
codesign --verify --strict --verbose=2 "$APP"

# 4. Установка
echo ""
echo "▶ Устанавливаю в /Applications..."
if [[ -d "$APP_INSTALLED" ]]; then
    rm -rf "$APP_INSTALLED"
fi
cp -R "$APP" "$APP_INSTALLED"

# 5. Снять карантин (рекурсивно через find, флага -r у xattr нет)
echo "▶ Снимаю карантин..."
find "$APP_INSTALLED" -exec xattr -c {} \; 2>/dev/null || true

echo ""
echo "✓ Готово. Запусти: open -a Insapp-meet"

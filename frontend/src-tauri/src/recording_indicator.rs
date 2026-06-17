// Плавающий индикатор записи («пилюля») - компактное окно поверх всех приложений,
// видимое ПОКА идёт запись. Пользователь не забудет, что запись активна, и может
// поставить на паузу / остановить из любого приложения.
//
// ИСПРАВЛЕНИЕ БАГА (было: пилюля висела на фронтовых событиях, не синхронилась,
// СТОП не доводил остановку):
//   1. Окно создаётся/закрывается из Rust В МОМЕНТ реального старта/стопа записи
//      (recording_indicator::show вызывается из start_recording*, hide - из stop_recording).
//      Привязка к реальному состоянию, а не к косвенным фронт-событиям.
//   2. СТОП и ПАУЗА в пилюле НЕ дёргают низкоуровневые команды напрямую, а шлют событие
//      в ГЛАВНОЕ окно -> там отрабатывает ТОТ ЖЕ путь остановки/паузы, что и основной UI
//      (единый источник истины: сохранение встречи, переход на экран встречи).
//   3. Окно непрозрачное (transparent=true в этом приложении рендерится пустым).

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tracing::{info, warn};

const PILL_LABEL: &str = "recording-indicator";
const PILL_WIDTH: f64 = 66.0;
const PILL_HEIGHT: f64 = 210.0;
const MARGIN_RIGHT: f64 = 18.0;

/// Показать пилюлю (вызывается при РЕАЛЬНОМ старте записи).
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    // Уже открыта - ничего не делаем (идемпотентно).
    if app.get_webview_window(PILL_LABEL).is_some() {
        info!("[recording_indicator] окно уже открыто");
        return;
    }

    // Позиция: правый край, по вертикали ~центр (на любом дисплее - через размер монитора).
    let (screen_w, screen_h) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let sf = monitor.scale_factor();
            let size = monitor.size();
            (size.width as f64 / sf, size.height as f64 / sf)
        }
        _ => (1440.0, 900.0),
    };
    let x = screen_w - PILL_WIDTH - MARGIN_RIGHT;
    let y = (screen_h - PILL_HEIGHT) / 2.0;

    let builder = WebviewWindowBuilder::new(
        app,
        PILL_LABEL,
        WebviewUrl::App("recording-indicator".into()),
    )
    .title("Insapp-meet - запись")
    .inner_size(PILL_WIDTH, PILL_HEIGHT)
    .min_inner_size(PILL_WIDTH, PILL_HEIGHT)
    .max_inner_size(PILL_WIDTH, PILL_HEIGHT)
    .position(x, y)
    .always_on_top(true)
    .decorations(false)
    .resizable(false)
    // Прозрачное окно (macOSPrivateApi=true в конфиге) - чтобы скруглённая пилюля
    // ПАРИЛА без чёрного квадрата по углам. Прошлая «пустота» была из-за обёртки
    // в общий layout с sidebar (уже исправлено в layout.tsx isPopupRoute), а НЕ из-за
    // прозрачности. Фон страницы пилюли тоже прозрачный (recording-indicator/page.tsx).
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    // НЕ воруем фокус во время записи - пользователь продолжает работать в своём приложении.
    .focused(false)
    .visible(true);

    match builder.build() {
        Ok(_) => info!("[recording_indicator] пилюля создана"),
        Err(e) => warn!("[recording_indicator] не удалось создать пилюлю: {}", e),
    }
}

/// Скрыть пилюлю (вызывается при стопе записи).
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window(PILL_LABEL) {
        let _ = win.close();
        info!("[recording_indicator] пилюля закрыта");
    }
}

// ============================================================
// Команды, вызываемые из webview пилюли
// ============================================================

/// СТОП из пилюли. Не останавливаем напрямую, а шлём событие в главное окно -
/// там отработает полный путь остановки (тот же, что у основной кнопки «Стоп»):
/// финализация, сохранение встречи, переход на экран встречи.
#[tauri::command]
pub async fn recording_indicator_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("[recording_indicator] СТОП из пилюли -> событие в main");
    if let Some(main) = app.get_webview_window("main") {
        // НЕ вытаскиваем окно на передний план: раньше unminimize/show/set_focus
        // давали симптом «стоп с пилюли открывает приложение, и оно несколько секунд висит».
        // Webview главного окна жив всю запись -> слушатель 'stop-recording-from-pill'
        // отработает и без показа окна. Пользователь остаётся в своём приложении.
        let _ = main.emit("stop-recording-from-pill", ());
    } else {
        warn!("[recording_indicator] главное окно 'main' не найдено");
    }
    Ok(())
}

/// ПАУЗА/возобновление из пилюли. Шлём событие в главное окно - там тот же
/// обработчик паузы, что и в основном UI (единый источник истины).
#[tauri::command]
pub async fn recording_indicator_toggle_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("[recording_indicator] ПАУЗА/возобновление из пилюли -> событие в main");
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("toggle-pause-from-pill", ());
    }
    Ok(())
}

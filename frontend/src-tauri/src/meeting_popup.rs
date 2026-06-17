// Всплывающее окно «Записать встречу?»
//
// Когда mic_watcher детектит Telemost/Zoom/...:
// 1. Открываем второе Tauri webview window (URL /meeting-popup), 380x160px,
//    в правом верхнем углу, always_on_top, decorations=false
// 2. JS встроенный получает payload через event meeting-popup-data
// 3. Пользователь жмёт «Да, записать» или «Игнорировать»
// 4. JS дёргает meeting_popup_record / meeting_popup_dismiss
//
// Это решение не зависит от macOS Notification Center registration
// (которая требует Notarized Developer ID), работает с любой подписью.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tracing::{info, warn};

const POPUP_LABEL: &str = "meeting-popup";
// Карточка 360x96, плюс прозрачный гаттер SHADOW_GUTTER по периметру — чтобы мягкая
// тень парящей карточки не обрезалась краем окна (окно прозрачное).
const CARD_WIDTH: f64 = 360.0;
// Высота 96px — компактный layout: одна строка с иконкой/заголовком/крестиком,
// плюс одна строка кнопок «Записать»/«Игнорировать». Без пустого пространства.
const CARD_HEIGHT: f64 = 96.0;
const SHADOW_GUTTER: f64 = 12.0;
const POPUP_WIDTH: f64 = CARD_WIDTH + SHADOW_GUTTER * 2.0;
const POPUP_HEIGHT: f64 = CARD_HEIGHT + SHADOW_GUTTER * 2.0;
const MARGIN_RIGHT: f64 = 16.0 - SHADOW_GUTTER;
const MARGIN_TOP: f64 = 16.0 - SHADOW_GUTTER;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopupData {
    pub app_name: String,
    pub bundle_id: String,
}

/// Глобальное хранилище последнего payload (чтобы окно при mount могло его получить).
pub struct PopupState {
    pub last_payload: Mutex<Option<PopupData>>,
}

impl PopupState {
    pub fn new() -> Self {
        Self {
            last_payload: Mutex::new(None),
        }
    }
}

/// Открыть всплывающее окно (или передать данные в существующее).
pub fn show<R: Runtime>(app: &AppHandle<R>, app_name: &str, bundle_id: &str) {
    let payload = PopupData {
        app_name: app_name.to_string(),
        bundle_id: bundle_id.to_string(),
    };

    if let Some(state) = app.try_state::<PopupState>() {
        if let Ok(mut guard) = state.last_payload.lock() {
            *guard = Some(payload.clone());
        }
    }

    // Если окно уже открыто - просто переотправляем event
    if let Some(existing) = app.get_webview_window(POPUP_LABEL) {
        info!("[meeting_popup] окно уже открыто, обновляю payload");
        let _ = existing.emit("meeting-popup-data", &payload);
        let _ = existing.set_focus();
        return;
    }

    // Получаем размер primary monitor чтобы рассчитать позицию правого верхнего угла
    // (на разных дисплеях абсолютные координаты не работают).
    let (screen_w, _screen_h) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let sf = monitor.scale_factor();
            let size = monitor.size();
            (size.width as f64 / sf, size.height as f64 / sf)
        }
        _ => (1440.0, 900.0), // fallback для MacBook 14"
    };

    let x = screen_w - POPUP_WIDTH - MARGIN_RIGHT;
    let y = MARGIN_TOP;

    let builder = WebviewWindowBuilder::new(
        app,
        POPUP_LABEL,
        WebviewUrl::App("meeting-popup".into()),
    )
    .title("Insapp-meet")
    .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
    .min_inner_size(POPUP_WIDTH, POPUP_HEIGHT)
    .max_inner_size(POPUP_WIDTH, POPUP_HEIGHT)
    .position(x, y)
    .always_on_top(true)
    .decorations(false)
    .resizable(false)
    // Прозрачное окно (macOSPrivateApi=true в конфиге) — чтобы скруглённая карточка
    // ПАРИЛА без квадратной подложки по углам. Прошлая «пустота»/«видно Telegram»
    // была из-за прозрачного ФОНА страницы (карточка не имела своей заливки), а НЕ из-за
    // прозрачности окна. Теперь сама карточка во фронте имеет сплошной светлый фон (--card)
    // и тень, а углы окна за её border-radius — прозрачные.
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .focused(true)
    .visible(true);

    match builder.build() {
        Ok(win) => {
            info!("[meeting_popup] окно создано для {} ({})", app_name, bundle_id);
            // Подождём 300ms и пошлём payload (чтобы JS успел подписаться на event)
            let win_clone = win.clone();
            let payload_clone = payload.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let _ = win_clone.emit("meeting-popup-data", &payload_clone);
            });
        }
        Err(e) => {
            warn!("[meeting_popup] не удалось создать окно: {}", e);
        }
    }
}

// ============================================================
// Tauri commands вызываемые из meeting-popup webview
// ============================================================

#[tauri::command]
pub async fn meeting_popup_request_data<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<PopupData>, String> {
    let state = app
        .try_state::<PopupState>()
        .ok_or_else(|| "PopupState не подключён".to_string())?;
    let payload = state.last_payload.lock().map(|g| g.clone()).unwrap_or(None);
    Ok(payload)
}

#[tauri::command]
pub async fn meeting_popup_record<R: Runtime>(
    app: AppHandle<R>,
    bundle_id: String,
) -> Result<(), String> {
    info!("[meeting_popup] пользователь нажал «Записать» (bundle={})", bundle_id);
    // Открыть главное окно. Подразумеваем что оно может быть minimized или hidden -
    // делаем полный цикл подъёма: unminimize → show → set_focus.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();

        // Сигнал на старт записи. На стороне фронта (layout.tsx) сделан retry × 3,
        // т.к. useRecordingStart listener иногда не успевает подписаться вовремя.
        let _ = main.emit("start-recording-from-popup", &bundle_id);
        info!("[meeting_popup] событие start-recording-from-popup отправлено в main window");
    } else {
        warn!("[meeting_popup] главное окно 'main' не найдено - запись не стартует");
    }
    Ok(())
}

#[tauri::command]
pub async fn meeting_popup_dismiss<R: Runtime>(
    app: AppHandle<R>,
    bundle_id: String,
    name: Option<String>,
) -> Result<(), String> {
    let nm = name.unwrap_or_default();
    info!("[meeting_popup] «Игнорировать» (bundle={}, name={}) - добавляю в игнор навсегда", bundle_id, nm);

    // ПОСТОЯННЫЙ игнор: приложение больше не будет вызывать окно (переживает перезапуск).
    if let Some(st) = app.try_state::<std::sync::Arc<crate::mic_watcher::MicWatcherState>>() {
        st.add_to_blacklist(&bundle_id, &nm);
        st.mark_ignored(&bundle_id);
    }

    // Тост в главном окне: «<App> добавлено в игнорируемые».
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit(
            "mic-app-ignored",
            &serde_json::json!({ "name": nm, "bundle_id": bundle_id }),
        );
    }
    Ok(())
}

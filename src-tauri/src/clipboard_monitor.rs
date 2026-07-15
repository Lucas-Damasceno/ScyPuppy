use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use tauri::AppHandle;

use super::{
    collect_active_window, open_conn, persist_clipboard_payload, read_clipboard_payload, AppState,
    CaptureOrigin, ClipboardPayload, INBOX_CONTEXT_ID,
};

pub struct ClipboardMonitorHandle {
    stop: Arc<AtomicBool>,
    window: Arc<AtomicIsize>,
}

impl ClipboardMonitorHandle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            stop: Arc::new(AtomicBool::new(false)),
            window: Arc::new(AtomicIsize::new(0)),
        })
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::{
                Foundation::{HWND, LPARAM, WPARAM},
                UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE},
            };
            let raw = self.window.load(Ordering::Acquire);
            if raw != 0 {
                unsafe {
                    let _ = PostMessageW(
                        Some(HWND(raw as *mut std::ffi::c_void)),
                        WM_CLOSE,
                        WPARAM(0),
                        LPARAM(0),
                    );
                }
            }
        }
    }
}

pub fn start(app: AppHandle, state: AppState, handle: Arc<ClipboardMonitorHandle>) {
    #[cfg(target_os = "windows")]
    {
        let (sender, receiver) = mpsc::channel::<MonitorEvent>();
        let worker_app = app.clone();
        let worker_state = state.clone();
        let worker_stop = handle.stop.clone();
        thread::Builder::new()
            .name("scryppy-clipboard-worker".into())
            .spawn(move || worker_loop(worker_app, worker_state, receiver, worker_stop))
            .expect("clipboard worker thread should start");

        let monitor_stop = handle.stop.clone();
        let monitor_window = handle.window.clone();
        thread::Builder::new()
            .name("scryppy-clipboard-monitor".into())
            .spawn(move || monitor_loop(state, sender, monitor_stop, monitor_window))
            .expect("clipboard monitor thread should start");
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, handle);
    }
}

#[derive(Debug)]
struct MonitorEvent {
    sequence: u32,
    payload: ClipboardPayload,
    active_window: super::ActiveWindowMetadata,
}

fn worker_loop(
    app: AppHandle,
    state: AppState,
    receiver: mpsc::Receiver<MonitorEvent>,
    stop: Arc<AtomicBool>,
) {
    let mut processed_sequences = VecDeque::new();
    let mut last_diagnostic = Instant::now() - Duration::from_secs(10);

    while !stop.load(Ordering::Acquire) {
        let Ok(event) = receiver.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        if processed_sequences.contains(&event.sequence) {
            continue;
        }
        processed_sequences.push_back(event.sequence);
        while processed_sequences.len() > 64 {
            processed_sequences.pop_front();
        }

        let enabled = open_conn(&state)
            .and_then(|conn| super::settings_from_conn(&conn, &state))
            .map(|settings| settings.clipboard_monitor_enabled)
            .unwrap_or(false);
        if !enabled {
            continue;
        }

        if persist_clipboard_payload(
            &app,
            state.clone(),
            event.payload,
            event.active_window,
            CaptureOrigin::ClipboardMonitor,
            "capture",
            INBOX_CONTEXT_ID,
        )
        .is_err()
        {
            report_diagnostic(&mut last_diagnostic, "capture event ignored");
        }
    }
}

fn report_diagnostic(last: &mut Instant, reason: &str) {
    if last.elapsed() >= Duration::from_secs(5) {
        eprintln!("Clipboard monitor diagnostic: {reason}");
        *last = Instant::now();
    }
}

#[cfg(target_os = "windows")]
fn monitor_loop(
    state: AppState,
    sender: mpsc::Sender<MonitorEvent>,
    stop: Arc<AtomicBool>,
    window_slot: Arc<AtomicIsize>,
) {
    use windows::core::w;
    use windows::Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM},
        System::DataExchange::{
            AddClipboardFormatListener, GetClipboardSequenceNumber, RemoveClipboardFormatListener,
        },
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
            RegisterClassW, TranslateMessage, CS_HREDRAW, CS_VREDRAW, HWND_MESSAGE, MSG,
            WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLIPBOARDUPDATE, WM_CLOSE, WM_DESTROY, WNDCLASSW,
        },
    };

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                windows::Win32::UI::WindowsAndMessaging::PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    let class_name = w!("ScryppyClipboardMonitor");
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW,
        lpfnWndProc: Some(window_proc),
        hInstance: HINSTANCE::default(),
        lpszClassName: class_name,
        ..Default::default()
    };
    unsafe {
        let _ = RegisterClassW(&class);
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            class_name,
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(HINSTANCE::default()),
            None,
        ) else {
            return;
        };
        window_slot.store(hwnd.0 as isize, Ordering::Release);
        if AddClipboardFormatListener(hwnd).is_err() {
            let _ = DestroyWindow(hwnd);
            window_slot.store(0, Ordering::Release);
            return;
        }

        let mut last_sequence = GetClipboardSequenceNumber();
        let mut message = MSG::default();
        while !stop.load(Ordering::Acquire) {
            let result = GetMessageW(&mut message, None, 0, 0);
            if result.0 <= 0 {
                break;
            }
            if message.message == WM_CLIPBOARDUPDATE {
                let sequence = GetClipboardSequenceNumber();
                if sequence != 0 && sequence != last_sequence {
                    last_sequence = sequence;
                    if !state.consume_ignored_clipboard_sequence(sequence) {
                        let active_window = collect_active_window();
                        if let Ok(Some(payload)) = read_clipboard_payload() {
                            if matches!(&payload, ClipboardPayload::Text(text) if super::is_internal_clipboard_marker(text))
                            {
                                continue;
                            }
                            let _ = sender.send(MonitorEvent {
                                sequence,
                                payload,
                                active_window,
                            });
                        }
                    }
                }
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }

        let _ = RemoveClipboardFormatListener(hwnd);
        let _ = DestroyWindow(hwnd);
        window_slot.store(0, Ordering::Release);
    }
}

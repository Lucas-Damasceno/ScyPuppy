use std::{sync::mpsc, thread, time::Duration};

use super::model::ClipboardSnapshot;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

enum Request {
    Read(mpsc::SyncSender<Result<Option<ClipboardSnapshot>, String>>),
    Write(ClipboardSnapshot, mpsc::SyncSender<Result<(), String>>),
    Shutdown,
}

#[derive(Clone)]
pub struct ClipboardService {
    sender: mpsc::Sender<Request>,
}

impl ClipboardService {
    pub fn start() -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("scryppy-clipboard-sta".into())
            .spawn(move || service_loop(receiver, ready_sender))
            .map_err(|error| format!("Could not start the clipboard service: {error}"))?;
        ready_receiver
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "The clipboard service did not initialize in time.".to_string())??;
        Ok(Self { sender })
    }

    pub fn read(&self) -> Result<Option<ClipboardSnapshot>, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::Read(sender))
            .map_err(|_| "The clipboard service is unavailable.".to_string())?;
        receiver
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "The clipboard did not respond in time.".to_string())?
    }

    pub fn write(&self, snapshot: ClipboardSnapshot) -> Result<(), String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::Write(snapshot, sender))
            .map_err(|_| "The clipboard service is unavailable.".to_string())?;
        receiver
            .recv_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "The clipboard did not respond in time.".to_string())?
    }

    pub fn shutdown(&self) {
        let _ = self.sender.send(Request::Shutdown);
    }
}

fn service_loop(receiver: mpsc::Receiver<Request>, ready: mpsc::SyncSender<Result<(), String>>) {
    #[cfg(target_os = "windows")]
    let initialized = unsafe {
        windows::Win32::System::Ole::OleInitialize(None)
            .map(|_| ())
            .map_err(|error| format!("Could not initialize OLE for clipboard access: {error}"))
    };
    #[cfg(not(target_os = "windows"))]
    let initialized: Result<(), String> = Ok(());

    if let Err(error) = initialized {
        let _ = ready.send(Err(error));
        return;
    }
    let _ = ready.send(Ok(()));

    while let Ok(request) = receiver.recv() {
        match request {
            Request::Read(response) => {
                let _ = response.send(super::platform::read_snapshot());
            }
            Request::Write(snapshot, response) => {
                let _ = response.send(super::platform::write_snapshot(&snapshot));
            }
            Request::Shutdown => break,
        }
    }

    #[cfg(target_os = "windows")]
    unsafe {
        windows::Win32::System::Ole::OleUninitialize();
    }
}

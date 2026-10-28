use crate::error::{AppError, Result};
use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::PathBuf, sync::mpsc};
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{ERROR_CANCELLED, HWND},
    System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance,
        CoInitializeEx, CoTaskMemFree, CoUninitialize,
    },
    UI::Shell::{
        FDE_OVERWRITE_RESPONSE, FDE_SHAREVIOLATION_RESPONSE, FDEOR_DEFAULT, FDESVR_DEFAULT,
        FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PICKFOLDERS, FileOpenDialog, IFileDialog,
        IFileDialogEvents, IFileDialogEvents_Impl, IFileOpenDialog, IShellItem, SIGDN_FILESYSPATH,
    },
};
use windows::core::{Ref, implement};

#[implement(IFileDialogEvents)]
struct FolderEvents {
    reply: mpsc::Sender<Result<Option<PathBuf>>>,
}

#[allow(non_snake_case)]
impl IFileDialogEvents_Impl for FolderEvents_Impl {
    fn OnFileOk(&self, dialog: Ref<IFileDialog>) -> windows::core::Result<()> {
        unsafe {
            let dialog = dialog.ok()?;
            let item = dialog
                .GetResult()
                .or_else(|_| dialog.GetCurrentSelection())?;
            let path = item_path(&item)?;
            // Show itself can wait seconds after hiding; do not wait for it to return.
            let _ = self.reply.send(Ok(Some(path)));
        }
        Ok(())
    }
    fn OnFolderChanging(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnSelectionChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnShareViolation(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<FDE_SHAREVIOLATION_RESPONSE> {
        Ok(FDESVR_DEFAULT)
    }
    fn OnTypeChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnOverwrite(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<FDE_OVERWRITE_RESPONSE> {
        Ok(FDEOR_DEFAULT)
    }
}

unsafe fn item_path(item: &IShellItem) -> windows::core::Result<PathBuf> {
    unsafe {
        let name = item.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = PathBuf::from(OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0.cast()));
        Ok(path)
    }
}

pub fn pick(window: &WebviewWindow) -> Result<Option<PathBuf>> {
    let owner = window
        .hwnd()
        .map_err(|e| AppError::new("dialog", e.to_string()))?
        .0 as isize;
    let (reply, selected) = mpsc::channel();
    std::thread::Builder::new()
        .name("folder-picker".into())
        .spawn(move || unsafe {
            if let Err(error) =
                CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()
            {
                let _ = reply.send(Err(AppError::new("dialog", error.to_string())));
                return;
            }
            if let Err(error) = show(HWND(owner as *mut _), &reply) {
                let _ = reply.send(Err(AppError::new("dialog", error.to_string())));
            }
            CoUninitialize();
        })?;
    selected
        .recv()
        .map_err(|e| AppError::new("dialog", e.to_string()))?
}

unsafe fn show(
    owner: HWND,
    reply: &mpsc::Sender<Result<Option<PathBuf>>>,
) -> windows::core::Result<()> {
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR,
        )?;
        let events: IFileDialogEvents = FolderEvents {
            reply: reply.clone(),
        }
        .into();
        let cookie = dialog.Advise(&events)?;
        let result = dialog.Show(Some(owner));
        let _ = dialog.Unadvise(cookie);
        if let Err(error) = result {
            if error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
                let _ = reply.send(Ok(None));
                return Ok(());
            }
            return Err(error);
        }
        let path = item_path(&dialog.GetResult()?)?;
        let _ = reply.send(Ok(Some(path)));
        Ok(())
    }
}

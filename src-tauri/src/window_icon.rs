use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            GetSystemMetrics, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_SHARED, LoadImageW, SM_CXICON,
            SM_CXSMICON, SM_CYICON, SM_CYSMICON, SendMessageW, WM_SETICON,
        },
    },
    core::PCWSTR,
};

pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let hwnd = HWND(window.hwnd()?.0);
    // Load the native resource to bypass Tao's RGBA conversion, which generates an
    // invalid AND mask and produces stripes in Task Manager's window icons.
    // SAFETY: The HWND belongs to this live window, and the resource ID is embedded
    // by tauri-build. LR_SHARED keeps the icons alive until the module is unloaded;
    // these handles must not be destroyed, including those returned by WM_SETICON.
    let result = unsafe {
        (|| -> windows::core::Result<()> {
            let module = GetModuleHandleW(PCWSTR::null())?;
            let resource =
                PCWSTR(tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as _);
            for (kind, width, height) in [
                (ICON_SMALL, SM_CXSMICON, SM_CYSMICON),
                (ICON_BIG, SM_CXICON, SM_CYICON),
            ] {
                let icon = LoadImageW(
                    Some(module.into()),
                    resource,
                    IMAGE_ICON,
                    GetSystemMetrics(width).max(1),
                    GetSystemMetrics(height).max(1),
                    LR_SHARED,
                )?;
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(kind as usize)),
                    Some(LPARAM(icon.0 as isize)),
                );
            }
            Ok(())
        })()
    };
    result.map_err(|error| std::io::Error::other(error).into())
}

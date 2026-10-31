//! WebView2-specific window tweaks.

#[cfg(all(windows, not(debug_assertions)))]
pub(crate) fn disable_browser_accelerators(window: &tauri::WebviewWindow<tauri::Wry>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };
        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
    });
}

#[cfg(not(all(windows, not(debug_assertions))))]
pub(crate) fn disable_browser_accelerators(_window: &tauri::WebviewWindow<tauri::Wry>) {}

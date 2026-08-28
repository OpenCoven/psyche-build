use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{webview::PlatformWebview, AppHandle, Emitter, Manager, Webview};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSClickGestureRecognizer;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSObject, NSObjectProtocol};
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

#[cfg(target_os = "windows")]
use webview2_com::{take_pwstr, FocusChangedEventHandler, SourceChangedEventHandler};
#[cfg(target_os = "windows")]
use windows::core::{Interface, PWSTR};

#[cfg(target_os = "linux")]
use gtk::prelude::WidgetExt;
#[cfg(target_os = "linux")]
use webkit2gtk::{
    glib::{self, translate::ToGlibPtr},
    WebViewExt,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrowserFocusIdentity {
    pub(crate) generation: u64,
    pub(crate) navigation_token: String,
    pub(crate) document_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserFocusPayload {
    pub(crate) label: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) generation: u64,
    pub(crate) navigation_token: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserNativeFocusView {
    label: String,
    registration_id: u64,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserWindowsFocusRegistration {
    native_view: usize,
    registration_id: u64,
    got_focus_token: i64,
    source_changed_token: i64,
}

static BROWSER_LIVE_FOCUS_IDENTITIES: Lazy<Mutex<HashMap<String, BrowserFocusIdentity>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static BROWSER_NATIVE_FOCUS_VIEWS: Lazy<Mutex<HashMap<usize, BrowserNativeFocusView>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
#[cfg(target_os = "windows")]
static BROWSER_WINDOWS_FOCUS_REGISTRATIONS: Lazy<
    Mutex<HashMap<String, BrowserWindowsFocusRegistration>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_BROWSER_NATIVE_FOCUS_REGISTRATION: AtomicU64 = AtomicU64::new(1);
static BROWSER_NATIVE_FOCUS_APP: OnceCell<AppHandle> = OnceCell::new();
const BROWSER_FOCUS_TITLE_LIMIT: usize = 512;

fn bounded_browser_focus_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.chars().take(BROWSER_FOCUS_TITLE_LIMIT).collect()
}

pub(crate) fn browser_focus_identity(label: &str) -> Option<BrowserFocusIdentity> {
    BROWSER_LIVE_FOCUS_IDENTITIES.lock().get(label).cloned()
}

pub(crate) fn install_browser_focus_identity(label: String, identity: BrowserFocusIdentity) {
    BROWSER_LIVE_FOCUS_IDENTITIES.lock().insert(label, identity);
}

pub(crate) fn refresh_browser_focus_identity_document_url(
    label: &str,
    generation: u64,
    navigation_token: &str,
    document_url: &str,
) -> bool {
    if document_url.is_empty() {
        return false;
    }
    let mut identities = BROWSER_LIVE_FOCUS_IDENTITIES.lock();
    let Some(identity) = identities.get_mut(label) else {
        return false;
    };
    if identity.generation != generation || identity.navigation_token != navigation_token {
        return false;
    }
    identity.document_url = document_url.to_string();
    true
}

pub(crate) fn retire_matching_browser_focus_identity(label: &str, identity: &BrowserFocusIdentity) {
    let mut identities = BROWSER_LIVE_FOCUS_IDENTITIES.lock();
    if identities.get(label) == Some(identity) {
        identities.remove(label);
    }
}

pub(crate) fn retire_browser_focus_label(label: &str) {
    BROWSER_NATIVE_FOCUS_VIEWS
        .lock()
        .retain(|_, registration| registration.label != label);
    #[cfg(target_os = "windows")]
    {
        BROWSER_WINDOWS_FOCUS_REGISTRATIONS.lock().remove(label);
    }
    BROWSER_LIVE_FOCUS_IDENTITIES.lock().remove(label);
}

fn register_browser_native_focus_view(native_view: usize, label: String) -> Result<u64, String> {
    if native_view == 0 {
        return Err("native browser focus view is unavailable".to_string());
    }
    let registration_id = NEXT_BROWSER_NATIVE_FOCUS_REGISTRATION.fetch_add(1, Ordering::Relaxed);
    let mut views = BROWSER_NATIVE_FOCUS_VIEWS.lock();
    views.retain(|_, registration| registration.label != label);
    views.insert(
        native_view,
        BrowserNativeFocusView {
            label,
            registration_id,
        },
    );
    Ok(registration_id)
}

#[cfg(target_os = "windows")]
fn unregister_browser_native_focus_view(native_view: usize, registration_id: u64) {
    let mut views = BROWSER_NATIVE_FOCUS_VIEWS.lock();
    if views
        .get(&native_view)
        .is_some_and(|registration| registration.registration_id == registration_id)
    {
        views.remove(&native_view);
    }
}

fn resolve_browser_native_focus(
    native_view: usize,
    registration_id: u64,
    current_url: &str,
    current_title: &str,
) -> Option<BrowserFocusPayload> {
    if current_url.is_empty() {
        return None;
    }
    let registration = BROWSER_NATIVE_FOCUS_VIEWS
        .lock()
        .get(&native_view)
        .filter(|registration| registration.registration_id == registration_id)
        .cloned()?;
    let identity = browser_focus_identity(&registration.label)?;
    Some(BrowserFocusPayload {
        label: registration.label,
        url: current_url.to_string(),
        title: bounded_browser_focus_title(current_title),
        generation: identity.generation,
        navigation_token: identity.navigation_token,
    })
}

fn dispatch_browser_native_focus<E>(
    native_view: usize,
    registration_id: u64,
    current_url: &str,
    current_title: &str,
    dispatch: impl FnOnce(BrowserFocusPayload) -> Result<(), E>,
) -> bool {
    resolve_browser_native_focus(native_view, registration_id, current_url, current_title)
        .is_some_and(|payload| {
            let _ = refresh_browser_focus_identity_document_url(
                &payload.label,
                payload.generation,
                &payload.navigation_token,
                &payload.url,
            );
            dispatch(payload).is_ok()
        })
}

#[cfg(any(target_os = "windows", test))]
fn dispatch_browser_native_route<E>(
    native_view: usize,
    registration_id: u64,
    current_url: &str,
    current_title: &str,
    dispatch: impl FnOnce(BrowserFocusPayload) -> Result<(), E>,
) -> bool {
    dispatch_browser_native_focus(
        native_view,
        registration_id,
        current_url,
        current_title,
        dispatch,
    )
}

fn emit_browser_native_focus(
    native_view: usize,
    registration_id: u64,
    current_url: &str,
    current_title: &str,
) -> bool {
    let Some(app) = BROWSER_NATIVE_FOCUS_APP.get() else {
        return false;
    };
    dispatch_browser_native_focus(
        native_view,
        registration_id,
        current_url,
        current_title,
        |payload| app.emit_to("main", "browser:focus", payload),
    )
}

#[cfg(target_os = "windows")]
fn emit_browser_native_route(
    native_view: usize,
    registration_id: u64,
    current_url: &str,
    current_title: &str,
) -> bool {
    let Some(app) = BROWSER_NATIVE_FOCUS_APP.get() else {
        return false;
    };
    dispatch_browser_native_focus(
        native_view,
        registration_id,
        current_url,
        current_title,
        |payload| app.emit_to("main", "browser:route", payload),
    )
}

#[cfg(target_os = "windows")]
fn with_windows_browser_native_event(
    native_view: usize,
    registration_id: u64,
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> Option<(usize, u64, String, String)> {
    let mut source = PWSTR::null();
    if unsafe { webview.Source(&mut source) }.is_err() {
        return None;
    }
    let current_url = take_pwstr(source);
    let mut title = PWSTR::null();
    let current_title = if unsafe { webview.DocumentTitle(&mut title) }.is_ok() {
        take_pwstr(title)
    } else {
        String::new()
    };
    Some((native_view, registration_id, current_url, current_title))
}

#[cfg(target_os = "windows")]
fn emit_windows_browser_native_focus(
    native_view: usize,
    registration_id: u64,
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> bool {
    with_windows_browser_native_event(native_view, registration_id, webview).is_some_and(
        |(native_view, registration_id, current_url, current_title)| {
            emit_browser_native_focus(native_view, registration_id, &current_url, &current_title)
        },
    )
}

#[cfg(target_os = "windows")]
fn emit_windows_browser_native_route(
    native_view: usize,
    registration_id: u64,
    webview: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> bool {
    with_windows_browser_native_event(native_view, registration_id, webview).is_some_and(
        |(native_view, registration_id, current_url, current_title)| {
            emit_browser_native_route(native_view, registration_id, &current_url, &current_title)
        },
    )
}

pub(crate) async fn install_browser_native_focus_callback(
    webview: &Webview,
    label: &str,
) -> Result<(), String> {
    BROWSER_NATIVE_FOCUS_APP.get_or_init(|| webview.app_handle().clone());
    let label = label.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let result = install_platform_browser_focus_callback(platform_webview, label);
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "native browser focus callback setup was cancelled".to_string())?
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct BrowserFocusGestureTargetIvars {
    native_view: usize,
    registration_id: u64,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = BrowserFocusGestureTargetIvars]
    struct BrowserFocusGestureTarget;

    unsafe impl NSObjectProtocol for BrowserFocusGestureTarget {}

    impl BrowserFocusGestureTarget {
        #[unsafe(method(reportBrowserFocus:))]
        fn report_browser_focus(&self, _recognizer: &NSClickGestureRecognizer) {
            let native_view = self.ivars().native_view;
            let registration_id = self.ivars().registration_id;
            let current_url = unsafe { (&*(native_view as *const WKWebView)).URL() }
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string())
                .unwrap_or_default();
            let current_title = unsafe { (&*(native_view as *const WKWebView)).title() }
                .map(|title| title.to_string())
                .unwrap_or_default();
            emit_browser_native_focus(native_view, registration_id, &current_url, &current_title);
        }
    }
);

#[cfg(target_os = "macos")]
impl BrowserFocusGestureTarget {
    fn new(mtm: MainThreadMarker, native_view: usize, registration_id: u64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BrowserFocusGestureTargetIvars {
            native_view,
            registration_id,
        });
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(target_os = "macos")]
std::thread_local! {
    static BROWSER_MACOS_FOCUS_TARGETS:
        std::cell::RefCell<HashMap<usize, (
            Retained<BrowserFocusGestureTarget>,
            Retained<NSClickGestureRecognizer>,
        )>> = std::cell::RefCell::new(HashMap::new());
}

#[cfg(target_os = "macos")]
fn install_platform_browser_focus_callback(
    platform_webview: PlatformWebview,
    label: String,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or_else(|| {
        "WKWebView focus callback must be installed on the main thread".to_string()
    })?;
    let webview = unsafe { &*(platform_webview.inner().cast::<WKWebView>()) };
    let native_view = webview as *const WKWebView as usize;
    let registration_id = register_browser_native_focus_view(native_view, label)?;
    let target = BrowserFocusGestureTarget::new(mtm, native_view, registration_id);
    let recognizer = unsafe {
        NSClickGestureRecognizer::initWithTarget_action(
            NSClickGestureRecognizer::alloc(mtm),
            Some(&target),
            Some(sel!(reportBrowserFocus:)),
        )
    };
    recognizer.setDelaysPrimaryMouseButtonEvents(false);
    webview.addGestureRecognizer(&recognizer);
    BROWSER_MACOS_FOCUS_TARGETS.with(|targets| {
        if let Some((_old_target, old_recognizer)) = targets
            .borrow_mut()
            .insert(native_view, (target, recognizer))
        {
            webview.removeGestureRecognizer(&old_recognizer);
        }
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_platform_browser_focus_callback(
    platform_webview: PlatformWebview,
    label: String,
) -> Result<(), String> {
    let controller = platform_webview.controller();
    let native_webview = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
    let native_view = controller.as_raw() as usize;
    let registration_id = register_browser_native_focus_view(native_view, label.clone())?;
    let focus_callback_view = native_view;
    let focus_callback_registration_id = registration_id;
    let got_focus = FocusChangedEventHandler::create(Box::new(move |sender, _args| {
        if let Some(controller) = sender {
            if controller.as_raw() as usize != focus_callback_view {
                return Ok(());
            }
            if let Ok(webview) = unsafe { controller.CoreWebView2() } {
                emit_windows_browser_native_focus(
                    focus_callback_view,
                    focus_callback_registration_id,
                    &webview,
                );
            }
        }
        Ok(())
    }));
    let source_changed_callback_view = native_view;
    let source_changed_callback_registration_id = registration_id;
    let source_changed = SourceChangedEventHandler::create(Box::new(move |sender, _args| {
        let Some(args) = _args else {
            return Ok(());
        };
        let mut is_new_document = Default::default();
        if unsafe { args.IsNewDocument(&mut is_new_document) }.is_err() || is_new_document.as_bool()
        {
            return Ok(());
        }
        if let Some(webview) = sender {
            emit_windows_browser_native_route(
                source_changed_callback_view,
                source_changed_callback_registration_id,
                &webview,
            );
        }
        Ok(())
    }));
    let mut got_focus_token = 0;
    if let Err(error) = unsafe { controller.add_GotFocus(&got_focus, &mut got_focus_token) } {
        unregister_browser_native_focus_view(native_view, registration_id);
        return Err(error.to_string());
    }
    let mut source_changed_token = 0;
    if let Err(error) =
        unsafe { native_webview.add_SourceChanged(&source_changed, &mut source_changed_token) }
    {
        let _ = unsafe { controller.remove_GotFocus(got_focus_token) };
        unregister_browser_native_focus_view(native_view, registration_id);
        return Err(error.to_string());
    }
    if let Some(previous) = BROWSER_WINDOWS_FOCUS_REGISTRATIONS.lock().insert(
        label,
        BrowserWindowsFocusRegistration {
            native_view,
            registration_id,
            got_focus_token,
            source_changed_token,
        },
    ) {
        if previous.native_view == native_view {
            let _ = unsafe { controller.remove_GotFocus(previous.got_focus_token) };
            let _ = unsafe { native_webview.remove_SourceChanged(previous.source_changed_token) };
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_webview_identity(webview: &webkit2gtk::WebView) -> usize {
    let pointer: *mut webkit2gtk::ffi::WebKitWebView = webview.to_glib_none().0;
    pointer as usize
}

#[cfg(target_os = "linux")]
fn install_platform_browser_focus_callback(
    platform_webview: PlatformWebview,
    label: String,
) -> Result<(), String> {
    let webview = platform_webview.inner();
    let native_view = linux_webview_identity(&webview);
    let registration_id = register_browser_native_focus_view(native_view, label)?;
    webview.connect_focus_in_event(move |webview, _event| {
        let callback_view = linux_webview_identity(webview);
        let current_url = webview.uri().map(|url| url.to_string()).unwrap_or_default();
        let current_title = webview
            .title()
            .map(|title| title.to_string())
            .unwrap_or_default();
        emit_browser_native_focus(callback_view, registration_id, &current_url, &current_title);
        glib::Propagation::Proceed
    });
    webview.connect_button_press_event(move |webview, _event| {
        let callback_view = linux_webview_identity(webview);
        let current_url = webview.uri().map(|url| url.to_string()).unwrap_or_default();
        let current_title = webview
            .title()
            .map(|title| title.to_string())
            .unwrap_or_default();
        emit_browser_native_focus(callback_view, registration_id, &current_url, &current_title);
        glib::Propagation::Proceed
    });
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn install_platform_browser_focus_callback(
    _platform_webview: PlatformWebview,
    _label: String,
) -> Result<(), String> {
    // Remote page events are not a fallback: unsupported native targets fail closed.
    Err("native browser focus callbacks are unsupported on this platform".to_string())
}

pub(crate) fn detach_browser_native_focus_callback(webview: &Webview) {
    #[cfg(target_os = "macos")]
    {
        let _ = webview.with_webview(|platform_webview| {
            let webview = unsafe { &*(platform_webview.inner().cast::<WKWebView>()) };
            let native_view = webview as *const WKWebView as usize;
            BROWSER_MACOS_FOCUS_TARGETS.with(|targets| {
                if let Some((_target, recognizer)) = targets.borrow_mut().remove(&native_view) {
                    webview.removeGestureRecognizer(&recognizer);
                }
            });
        });
    }
    #[cfg(target_os = "windows")]
    {
        let registration = BROWSER_WINDOWS_FOCUS_REGISTRATIONS
            .lock()
            .remove(webview.label());
        if let Some(registration) = registration {
            unregister_browser_native_focus_view(
                registration.native_view,
                registration.registration_id,
            );
            let _ = webview.with_webview(move |platform_webview| {
                let controller = platform_webview.controller();
                if controller.as_raw() as usize != registration.native_view {
                    return;
                }
                let _ = unsafe { controller.remove_GotFocus(registration.got_focus_token) };
                if let Ok(native_webview) = unsafe { controller.CoreWebView2() } {
                    let _ = unsafe {
                        native_webview.remove_SourceChanged(registration.source_changed_token)
                    };
                }
            });
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = webview;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(generation: u64, token: &str) -> BrowserFocusIdentity {
        BrowserFocusIdentity {
            generation,
            navigation_token: token.to_string(),
            document_url: "https://example.test".to_string(),
        }
    }

    #[test]
    fn native_callback_resolves_the_current_live_registry_identity() {
        let label = "psyche-browser-native-current".to_string();
        let native_view = 41;
        let registration_id =
            register_browser_native_focus_view(native_view, label.clone()).unwrap();
        install_browser_focus_identity(label.clone(), identity(1, "initial"));
        install_browser_focus_identity(label.clone(), identity(2, "current"));
        let mut emitted = Vec::new();

        assert!(dispatch_browser_native_focus(
            native_view,
            registration_id,
            "https://example.test/path#current",
            "  Current route title  ",
            |payload| {
                emitted.push(payload);
                Ok::<(), ()>(())
            },
        ));
        assert_eq!(
            emitted,
            vec![BrowserFocusPayload {
                label: label.clone(),
                url: "https://example.test/path#current".to_string(),
                title: "Current route title".to_string(),
                generation: 2,
                navigation_token: "current".to_string(),
            }]
        );
        retire_browser_focus_label(&label);
    }

    #[test]
    fn stale_or_retired_native_views_are_ignored() {
        let label = "psyche-browser-native-stale".to_string();
        let native_view = 42;
        let registration_id =
            register_browser_native_focus_view(native_view, label.clone()).unwrap();
        install_browser_focus_identity(label.clone(), identity(3, "live"));
        let replacement_registration_id =
            register_browser_native_focus_view(native_view, label.clone()).unwrap();

        assert!(resolve_browser_native_focus(
            native_view,
            registration_id,
            "https://example.test",
            "",
        )
        .is_none());
        assert!(resolve_browser_native_focus(
            native_view,
            replacement_registration_id,
            "https://example.test",
            "",
        )
        .is_some());
        retire_browser_focus_label(&label);
        assert!(resolve_browser_native_focus(
            native_view,
            replacement_registration_id,
            "https://example.test",
            "",
        )
        .is_none());
    }

    #[test]
    fn native_focus_preserves_same_document_urls() {
        let label = "psyche-browser-native-fragment".to_string();
        let native_view = 43;
        let registration_id =
            register_browser_native_focus_view(native_view, label.clone()).unwrap();
        install_browser_focus_identity(label.clone(), identity(4, "fragment"));
        let mut emitted = Vec::new();

        assert_eq!(
            dispatch_browser_native_focus(
                native_view,
                registration_id,
                "https://example.test/page#section",
                "Fragment title",
                |payload| {
                    emitted.push(payload);
                    Ok::<(), ()>(())
                },
            )
            .then_some(
                emitted
                    .first()
                    .map(|payload| (payload.url.clone(), payload.title.clone())),
            )
            .flatten(),
            Some((
                "https://example.test/page#section".to_string(),
                "Fragment title".to_string(),
            )),
        );
        assert_eq!(
            browser_focus_identity(&label).map(|identity| identity.document_url),
            Some("https://example.test/page#section".to_string())
        );
        retire_browser_focus_label(&label);
    }

    #[test]
    fn native_focus_bounds_and_serializes_titles() {
        let label = "psyche-browser-native-title".to_string();
        let native_view = 44;
        let registration_id =
            register_browser_native_focus_view(native_view, label.clone()).unwrap();
        install_browser_focus_identity(label.clone(), identity(7, "title"));
        let expected = "Current route title "
            .repeat(40)
            .trim()
            .chars()
            .take(512)
            .collect::<String>();

        let payload = resolve_browser_native_focus(
            native_view,
            registration_id,
            "https://example.test/account#details",
            &format!("  {}  ", "Current route title ".repeat(40).trim()),
        )
        .unwrap();

        assert_eq!(payload.title, expected);
        assert_eq!(
            serde_json::to_value(&payload).unwrap()["title"],
            serde_json::Value::String(payload.title.clone())
        );
        retire_browser_focus_label(&label);
    }

    #[test]
    fn native_focus_emits_successive_same_document_route_updates() {
        let label = "psyche-browser-native-route-updates".to_string();
        let native_view = 45;
        let registration_id =
            register_browser_native_focus_view(native_view, label.clone()).unwrap();
        install_browser_focus_identity(label.clone(), identity(8, "route"));
        let mut emitted = Vec::new();

        assert!(dispatch_browser_native_route(
            native_view,
            registration_id,
            "https://example.test/account?view=details",
            "Details",
            |payload| {
                emitted.push(payload);
                Ok::<(), ()>(())
            },
        ));
        assert!(dispatch_browser_native_route(
            native_view,
            registration_id,
            "https://example.test/account?view=billing",
            "  ",
            |payload| {
                emitted.push(payload);
                Ok::<(), ()>(())
            },
        ));
        assert_eq!(
            emitted,
            vec![
                BrowserFocusPayload {
                    label: label.clone(),
                    url: "https://example.test/account?view=details".to_string(),
                    title: "Details".to_string(),
                    generation: 8,
                    navigation_token: "route".to_string(),
                },
                BrowserFocusPayload {
                    label: label.clone(),
                    url: "https://example.test/account?view=billing".to_string(),
                    title: String::new(),
                    generation: 8,
                    navigation_token: "route".to_string(),
                },
            ]
        );
        assert_eq!(
            browser_focus_identity(&label).map(|identity| identity.document_url),
            Some("https://example.test/account?view=billing".to_string())
        );
        retire_browser_focus_label(&label);
    }

    #[test]
    fn matching_focus_retirement_does_not_remove_a_successor() {
        let label = "psyche-browser-native-focus-retirement".to_string();
        let old = identity(5, "old");
        let current = identity(6, "current");
        install_browser_focus_identity(label.clone(), current.clone());

        retire_matching_browser_focus_identity(&label, &old);
        assert_eq!(browser_focus_identity(&label), Some(current.clone()));
        retire_matching_browser_focus_identity(&label, &current);
        assert_eq!(browser_focus_identity(&label), None);
    }
}

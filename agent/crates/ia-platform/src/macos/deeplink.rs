//! The `indiansassist://` deep link on macOS (Phase F §17.2), compiled on macOS only.
//!
//! Launch Services does not pass a URL on the command line: it launches the bundle (declared in
//! `CFBundleURLTypes`) and then sends a `GetURL` Apple Event, which the process receives only
//! while it handles events. The agent resolves its join code before the UI starts, so for a
//! bundled launch with no other carrier [`catch_launch_url`] registers a `GetURL` handler, lets
//! the application finish launching and pumps events for a short window. winit's own run loop
//! takes over afterwards (a second `finishLaunching` from it is harmless).

use std::cell::RefCell;
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEventMask};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSString};

/// `kInternetEventClass` and `kAEGetURL`, both `'GURL'`.
const K_AE_GET_URL: u32 = u32::from_be_bytes(*b"GURL");
/// `keyDirectObject`, `'----'`.
const KEY_DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");

thread_local! {
    static RECEIVED: RefCell<Option<String>> = const { RefCell::new(None) };
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and `UrlHandler` does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "IAUrlHandler"]
    struct UrlHandler;

    impl UrlHandler {
        #[unsafe(method(handleGetURLEvent:withReplyEvent:))]
        fn handle_get_url(&self, event: &AnyObject, _reply: &AnyObject) {
            // SAFETY: `event` is an NSAppleEventDescriptor; both selectors exist on it.
            let url: Option<Retained<NSString>> = unsafe {
                let param: Option<Retained<AnyObject>> =
                    msg_send![event, paramDescriptorForKeyword: KEY_DIRECT_OBJECT];
                match param {
                    Some(p) => msg_send![&*p, stringValue],
                    None => None,
                }
            };
            if let Some(url) = url {
                RECEIVED.with(|r| *r.borrow_mut() = Some(url.to_string()));
            }
        }
    }
);

impl UrlHandler {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's designated initialiser.
        unsafe { msg_send![super(this), init] }
    }
}

/// Wait up to `window` for the launch `GetURL` event and return its URL. Must run on the main
/// thread before the UI's event loop starts; returns `None` off the main thread.
pub fn catch_launch_url(window: Duration) -> Option<String> {
    let mtm = MainThreadMarker::new()?;
    let handler = UrlHandler::new();
    // SAFETY: registering a handler object and selector it implements; the object is kept alive
    // for the whole wait below and the registration is removed before it is released.
    unsafe {
        let manager: Retained<AnyObject> =
            msg_send![objc2::class!(NSAppleEventManager), sharedAppleEventManager];
        let _: () = msg_send![
            &*manager,
            setEventHandler: &*handler,
            andSelector: sel!(handleGetURLEvent:withReplyEvent:),
            forEventClass: K_AE_GET_URL,
            andEventID: K_AE_GET_URL
        ];
    }
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    let deadline = Instant::now() + window;
    while Instant::now() < deadline && RECEIVED.with(|r| r.borrow().is_none()) {
        let until = NSDate::dateWithTimeIntervalSinceNow(0.05);
        // SAFETY: the default run-loop mode constant; events are dispatched as the app would.
        let event = unsafe {
            app.nextEventMatchingMask_untilDate_inMode_dequeue(
                NSEventMask::Any,
                Some(&until),
                NSDefaultRunLoopMode,
                true,
            )
        };
        if let Some(e) = event {
            app.sendEvent(&e);
        }
    }
    // SAFETY: removing the registration made above.
    unsafe {
        let manager: Retained<AnyObject> =
            msg_send![objc2::class!(NSAppleEventManager), sharedAppleEventManager];
        let _: () = msg_send![
            &*manager,
            removeEventHandlerForEventClass: K_AE_GET_URL,
            andEventID: K_AE_GET_URL
        ];
    }
    RECEIVED.with(|r| r.borrow_mut().take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_char_codes_are_apples() {
        assert_eq!(K_AE_GET_URL, 0x4755_524C);
        assert_eq!(KEY_DIRECT_OBJECT, 0x2D2D_2D2D);
    }

    #[test]
    fn off_the_main_thread_nothing_is_caught() {
        let got = std::thread::spawn(|| catch_launch_url(Duration::from_millis(10)))
            .join()
            .unwrap();
        assert_eq!(got, None);
    }
}

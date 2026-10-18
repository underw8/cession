use std::cell::Cell;
use std::ptr::NonNull;
use std::sync::Mutex;

use block2::RcBlock;
use tauri_nspanel::objc2_foundation::NSString;
// tauri_panel! already imports NSEvent, NSWindow, NSPoint, NSRect, NSSize, MainThreadMarker, msg_send, AnyObject.
use objc2_app_kit::{
    NSCursor, NSCursorFrameResizeDirections, NSCursorFrameResizePosition, NSEventMask, NSEventModifierFlags, NSEventType, NSScreen,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{ActivationPolicy, LogicalSize, Manager, Size, Url, WebviewUrl, WebviewWindow};
use tauri_nspanel::{
    tauri_panel, ManagerExt, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask, TrackingAreaOptions,
};

// WKWebView's default plus the marker the server uses to send unpaired widgets to /pair.
// ponytail: Tauri can only replace the user agent, not append to it.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) cession-widget";

const CORNER_RADIUS: f64 = 14.0;

// Hover bar, buttons and resize grip drawn over the page; hidden scrollbar.
const CHROME: &str = include_str!("chrome.js");

// Chrome geometry, mirrored in chrome.js: top bar height, button width, bottom-right grip size.
// The bar sits over the dashboard's blank top padding.
const BAR: f64 = 24.0;
const BTN: f64 = 24.0;
const GRIP: f64 = 20.0;
// Resize grab width inside each edge (thinner on top so the bar stays grabbable),
// and how far a corner grab reaches along both edges.
const EDGE: f64 = 10.0;
const TOP_EDGE: f64 = 4.0;
const CORNER: f64 = 28.0;
const MIN_SIZE: (f64, f64) = (260.0, 200.0);
// At or below BAR_MODE tall the dashboard shows as a strip (`max-height: 60px` in index.html and chrome.js).
// Heights under MIN_SIZE snap to BAR_HEIGHT or MIN_SIZE, so the panel is always one or the other.
const BAR_MODE: f64 = 60.0;
const BAR_HEIGHT: f64 = 36.0;
const DEFAULT_SIZE: (f64, f64) = (380.0, 560.0);
// The bar has no dashboard max-width, so it may grow to fit a row of sessions.
const BAR_DEFAULT_WIDTH: f64 = 720.0;
const BAR_MAX_WIDTH: f64 = 1600.0;
// Dashboard `.panel` max-width (460) plus body padding (2 × 12) in server/public/index.html.
const MAX_WIDTH: f64 = 484.0;

tauri_panel! {
    panel!(Widget {
        config: { can_become_key_window: true, is_floating_panel: true }
        // Delivers mouse moves and enter/exit while the panel isn't key: resize cursors and hover chrome.
        with: {
            tracking_area: {
                options: TrackingAreaOptions::new().active_always().mouse_entered_and_exited().mouse_moved(),
                auto_resize: true
            }
        }
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            // Accessory apps may join other apps' fullscreen spaces.
            app.set_activation_policy(ActivationPolicy::Accessory);
            let panel = PanelBuilder::<_, Widget>::new(app.handle(), "widget")
                .url(WebviewUrl::App("index.html".into()))
                .size(Size::Logical(LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1)))
                .level(PanelLevel::Floating)
                .collection_behavior(
                    CollectionBehavior::new()
                        .full_screen_auxiliary()
                        .can_join_all_spaces()
                        .into(),
                )
                .hides_on_deactivate(false)
                .corner_radius(CORNER_RADIUS)
                .transparent(true)
                .with_window(|w| {
                    let paired = Mutex::new(None);
                    w.decorations(false).user_agent(USER_AGENT).initialization_script(CHROME).on_navigation(move |url| {
                        let mut paired = paired.lock().unwrap();
                        let (ok, next) = allow(paired.as_deref(), url);
                        *paired = next;
                        ok
                    })
                })
                .add_style_mask(StyleMask::empty().nonactivating_panel())
                .build()?;
            panel.show();
            let window = app.get_webview_window("widget").unwrap();
            clip_corners(&window);
            handle_mouse(&window);

            // Accessory apps have no Dock icon or menu bar, so the tray is the only way out.
            let show = MenuItem::with_id(app, "show", "Show cession", true, None::<&str>)?;
            let pair = MenuItem::with_id(app, "pair", "Pair with server…", true, None::<&str>)?;
            let reload = MenuItem::with_id(app, "reload", "Reload status", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit cession", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .menu(&Menu::with_items(app, &[&show, &pair, &reload, &quit])?)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "show" => {
                        if let Ok(panel) = app.get_webview_panel("widget") {
                            panel.show();
                        }
                    }
                    "pair" => {
                        if let Some(window) = app.get_webview_window("widget") {
                            let _ = window.navigate("tauri://localhost/index.html#pair".parse().unwrap());
                        }
                    }
                    "reload" => {
                        if let Some(window) = app.get_webview_window("widget") {
                            // Revalidates against the server, so a fresh deploy shows up.
                            let _ = window.with_webview(|w| unsafe {
                                let _: () = msg_send![w.inner().cast::<AnyObject>(), reloadFromOrigin: std::ptr::null::<AnyObject>()];
                            });
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running cession-widget");
}

/// The local page may hand off to one remote origin, fixed until the local page loads again; returns (allowed, new origin).
fn allow(paired: Option<&str>, url: &Url) -> (bool, Option<String>) {
    let keep = paired.map(String::from);
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return (true, None);
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && local)) {
        return (false, keep);
    }
    let origin = url.origin().ascii_serialization();
    match paired {
        None => (true, Some(origin)),
        Some(p) => (p == origin, keep),
    }
}

// ⌥-drag anywhere resizes from the nearest corner; ⌘-drag anywhere moves.
// Handled natively: a nonactivating panel's webview can't reliably start drags over IPC,
// and a borderless window's own resize zone is a few pixels and excludes the top edge.
fn handle_mouse(window: &WebviewWindow) {
    let win: *const NSWindow = window.ns_window().unwrap().cast();
    let id = unsafe { &*win }.windowNumber();
    // Explicit false also catches clicks on the transparent pixels outside the rounded corners.
    unsafe { &*win }.setIgnoresMouseEvents(false);
    // AppKit saves the frame on every move/resize; restore it explicitly after the builder placed the panel.
    let name = NSString::from_str("cession-widget");
    unsafe { &*win }.setFrameAutosaveName(&name);
    unsafe { &*win }.setFrameUsingName(&name);
    let resizing: Cell<Option<(Edge, NSRect, NSPoint)>> = Cell::new(None);
    let hovering = Cell::new(false);
    // Last size of each mode. ponytail: in memory only, so the first toggle after a restart uses defaults.
    let full = Cell::new(NSSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1));
    let bar = Cell::new(NSSize::new(BAR_DEFAULT_WIDTH, BAR_HEIGHT));
    let webview = window.clone();
    let handler = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
        let e = unsafe { ev.as_ref() };
        let win = unsafe { &*win };
        // The tray icon is also an app window, so match ours by number.
        if e.windowNumber() != id && resizing.get().is_none() {
            return ev.as_ptr();
        }
        let frame = win.frame();
        let p = e.locationInWindow();
        // WebKit's own :hover is unreliable in an unfocused panel, so the native side drives it.
        let kind = e.r#type();
        if matches!(kind, NSEventType::MouseEntered | NSEventType::MouseExited | NSEventType::MouseMoved) {
            let inside = contains(frame, NSEvent::mouseLocation());
            if inside != hovering.replace(inside) {
                let _ = webview.eval(format!("document.documentElement.classList.toggle('cession-hover', {inside})"));
            }
        }
        match kind {
            NSEventType::MouseMoved => {
                if let Some(Hit::Resize(edge)) = hit(frame.size, p) {
                    NSCursor::frameResizeCursorFromPosition_inDirections(
                        cursor_position(edge),
                        NSCursorFrameResizeDirections::All,
                    )
                    .set();
                    return std::ptr::null_mut();
                }
            }
            NSEventType::LeftMouseDown => {
                let flags = e.modifierFlags();
                let target = if flags.contains(NSEventModifierFlags::Option) {
                    Some(Hit::Resize(nearest_corner(frame.size, p)))
                } else if flags.contains(NSEventModifierFlags::Command) {
                    Some(Hit::Move)
                } else {
                    hit(frame.size, p)
                };
                match target {
                    Some(Hit::Resize(edge)) => resizing.set(Some((edge, frame, NSEvent::mouseLocation()))),
                    Some(Hit::Move) => win.performWindowDragWithEvent(e),
                    Some(Hit::NextScreen) => move_to_next_screen(win),
                    Some(Hit::Toggle) => {
                        let (from, to) = if frame.size.height <= BAR_MODE { (&bar, &full) } else { (&full, &bar) };
                        from.set(frame.size);
                        let screen = win.screen().map_or(frame, |s| s.visibleFrame());
                        win.setFrame_display(toggled(frame, to.get(), screen), true);
                    }
                    Some(Hit::Hide) => {
                        win.orderOut(None);
                        // No exit event follows, so clear hover or the bar shows on the next Show.
                        hovering.set(false);
                        let _ = webview.eval("document.documentElement.classList.remove('cession-hover')");
                    }
                    None => return ev.as_ptr(),
                }
                return std::ptr::null_mut();
            }
            NSEventType::LeftMouseDragged => {
                if let Some((edge, start, mouse)) = resizing.get() {
                    let now = NSEvent::mouseLocation();
                    win.setFrame_display(resized(start, edge, now.x - mouse.x, now.y - mouse.y), true);
                    return std::ptr::null_mut();
                }
            }
            NSEventType::LeftMouseUp => {
                if resizing.take().is_some() {
                    return std::ptr::null_mut();
                }
            }
            _ => {}
        }
        ev.as_ptr()
    });
    let mask = NSEventMask::LeftMouseDown
        | NSEventMask::LeftMouseDragged
        | NSEventMask::LeftMouseUp
        | NSEventMask::MouseMoved
        | NSEventMask::MouseEntered
        | NSEventMask::MouseExited;
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) };
    std::mem::forget(monitor); // lives for the whole app
}

/// Horizontal and vertical side of a grabbed edge: -1 left/bottom, 1 right/top, 0 neither.
type Edge = (i8, i8);

#[derive(Debug, PartialEq)]
enum Hit {
    Resize(Edge),
    Move,
    NextScreen,
    Toggle,
    Hide,
}

fn hit(size: NSSize, p: NSPoint) -> Option<Hit> {
    if let Some(edge) = edge_at(size, p) {
        return Some(Hit::Resize(edge));
    }
    let bar_mode = size.height <= BAR_MODE;
    if !bar_mode && p.x > size.width - GRIP && p.y < GRIP {
        return Some(Hit::Resize((1, -1)));
    }
    // In bar mode the whole strip is the drag bar.
    if !bar_mode && size.height - p.y > BAR {
        return None;
    }
    // Buttons sit right-aligned, inset by the right resize edge.
    let from_right = size.width - EDGE - p.x;
    Some(if from_right < BTN {
        Hit::Hide
    } else if from_right < 2.0 * BTN {
        Hit::NextScreen
    } else if from_right < 3.0 * BTN {
        Hit::Toggle
    } else {
        Hit::Move
    })
}

fn edge_at(size: NSSize, p: NSPoint) -> Option<Edge> {
    let side = |v: f64, max: f64, low: f64, high: f64| -> i8 {
        if v < low { -1 } else if v > max - high { 1 } else { 0 }
    };
    // A strip is too short for a full bottom edge or vertical corner reach.
    let (bottom, reach) = if size.height <= BAR_MODE { (TOP_EDGE, TOP_EDGE) } else { (EDGE, CORNER) };
    let edge = (side(p.x, size.width, EDGE, EDGE), side(p.y, size.height, bottom, TOP_EDGE));
    let corner = (side(p.x, size.width, CORNER, CORNER), side(p.y, size.height, reach, reach));
    match (edge, corner) {
        ((0, 0), _) => None,
        (_, (x, y)) if x != 0 && y != 0 => Some((x, y)),
        _ => Some(edge),
    }
}

fn contains(r: NSRect, p: NSPoint) -> bool {
    p.x >= r.origin.x && p.x < r.origin.x + r.size.width && p.y >= r.origin.y && p.y < r.origin.y + r.size.height
}

fn nearest_corner(size: NSSize, p: NSPoint) -> Edge {
    (
        if p.x < size.width / 2.0 { -1 } else { 1 },
        if p.y < size.height / 2.0 { -1 } else { 1 },
    )
}

fn resized(start: NSRect, (x, y): Edge, dx: f64, dy: f64) -> NSRect {
    let mut f = start;
    if y != 0 {
        let h = start.size.height + dy * y as f64;
        f.size.height = if h >= MIN_SIZE.1 {
            h
        } else if h > (MIN_SIZE.1 + BAR_HEIGHT) / 2.0 {
            MIN_SIZE.1
        } else {
            BAR_HEIGHT
        };
        if y < 0 {
            f.origin.y = start.origin.y + start.size.height - f.size.height;
        }
    }
    // Clamped even without a horizontal drag, so a wide bar dragged tall narrows to the full view.
    let max_width = if f.size.height <= BAR_MODE { BAR_MAX_WIDTH } else { MAX_WIDTH };
    f.size.width = (start.size.width + dx * x as f64).clamp(MIN_SIZE.0, max_width);
    if x < 0 {
        f.origin.x = start.origin.x + start.size.width - f.size.width;
    }
    f
}

/// Switch to the other mode's size, top-left corner pinned but kept on screen.
fn toggled(f: NSRect, size: NSSize, screen: NSRect) -> NSRect {
    let size = NSSize::new(size.width.min(screen.size.width), size.height.min(screen.size.height));
    NSRect::new(
        NSPoint::new(
            f.origin.x.clamp(screen.origin.x, screen.origin.x + screen.size.width - size.width),
            (f.origin.y + f.size.height - size.height)
                .clamp(screen.origin.y, screen.origin.y + screen.size.height - size.height),
        ),
        size,
    )
}

/// Same relative spot on the next display, shrunk if that display is smaller.
fn move_to_next_screen(win: &NSWindow) {
    let screens: Vec<_> = NSScreen::screens(MainThreadMarker::new().unwrap()).iter().collect();
    let Some(current) = win.screen() else { return };
    let i = screens.iter().position(|s| s.frame() == current.frame()).unwrap_or(0);
    let next = &screens[(i + 1) % screens.len()];
    win.setFrame_display(placed_on(win.frame(), current.visibleFrame(), next.visibleFrame()), true);
}

fn placed_on(f: NSRect, from: NSRect, to: NSRect) -> NSRect {
    let size = NSSize::new(f.size.width.min(to.size.width), f.size.height.min(to.size.height));
    // 0 = flush left/bottom, 1 = flush right/top of the visible area.
    let rel = |pos: f64, origin: f64, span: f64, len: f64| {
        if span > len { ((pos - origin) / (span - len)).clamp(0.0, 1.0) } else { 0.0 }
    };
    let rx = rel(f.origin.x, from.origin.x, from.size.width, f.size.width);
    let ry = rel(f.origin.y, from.origin.y, from.size.height, f.size.height);
    NSRect::new(
        NSPoint::new(
            to.origin.x + rx * (to.size.width - size.width),
            to.origin.y + ry * (to.size.height - size.height),
        ),
        size,
    )
}

fn cursor_position(edge: Edge) -> NSCursorFrameResizePosition {
    use NSCursorFrameResizePosition as P;
    match edge {
        (-1, 1) => P::TopLeft,
        (1, 1) => P::TopRight,
        (-1, -1) => P::BottomLeft,
        (1, -1) => P::BottomRight,
        (-1, _) => P::Left,
        (1, _) => P::Right,
        (_, 1) => P::Top,
        _ => P::Bottom,
    }
}

// corner_radius() only rounds the layer; the webview overflows it until the layer masks.
fn clip_corners(window: &WebviewWindow) {
    let ns: &NSWindow = unsafe { &*window.ns_window().unwrap().cast() };
    let layer = ns.contentView().unwrap();
    unsafe {
        let layer: *mut AnyObject = msg_send![&*layer, layer];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
    ns.invalidateShadow();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_and_resize() {
        let size = NSSize::new(400.0, 600.0);
        assert_eq!(edge_at(size, NSPoint::new(200.0, 300.0)), None);
        assert_eq!(edge_at(size, NSPoint::new(200.0, 598.0)), Some((0, 1)));
        assert_eq!(edge_at(size, NSPoint::new(2.0, 300.0)), Some((-1, 0)));
        // Corner reach extends past EDGE along the other axis.
        assert_eq!(edge_at(size, NSPoint::new(390.0, 2.0)), Some((1, -1)));

        let start = NSRect::new(NSPoint::new(100.0, 100.0), size);
        let top_left = resized(start, (-1, 1), -50.0, 20.0);
        assert_eq!((top_left.origin.x, top_left.origin.y), (50.0, 100.0));
        assert_eq!((top_left.size.width, top_left.size.height), (450.0, 620.0));
        assert_eq!(nearest_corner(size, NSPoint::new(10.0, 590.0)), (-1, 1));
        assert_eq!(nearest_corner(size, NSPoint::new(300.0, 100.0)), (1, -1));
        assert_eq!(resized(start, (1, 0), 500.0, 0.0).size.width, MAX_WIDTH);
        // Top bar: buttons from the right, inset by EDGE; the rest moves.
        assert_eq!(hit(size, NSPoint::new(380.0, 590.0)), Some(Hit::Hide));
        assert_eq!(hit(size, NSPoint::new(360.0, 590.0)), Some(Hit::NextScreen));
        assert_eq!(hit(size, NSPoint::new(330.0, 590.0)), Some(Hit::Toggle));
        assert_eq!(hit(size, NSPoint::new(200.0, 590.0)), Some(Hit::Move));
        assert_eq!(hit(size, NSPoint::new(385.0, 15.0)), Some(Hit::Resize((1, -1))));
        assert_eq!(hit(size, NSPoint::new(200.0, 300.0)), None);

        // Flush right on a 1000-wide display stays flush right on a 2000-wide one.
        let from = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1000.0, 800.0));
        let to = NSRect::new(NSPoint::new(1000.0, 0.0), NSSize::new(2000.0, 1000.0));
        let moved = placed_on(NSRect::new(NSPoint::new(600.0, 0.0), size), from, to);
        assert_eq!((moved.origin.x, moved.origin.y), (2600.0, 0.0));
        // Shrinking past the minimum snaps to the full minimum or the bar, pinning the far edge.
        let bottom = resized(start, (0, -1), 0.0, 1000.0);
        assert_eq!(bottom.size.height, BAR_HEIGHT);
        assert_eq!(bottom.origin.y + bottom.size.height, 700.0);
        assert_eq!(resized(start, (0, -1), 0.0, 420.0).size.height, MIN_SIZE.1);
        let bar = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, BAR_HEIGHT));
        assert_eq!(resized(bar, (0, 1), 0.0, 60.0).size.height, BAR_HEIGHT);
        assert_eq!(resized(bar, (0, 1), 0.0, 120.0).size.height, MIN_SIZE.1);

        // Bar mode: strip drags anywhere, keeps its buttons, thin top/bottom resize, no grip.
        let strip = NSSize::new(400.0, BAR_HEIGHT);
        assert_eq!(hit(strip, NSPoint::new(200.0, 18.0)), Some(Hit::Move));
        assert_eq!(hit(strip, NSPoint::new(380.0, 18.0)), Some(Hit::Hide));
        assert_eq!(hit(strip, NSPoint::new(360.0, 18.0)), Some(Hit::NextScreen));
        assert_eq!(hit(strip, NSPoint::new(330.0, 18.0)), Some(Hit::Toggle));
        assert_eq!(hit(strip, NSPoint::new(200.0, 2.0)), Some(Hit::Resize((0, -1))));

        // Toggle pins the top edge; a bar at the screen bottom expands upward instead.
        let screen = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1000.0, 800.0));
        let full = NSRect::new(NSPoint::new(0.0, 200.0), size);
        let collapsed = toggled(full, NSSize::new(720.0, BAR_HEIGHT), screen);
        assert_eq!((collapsed.origin.y, collapsed.size.width, collapsed.size.height), (764.0, 720.0, BAR_HEIGHT));
        assert_eq!(toggled(collapsed, size, screen), full);
        let low = toggled(NSRect::new(NSPoint::new(0.0, 0.0), strip), size, screen);
        assert_eq!((low.origin.y, low.size.height), (0.0, 600.0));
        // A wide bar may pass MAX_WIDTH; dragged tall it narrows back.
        assert_eq!(resized(bar, (1, 0), 800.0, 0.0).size.width, 1200.0);
        let wide = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1200.0, BAR_HEIGHT));
        assert_eq!(resized(wide, (0, 1), 0.0, 500.0).size.width, MAX_WIDTH);
        assert_eq!(hit(strip, NSPoint::new(200.0, 34.0)), Some(Hit::Resize((0, 1))));
        assert_eq!(hit(strip, NSPoint::new(2.0, 18.0)), Some(Hit::Resize((-1, 0))));
    }

    #[test]
    fn navigation_filter() {
        let u = |s: &str| Url::parse(s).unwrap();
        let srv = Some("https://cession.example.workers.dev".to_string());
        assert_eq!(allow(None, &u("tauri://localhost/index.html")), (true, None));
        assert_eq!(allow(None, &u("https://cession.example.workers.dev/auth/pair")), (true, srv.clone()));
        assert_eq!(allow(srv.as_deref(), &u("https://cession.example.workers.dev/")), (true, srv.clone()));
        assert_eq!(allow(srv.as_deref(), &u("https://evil.example/")), (false, srv.clone()));
        assert_eq!(allow(srv.as_deref(), &u("tauri://localhost/index.html#pair")), (true, None));
        assert_eq!(allow(None, &u("http://example.com/")), (false, None));
        assert_eq!(allow(None, &u("http://localhost:8787/")), (true, Some("http://localhost:8787".into())));
        assert_eq!(allow(None, &u("file:///etc/passwd")), (false, None));
        for bad in ["data:text/html,hi", "blob:https://cession.example.workers.dev/x", "javascript:alert(1)"] {
            assert_eq!(allow(srv.as_deref(), &u(bad)), (false, srv.clone()), "{bad}");
        }
    }
}

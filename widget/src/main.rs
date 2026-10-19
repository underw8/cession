use std::cell::Cell;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use tauri_nspanel::objc2_foundation::NSString;
// tauri_panel! already imports NSEvent, NSWindow, NSPoint, NSRect, NSSize, MainThreadMarker, msg_send, AnyObject.
use objc2_app_kit::{
    NSCursor, NSCursorFrameResizeDirections, NSCursorFrameResizePosition, NSEventMask, NSEventModifierFlags, NSEventType, NSScreen,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::PageLoadEvent;
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
            // Shared with the tray "Pair with server…" handler, the only place allowed to start a reset.
            let paired: Arc<Mutex<Pin>> = Arc::new(Mutex::new(Pin::Unpaired));
            let nav_paired = paired.clone();
            let load_paired = paired.clone();
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
                .with_window(move |w| {
                    w.decorations(false)
                        .user_agent(USER_AGENT)
                        .initialization_script(CHROME)
                        .on_navigation(move |url| {
                            let mut paired = nav_paired.lock().unwrap();
                            let (ok, next) = allow(&paired, url);
                            *paired = next;
                            ok
                        })
                        .on_page_load(move |_window, payload| {
                            let mut paired = load_paired.lock().unwrap();
                            *paired = on_load(&paired, payload.event(), payload.url());
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
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "show" => {
                        if let Ok(panel) = app.get_webview_panel("widget") {
                            panel.show();
                        }
                    }
                    "pair" => {
                        if let Some(window) = app.get_webview_window("widget") {
                            let previous = {
                                let mut pin = paired.lock().unwrap();
                                let previous = pin.clone();
                                *pin = Pin::Resetting;
                                previous
                            };
                            let n = RESET_COUNTER.fetch_add(1, Ordering::Relaxed);
                            if window.navigate(reset_url(n)).is_err() {
                                *paired.lock().unwrap() = previous;
                            }
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

static RESET_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fragment-only navigate to a page already on that fragment is a same-document WebKit
/// navigation, so `on_page_load` Finished never fires; the query makes every reset a distinct URL.
fn reset_url(n: u64) -> Url {
    format!("tauri://localhost/index.html?r={n}#pair").parse().unwrap()
}

/// Lifecycle of the widget's one legitimate remote origin.
#[derive(Debug, Clone, PartialEq)]
enum Pin {
    /// No origin pinned yet; the first allowed https (or http on localhost/127.0.0.1) navigation pins one.
    Unpaired,
    /// Only this origin may be navigated to; `tauri://localhost` is denied.
    Paired(String),
    /// Set by the tray "Pair with server…" handler; only `tauri://localhost` is allowed until that page commits (see `on_load`).
    Resetting,
}

/// Decides whether a navigation may proceed and the pin state after it.
fn allow(state: &Pin, url: &Url) -> (bool, Pin) {
    let tauri_local = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    let pinned = match state {
        Pin::Resetting => return (tauri_local, Pin::Resetting),
        Pin::Unpaired => None,
        Pin::Paired(origin) => Some(origin),
    };
    if tauri_local {
        return (pinned.is_none(), state.clone());
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && local)) {
        return (false, state.clone());
    }
    let origin = url.origin().ascii_serialization();
    match pinned {
        None => (true, Pin::Paired(origin)),
        Some(p) => (*p == origin, state.clone()),
    }
}

/// `Resetting` becomes `Unpaired` only once the local page itself has finished loading.
fn on_load(state: &Pin, event: PageLoadEvent, url: &Url) -> Pin {
    let committed = event == PageLoadEvent::Finished && url.scheme() == "tauri" && url.host_str() == Some("localhost");
    if *state == Pin::Resetting && committed { Pin::Unpaired } else { state.clone() }
}

// ⌥-drag anywhere resizes from the nearest corner; ⌘-drag anywhere moves.
// Handled natively: a nonactivating panel's webview can't reliably start drags over IPC,
// and a borderless window's own resize zone is a few pixels and excludes the top edge.
fn handle_mouse(window: &WebviewWindow) {
    let win: *const NSWindow = window.ns_window().unwrap().cast();
    let w = unsafe { &*win };
    // Explicit false also catches clicks on the transparent pixels outside the rounded corners.
    w.setIgnoresMouseEvents(false);
    // AppKit saves the frame on every move/resize; restore it explicitly after the builder placed the panel.
    let name = NSString::from_str("cession-widget");
    w.setFrameAutosaveName(&name);
    w.setFrameUsingName(&name);
    let state = Mouse {
        win,
        id: w.windowNumber(),
        resizing: Cell::new(None),
        hovering: Cell::new(false),
        // Last size of each mode. ponytail: in memory only, so the first toggle after a restart uses defaults.
        full: Cell::new(NSSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1)),
        bar: Cell::new(NSSize::new(BAR_DEFAULT_WIDTH, BAR_HEIGHT)),
        webview: window.clone(),
    };
    let handler = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
        // A handled event is swallowed so the webview never sees it.
        if state.on_event(unsafe { ev.as_ref() }) { std::ptr::null_mut() } else { ev.as_ptr() }
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

/// What the local mouse monitor remembers between events.
struct Mouse {
    win: *const NSWindow,
    id: isize,
    resizing: Cell<Option<(Edge, NSRect, NSPoint)>>,
    hovering: Cell<bool>,
    full: Cell<NSSize>,
    bar: Cell<NSSize>,
    webview: WebviewWindow,
}

impl Mouse {
    fn win(&self) -> &NSWindow {
        unsafe { &*self.win }
    }

    /// True when the event was handled here and must not reach the webview.
    fn on_event(&self, e: &NSEvent) -> bool {
        // The tray icon is also an app window, so match ours by number.
        if e.windowNumber() != self.id && self.resizing.get().is_none() {
            return false;
        }
        let kind = e.r#type();
        if matches!(kind, NSEventType::MouseEntered | NSEventType::MouseExited | NSEventType::MouseMoved) {
            self.set_hover(contains(self.win().frame(), NSEvent::mouseLocation()));
        }
        match kind {
            NSEventType::MouseMoved => self.on_move(e),
            NSEventType::LeftMouseDown => self.on_down(e),
            NSEventType::LeftMouseDragged => self.on_drag(),
            NSEventType::LeftMouseUp => self.resizing.take().is_some(),
            _ => false,
        }
    }

    // WebKit's own :hover is unreliable in an unfocused panel, so the native side drives it.
    fn set_hover(&self, inside: bool) {
        if inside != self.hovering.replace(inside) {
            let _ = self.webview.eval(format!("document.documentElement.classList.toggle('cession-hover', {inside})"));
        }
    }

    fn on_move(&self, e: &NSEvent) -> bool {
        let Some(Hit::Resize(edge)) = hit(self.win().frame().size, e.locationInWindow()) else {
            return false;
        };
        NSCursor::frameResizeCursorFromPosition_inDirections(cursor_position(edge), NSCursorFrameResizeDirections::All).set();
        true
    }

    fn on_down(&self, e: &NSEvent) -> bool {
        let win = self.win();
        let frame = win.frame();
        let Some(target) = press_target(e.modifierFlags(), frame.size, e.locationInWindow()) else {
            return false;
        };
        match target {
            Hit::Resize(edge) => self.resizing.set(Some((edge, frame, NSEvent::mouseLocation()))),
            Hit::Move => win.performWindowDragWithEvent(e),
            Hit::NextScreen => move_to_next_screen(win),
            Hit::Toggle => self.toggle(frame),
            Hit::Hide => self.hide(),
        }
        true
    }

    fn on_drag(&self) -> bool {
        let Some((edge, start, mouse)) = self.resizing.get() else {
            return false;
        };
        let now = NSEvent::mouseLocation();
        self.win().setFrame_display(resized(start, edge, now.x - mouse.x, now.y - mouse.y), true);
        true
    }

    /// Switches between panel and bar, remembering the size of the mode being left.
    fn toggle(&self, frame: NSRect) {
        let win = self.win();
        let (from, to) = if frame.size.height <= BAR_MODE { (&self.bar, &self.full) } else { (&self.full, &self.bar) };
        from.set(frame.size);
        let screen = win.screen().map_or(frame, |s| s.visibleFrame());
        win.setFrame_display(toggled(frame, to.get(), screen), true);
    }

    fn hide(&self) {
        self.win().orderOut(None);
        // No exit event follows, so clear hover or the bar shows on the next Show.
        self.hovering.set(false);
        let _ = self.webview.eval("document.documentElement.classList.remove('cession-hover')");
    }
}

/// What a press does: ⌥ resizes from the nearest corner, ⌘ moves, otherwise whatever is under the pointer.
fn press_target(flags: NSEventModifierFlags, size: NSSize, p: NSPoint) -> Option<Hit> {
    if flags.contains(NSEventModifierFlags::Option) {
        Some(Hit::Resize(nearest_corner(size, p)))
    } else if flags.contains(NSEventModifierFlags::Command) {
        Some(Hit::Move)
    } else {
        hit(size, p)
    }
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
    fn press_target_modifiers() {
        let size = NSSize::new(400.0, 600.0);
        let middle = NSPoint::new(300.0, 100.0);
        // ⌥ grabs the nearest corner, ⌘ moves, and a plain press in the body does nothing.
        assert_eq!(press_target(NSEventModifierFlags::Option, size, middle), Some(Hit::Resize((1, -1))));
        assert_eq!(press_target(NSEventModifierFlags::Command, size, middle), Some(Hit::Move));
        assert_eq!(press_target(NSEventModifierFlags::empty(), size, middle), None);
        assert_eq!(press_target(NSEventModifierFlags::empty(), size, NSPoint::new(200.0, 590.0)), hit(size, NSPoint::new(200.0, 590.0)));
    }

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
        let srv = Pin::Paired("https://cession.example.workers.dev".to_string());
        assert_eq!(allow(&Pin::Unpaired, &u("tauri://localhost/index.html")), (true, Pin::Unpaired));
        assert_eq!(allow(&Pin::Unpaired, &u("https://cession.example.workers.dev/auth/pair")), (true, srv.clone()));
        assert_eq!(allow(&srv, &u("https://cession.example.workers.dev/")), (true, srv.clone()));
        assert_eq!(allow(&srv, &u("https://evil.example/")), (false, srv.clone()));
        // Paired: tauri://localhost is denied and the pin stays, since only the tray handler may start a reset.
        assert_eq!(allow(&srv, &u("tauri://localhost/index.html#pair")), (false, srv.clone()));
        assert_eq!(allow(&Pin::Unpaired, &u("http://example.com/")), (false, Pin::Unpaired));
        assert_eq!(
            allow(&Pin::Unpaired, &u("http://localhost:8787/")),
            (true, Pin::Paired("http://localhost:8787".into()))
        );
        assert_eq!(allow(&Pin::Unpaired, &u("file:///etc/passwd")), (false, Pin::Unpaired));
        for bad in ["data:text/html,hi", "blob:https://cession.example.workers.dev/x", "javascript:alert(1)"] {
            assert_eq!(allow(&srv, &u(bad)), (false, srv.clone()), "{bad}");
        }

        // Resetting: only tauri://localhost is allowed, and the state doesn't change until the page commits.
        assert_eq!(allow(&Pin::Resetting, &u("https://evil.example/")), (false, Pin::Resetting));
        assert_eq!(allow(&Pin::Resetting, &u("tauri://localhost/index.html#pair")), (true, Pin::Resetting));
        assert_eq!(
            on_load(&Pin::Resetting, PageLoadEvent::Started, &u("tauri://localhost/index.html#pair")),
            Pin::Resetting
        );
        assert_eq!(
            on_load(&Pin::Resetting, PageLoadEvent::Finished, &u("https://evil.example/")),
            Pin::Resetting
        );
        assert_eq!(
            on_load(&Pin::Resetting, PageLoadEvent::Finished, &u("tauri://localhost/index.html#pair")),
            Pin::Unpaired
        );
        // A load finish outside a reset never changes the pin.
        assert_eq!(
            on_load(&srv, PageLoadEvent::Finished, &u("tauri://localhost/index.html")),
            srv
        );
    }

    #[test]
    fn reset_url_forces_distinct_urls() {
        let a = reset_url(1);
        let b = reset_url(2);
        assert_ne!(a, b);
        for url in [&a, &b] {
            assert_eq!(url.scheme(), "tauri");
            assert_eq!(url.host_str(), Some("localhost"));
            assert_eq!(url.fragment(), Some("pair"));
        }
    }
}

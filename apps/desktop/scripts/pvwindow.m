// libpvwindow.dylib — the menu-bar buddy's native window.
//
// Neutralino gives PassVault one ordinary window. An ordinary window cannot be
// what the buddy needs: round and truly transparent, above every app, on every
// desktop and over other apps' full-screen spaces (macOS allows that only for
// non-activating panels, the kind launchers use). This library is linked into
// PassVault's Neutralino shell (scripts/add-load-command.py adds an
// LC_LOAD_DYLIB at build time — no DYLD_* environment variables, compatible
// with the hardened runtime).
//
// How: the UI asks for the buddy by making the window always-on-top
// (window.setAlwaysOnTop → -[NSWindow setLevel:] above normal). Then the app
// window's content — the same WKWebView, with its page, vault session and
// Neutralino connection — is moved into a borderless, transparent,
// non-activating panel at status-bar level that joins every desktop and
// full-screen space. While that lasts, the app window stays hidden and stands
// in for the panel: Neutralino's size/position/show/hide/drag calls on it are
// forwarded to the panel, and the panel's position is mirrored back, so the
// UI code needs no changes. When the level returns to normal (Open PassVault),
// the content moves back into the app window.
//
// It also fixes quitting. Neutralino's app.exit tears the menu-bar (status)
// item down on its server thread, which current macOS aborts on (main-queue
// assertion / autorelease-pool corruption). The page gets one script message
// instead — webkit.messageHandlers.pvNative.postMessage({ cmd: 'quit' }),
// accepted only from the app's own page (main frame, Neutralino's loopback
// origin) — which quits through -[NSApplication terminate:], so Neutralino's
// teardown never runs; the helper exits when its parent is gone.
//
// And it owns the menu-bar item: { cmd: 'tray', items } from the same page builds
// it on the main thread (Neutralino's os.setTray shows nothing on current macOS).
//
// Only PassVault's own app window is involved (the titled window that hosts
// the WKWebView); menus, tooltips, sheets and system windows pass through
// untouched. Nothing else is read or changed: no page content, no data.

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

@interface PVBuddyPanel : NSPanel
@end

@implementation PVBuddyPanel
// Borderless panels refuse key status by default; the buddy has text fields.
- (BOOL)canBecomeKeyWindow {
    return YES;
}
- (BOOL)canBecomeMainWindow {
    return NO;
}
@end

static NSWindow *gMain;       // the app window while the buddy is out
static PVBuddyPanel *gPanel;  // the buddy panel (created once)
static BOOL gFloating;        // buddy mode
static BOOL gSyncing;         // guard against frame mirroring loops
static id gMoveObserver, gResizeObserver;

typedef void (*SetLevelIMP)(id, SEL, NSInteger);
typedef void (*SetFrameIMP)(id, SEL, NSRect, BOOL);
typedef void (*OrderIMP)(id, SEL, NSWindowOrderingMode, NSInteger);
typedef void (*VoidIMP)(id, SEL);
typedef BOOL (*BoolIMP)(id, SEL);
typedef void (*DragIMP)(id, SEL, NSEvent *);
typedef void (*StyleIMP)(id, SEL, NSWindowStyleMask);

static SetLevelIMP oSetLevel;
static SetFrameIMP oSetFrame;
static OrderIMP oOrder;
static VoidIMP oMakeKey;
static BoolIMP oIsVisible;
static DragIMP oDrag;
static StyleIMP oSetStyle;

static NSView *PVFindWebView(NSView *root) {
    Class wk = NSClassFromString(@"WKWebView");
    if (!root || !wk) return nil;
    if ([root isKindOfClass:wk]) return root;
    for (NSView *v in root.subviews) {
        NSView *found = PVFindWebView(v);
        if (found) return found;
    }
    return nil;
}

static BOOL PVIsAppWindow(NSWindow *w) {
    if (w == (NSWindow *)gPanel || [w isKindOfClass:[NSPanel class]]) return NO;
    if (gFloating && w == gMain) return YES;
    if (!(w.styleMask & NSWindowStyleMaskTitled)) return NO;
    return PVFindWebView(w.contentView) != nil;
}

static void PVSetWebBackground(NSView *web, BOOL draws) {
    if (!web) return;
    @try {
        [web setValue:@(draws) forKey:@"drawsBackground"];
    } @catch (NSException *e) {
        (void)e;
    }
}

static PVBuddyPanel *PVPanel(void) {
    if (gPanel) return gPanel;
    gPanel = [[PVBuddyPanel alloc] initWithContentRect:NSMakeRect(0, 0, 96, 96)
                                             styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    gPanel.floatingPanel = YES; // (sets the floating level — so set ours after it)
    gPanel.level = NSStatusWindowLevel;
    gPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
                                NSWindowCollectionBehaviorIgnoresCycle;
    gPanel.hidesOnDeactivate = NO;
    gPanel.becomesKeyOnlyIfNeeded = NO;
    gPanel.opaque = NO;
    gPanel.backgroundColor = NSColor.clearColor;
    gPanel.hasShadow = NO; // the buddy draws its own rounded shadow
    gPanel.releasedWhenClosed = NO;
    gPanel.movableByWindowBackground = NO;
    [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidMoveNotification
                                                      object:gPanel
                                                       queue:nil
                                                  usingBlock:^(NSNotification *n) {
                                                      (void)n;
                                                      // Mirror the panel position into the stand-in app window,
                                                      // where Neutralino reads it (window.getPosition).
                                                      if (!gFloating || !gMain || gSyncing) return;
                                                      gSyncing = YES;
                                                      oSetFrame(gMain, @selector(setFrame:display:), gPanel.frame, NO);
                                                      gSyncing = NO;
                                                  }];
    return gPanel;
}

/** Neutralino moves/resizes the stand-in app window (by whichever AppKit call); follow it. */
static void PVFollowMain(void) {
    if (!gFloating || !gMain || gSyncing) return;
    gSyncing = YES;
    oSetFrame(gPanel, @selector(setFrame:display:), gMain.frame, YES);
    gSyncing = NO;
}

static void PVEnterBuddy(NSWindow *w) {
    if (gFloating) return;
    PVBuddyPanel *p = PVPanel();
    BOOL wasVisible = oIsVisible(w, @selector(isVisible));
    gFloating = YES;
    gMain = w;
    NSView *content = w.contentView;
    w.contentView = [[NSView alloc] initWithFrame:content.frame];
    p.contentView = content;
    PVSetWebBackground(PVFindWebView(content), NO);
    gSyncing = YES;
    oSetFrame(p, @selector(setFrame:display:), w.frame, YES);
    gSyncing = NO;
    oOrder(w, @selector(orderWindow:relativeTo:), NSWindowOut, 0);
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    gMoveObserver = [nc addObserverForName:NSWindowDidMoveNotification object:w queue:nil usingBlock:^(NSNotification *n) { (void)n; PVFollowMain(); }];
    gResizeObserver = [nc addObserverForName:NSWindowDidResizeNotification object:w queue:nil usingBlock:^(NSNotification *n) { (void)n; PVFollowMain(); }];
    if (wasVisible) {
        [p orderFrontRegardless];
        oMakeKey(p, @selector(makeKeyWindow));
        [p makeFirstResponder:PVFindWebView(content)];
    }
    // A menu-bar (accessory) app while the buddy is out: no Dock icon.
    if (NSApp.activationPolicy != NSApplicationActivationPolicyAccessory) [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
}

static void PVLeaveBuddy(void) {
    if (!gFloating) return;
    gFloating = NO;
    NSWindow *w = gMain;
    if (gMoveObserver) [[NSNotificationCenter defaultCenter] removeObserver:gMoveObserver];
    if (gResizeObserver) [[NSNotificationCenter defaultCenter] removeObserver:gResizeObserver];
    gMoveObserver = gResizeObserver = nil;
    PVBuddyPanel *p = gPanel;
    NSView *content = p.contentView;
    p.contentView = [[NSView alloc] initWithFrame:NSZeroRect];
    oOrder(p, @selector(orderWindow:relativeTo:), NSWindowOut, 0);
    PVSetWebBackground(PVFindWebView(content), YES);
    w.contentView = content;
    gMain = nil;
    if (NSApp.activationPolicy != NSApplicationActivationPolicyRegular) [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
}

static void PVSetLevel(id self, SEL _cmd, NSInteger level) {
    NSWindow *w = (NSWindow *)self;
    if (!PVIsAppWindow(w)) return oSetLevel(self, _cmd, level);
    if (level > NSNormalWindowLevel) {
        PVEnterBuddy(w);
        return; // the stand-in app window keeps its normal level (hidden)
    }
    PVLeaveBuddy();
    oSetLevel(self, _cmd, level);
}

static void PVSetFrame(id self, SEL _cmd, NSRect frame, BOOL display) {
    oSetFrame(self, _cmd, frame, display);
    if (gFloating && self == gMain && !gSyncing) {
        gSyncing = YES;
        oSetFrame(gPanel, _cmd, frame, display);
        gSyncing = NO;
    }
}

static void PVOrder(id self, SEL _cmd, NSWindowOrderingMode place, NSInteger other) {
    if (gFloating && self == gMain) {
        if (place == NSWindowOut) {
            oOrder(gPanel, _cmd, NSWindowOut, 0);
        } else {
            [gPanel orderFrontRegardless];
            oMakeKey(gPanel, @selector(makeKeyWindow));
        }
        return; // the stand-in app window stays hidden
    }
    oOrder(self, _cmd, place, other);
}

static void PVMakeKey(id self, SEL _cmd) {
    if (gFloating && self == gMain) {
        oMakeKey(gPanel, _cmd);
        return;
    }
    oMakeKey(self, _cmd);
}

static BOOL PVIsVisible(id self, SEL _cmd) {
    if (gFloating && self == gMain) return oIsVisible(gPanel, _cmd);
    return oIsVisible(self, _cmd);
}

static void PVDrag(id self, SEL _cmd, NSEvent *event) {
    if (gFloating && self == gMain) {
        oDrag(gPanel, _cmd, event);
        return;
    }
    oDrag(self, _cmd, event);
}

// While the buddy is out the app window is a hidden stand-in. Neutralino's
// setSize toggles its style mask (resizable); AppKit raises on that for the
// swapped-out window, so the change is ignored — it has no visible effect, and
// the full window's style is set again when it comes back.
static void PVSetStyle(id self, SEL _cmd, NSWindowStyleMask mask) {
    if (gFloating && self == gMain) return;
    oSetStyle(self, _cmd, mask);
}

typedef void (*RemoveItemIMP)(id, SEL, NSStatusItem *);
static RemoveItemIMP oRemoveItem;

static void PVRemoveStatusItem(id self, SEL _cmd, NSStatusItem *item) {
    if (![NSThread isMainThread]) return; // quitting from Neutralino's server thread
    oRemoveItem(self, _cmd, item);
}

// ---------------------------------------------------------------- quit bridge

// ---------------------------------------------------------------- menu-bar item
// Neutralino's os.setTray builds its NSStatusItem on its server thread; current
// macOS silently shows nothing for it. The page sends the menu here instead
// ({ cmd: 'tray', items: [{ id, text, isDisabled }] }, text '-' = separator) and
// the item is built on the main thread. A click dispatches a 'pv-tray' DOM event
// carrying only the item's id back to the page.

static NSStatusItem *gTray;
static __weak WKWebView *gTrayWeb;

@interface PVTrayTarget : NSObject
@end

@implementation PVTrayTarget
- (void)pick:(NSMenuItem *)item {
    NSString *ident = item.representedObject;
    WKWebView *web = gTrayWeb;
    if (![ident isKindOfClass:[NSString class]] || !web) return;
    NSData *json = [NSJSONSerialization dataWithJSONObject:@[ ident ] options:0 error:nil];
    if (!json) return;
    NSString *arg = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    NSString *js = [NSString stringWithFormat:@"window.dispatchEvent(new CustomEvent('pv-tray', { detail: %@[0] }))", arg];
    [web evaluateJavaScript:js completionHandler:nil];
}
@end

static PVTrayTarget *gTrayTarget;

static void PVSetTray(NSArray *items, WKWebView *web) {
    gTrayWeb = web;
    if (!gTray) {
        gTray = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
        NSImage *icon = [NSImage imageWithSystemSymbolName:@"lock.shield" accessibilityDescription:@"PassVault"];
        icon.template = YES;
        gTray.button.image = icon;
        gTray.button.toolTip = @"PassVault";
        gTrayTarget = [PVTrayTarget new];
    }
    NSMenu *menu = [NSMenu new];
    menu.autoenablesItems = NO;
    NSUInteger n = 0;
    for (id raw in items) {
        if (++n > 40 || ![raw isKindOfClass:[NSDictionary class]]) continue;
        NSDictionary *d = raw;
        NSString *text = [d[@"text"] isKindOfClass:[NSString class]] ? d[@"text"] : nil;
        NSString *ident = [d[@"id"] isKindOfClass:[NSString class]] ? d[@"id"] : nil;
        if (!text) continue;
        if ([text isEqualToString:@"-"]) {
            [menu addItem:[NSMenuItem separatorItem]];
            continue;
        }
        if (text.length > 120) text = [text substringToIndex:120];
        NSMenuItem *mi = [[NSMenuItem alloc] initWithTitle:text action:@selector(pick:) keyEquivalent:@""];
        mi.target = gTrayTarget;
        mi.representedObject = ident;
        mi.enabled = ident.length > 0 && ![d[@"isDisabled"] isEqual:@YES];
        [menu addItem:mi];
    }
    gTray.menu = menu;
}

@interface PVNativeBridge : NSObject <WKScriptMessageHandler>
@end

@implementation PVNativeBridge
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)controller;
    if (!message.frameInfo.isMainFrame) return;
    WKSecurityOrigin *o = message.frameInfo.securityOrigin;
    if (![o.protocol isEqualToString:@"http"] || !([o.host isEqualToString:@"127.0.0.1"] || [o.host isEqualToString:@"localhost"])) return;
    NSDictionary *body = [message.body isKindOfClass:[NSDictionary class]] ? message.body : nil;
    if ([body[@"cmd"] isEqual:@"quit"]) {
        PVLeaveBuddy();
        [NSApp terminate:nil];
    } else if ([body[@"cmd"] isEqual:@"tray"] && [body[@"items"] isKindOfClass:[NSArray class]]) {
        PVSetTray(body[@"items"], message.webView);
    }
}
@end

static PVNativeBridge *gBridge;

static void PVInstallBridge(void) {
    if (gBridge) return;
    for (NSWindow *w in NSApp.windows) {
        NSView *web = PVFindWebView(w.contentView);
        if (gFloating && gPanel && !web) web = PVFindWebView(gPanel.contentView);
        if ([web isKindOfClass:[WKWebView class]]) {
            gBridge = [PVNativeBridge new];
            [((WKWebView *)web).configuration.userContentController addScriptMessageHandler:gBridge name:@"pvNative"];
            return;
        }
    }
    // The web view is created a moment after launch: try again shortly.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(300 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
        PVInstallBridge();
    });
}

static IMP PVSwap(SEL sel, IMP replacement) {
    Method m = class_getInstanceMethod([NSWindow class], sel);
    return m ? method_setImplementation(m, replacement) : NULL;
}

__attribute__((constructor)) static void PVInstall(void) {
    oSetLevel = (SetLevelIMP)PVSwap(@selector(setLevel:), (IMP)PVSetLevel);
    oSetFrame = (SetFrameIMP)PVSwap(@selector(setFrame:display:), (IMP)PVSetFrame);
    oOrder = (OrderIMP)PVSwap(@selector(orderWindow:relativeTo:), (IMP)PVOrder);
    oMakeKey = (VoidIMP)PVSwap(@selector(makeKeyWindow), (IMP)PVMakeKey);
    oIsVisible = (BoolIMP)PVSwap(@selector(isVisible), (IMP)PVIsVisible);
    oDrag = (DragIMP)PVSwap(@selector(performWindowDragWithEvent:), (IMP)PVDrag);
    oSetStyle = (StyleIMP)PVSwap(@selector(setStyleMask:), (IMP)PVSetStyle);
    Method rm = class_getInstanceMethod([NSStatusBar class], @selector(removeStatusItem:));
    if (rm) oRemoveItem = (RemoveItemIMP)method_setImplementation(rm, (IMP)PVRemoveStatusItem);
    dispatch_async(dispatch_get_main_queue(), ^{
        PVInstallBridge();
    });
    // Quitting while the buddy is out: put the content back into the app window first,
    // so Neutralino tears down the window it created.
    [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationWillTerminateNotification
                                                      object:nil
                                                       queue:nil
                                                  usingBlock:^(NSNotification *n) {
                                                      (void)n;
                                                      PVLeaveBuddy();
                                                  }];
}

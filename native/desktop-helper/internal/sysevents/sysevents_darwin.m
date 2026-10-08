// System lock/sleep observers and the global shortcut for pv-helper (darwin only).
//
// Observers are registered on the process main thread, which then runs the
// application event loop for the life of the process (Go code runs on other
// threads). NSWorkspace notifications are delivered on the main thread,
// distributed notifications through the run loop of the thread that
// registered them, and the global shortcut (Carbon RegisterEventHotKey: no
// Accessibility permission, the key press is never seen by any other code)
// through the application event target. The helper is a background agent:
// activation policy "prohibited" — no Dock icon, no menu bar, no windows.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#include "sysevents_darwin.h"

extern void pvSysEvent(int code);

static NSMutableArray *gTestNames;
static NSMutableArray *gTestCodes;

void pv_sysevents_add_test_name(const char *name, int code) {
    @autoreleasepool {
        if (!gTestNames) {
            gTestNames = [NSMutableArray array];
            gTestCodes = [NSMutableArray array];
        }
        [gTestNames addObject:[NSString stringWithUTF8String:name]];
        [gTestCodes addObject:@(code)];
    }
}

static EventHotKeyRef gHotKey;
static const OSType kPVHotKeySignature = 'PVhk';

static OSStatus hotKeyHandler(EventHandlerCallRef next, EventRef event, void *userData) {
    EventHotKeyID hk;
    if (GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(hk), NULL, &hk) == noErr &&
        hk.signature == kPVHotKeySignature) {
        pvSysEvent(PV_HOTKEY);
    }
    return noErr;
}

// Registers (or replaces) the one global shortcut. Runs on the main thread.
int pv_hotkey_set(unsigned int keyCode, unsigned int modifiers) {
    __block OSStatus st = noErr;
    dispatch_sync(dispatch_get_main_queue(), ^{
        if (gHotKey) {
            UnregisterEventHotKey(gHotKey);
            gHotKey = NULL;
        }
        EventHotKeyID hk = { kPVHotKeySignature, 1 };
        st = RegisterEventHotKey(keyCode, modifiers, hk, GetApplicationEventTarget(), 0, &gHotKey);
        if (st != noErr) gHotKey = NULL;
    });
    return (int)st;
}

void pv_hotkey_clear(void) {
    dispatch_sync(dispatch_get_main_queue(), ^{
        if (gHotKey) UnregisterEventHotKey(gHotKey);
        gHotKey = NULL;
    });
}

// Tests: deliver a synthetic "hot key pressed" event through the real event path.
int pv_hotkey_post_test(void) {
    __block OSStatus st = noErr;
    dispatch_sync(dispatch_get_main_queue(), ^{
        EventRef ev = NULL;
        st = CreateEvent(NULL, kEventClassKeyboard, kEventHotKeyPressed, 0, kEventAttributeNone, &ev);
        if (st != noErr) return;
        EventHotKeyID hk = { kPVHotKeySignature, 1 };
        SetEventParameter(ev, kEventParamDirectObject, typeEventHotKeyID, sizeof(hk), &hk);
        st = SendEventToEventTarget(ev, GetApplicationEventTarget());
        ReleaseEvent(ev);
    });
    return (int)st;
}

static void observeDistributed(NSString *name, int code) {
    [[NSDistributedNotificationCenter defaultCenter]
        addObserverForName:name object:nil queue:nil
                usingBlock:^(NSNotification *n) { pvSysEvent(code); }];
}

void pv_sysevents_run_main(void) {
    @autoreleasepool {
        observeDistributed(@"com.apple.screenIsLocked", PV_SCREEN_LOCKED);
        observeDistributed(@"com.apple.screenIsUnlocked", PV_SCREEN_UNLOCKED);
        for (NSUInteger i = 0; i < gTestNames.count; i++) {
            observeDistributed(gTestNames[i], [gTestCodes[i] intValue]);
        }
        NSNotificationCenter *wc = [[NSWorkspace sharedWorkspace] notificationCenter];
        [wc addObserverForName:NSWorkspaceWillSleepNotification object:nil queue:nil
                    usingBlock:^(NSNotification *n) { pvSysEvent(PV_WILL_SLEEP); }];
        [wc addObserverForName:NSWorkspaceDidWakeNotification object:nil queue:nil
                    usingBlock:^(NSNotification *n) { pvSysEvent(PV_DID_WAKE); }];
        EventTypeSpec spec = { kEventClassKeyboard, kEventHotKeyPressed };
        InstallApplicationEventHandler(NewEventHandlerUPP(hotKeyHandler), 1, &spec, NULL, NULL);
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        pvSysEvent(PV_READY);
    }
    [NSApp run];
}

void pv_sysevents_post_test(const char *name) {
    @autoreleasepool {
        [[NSDistributedNotificationCenter defaultCenter]
            postNotificationName:[NSString stringWithUTF8String:name]
                          object:nil userInfo:nil deliverImmediately:YES];
    }
}

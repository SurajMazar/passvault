// System lock/sleep observers for pv-helper (darwin only).
//
// Observers are registered on the process main thread, which then runs the
// main CFRunLoop for the life of the process (Go code runs on other
// threads). NSWorkspace notifications are delivered on the main thread, and
// distributed notifications are delivered through the run loop of the thread
// that registered them.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
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
        pvSysEvent(PV_READY);
    }
    CFRunLoopRun();
}

void pv_sysevents_post_test(const char *name) {
    @autoreleasepool {
        [[NSDistributedNotificationCenter defaultCenter]
            postNotificationName:[NSString stringWithUTF8String:name]
                          object:nil userInfo:nil deliverImmediately:YES];
    }
}

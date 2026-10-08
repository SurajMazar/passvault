// Keychain + LocalAuthentication bridge for pv-helper (darwin only).
// Compiled by cgo with -fobjc-arc.

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <stdlib.h>
#include <string.h>
#include "keychain_darwin.h"

static NSString *const kPVService = @"io.passvault.desktop";

static NSMutableDictionary *baseQuery(const char *account, BOOL dataProtection) {
    NSMutableDictionary *q = [NSMutableDictionary dictionary];
    q[(__bridge id)kSecClass] = (__bridge id)kSecClassGenericPassword;
    q[(__bridge id)kSecAttrService] = kPVService;
    q[(__bridge id)kSecAttrAccount] = [NSString stringWithUTF8String:account];
    if (dataProtection) {
        q[(__bridge id)kSecUseDataProtectionKeychain] = @YES;
    }
    return q;
}

static int deleteOne(const char *account, BOOL dataProtection) {
    NSMutableDictionary *q = baseQuery(account, dataProtection);
    return (int)SecItemDelete((__bridge CFDictionaryRef)q);
}

int pv_kc_delete(const char *account) {
    @autoreleasepool {
        int a = deleteOne(account, YES);
        int b = deleteOne(account, NO);
        if (a == errSecSuccess || b == errSecSuccess) return errSecSuccess;
        if (b == errSecItemNotFound && (a == errSecItemNotFound || a == errSecMissingEntitlement)) return errSecItemNotFound;
        if (b != errSecItemNotFound) return b;
        return a;
    }
}

int pv_kc_set(const char *account, const void *data, int len, int biometric) {
    @autoreleasepool {
        // Remove any previous item in either keychain first (access control
        // cannot be changed with SecItemUpdate).
        int d = pv_kc_delete(account);
        if (d != errSecSuccess && d != errSecItemNotFound && d != errSecMissingEntitlement) return d;
        NSData *value = [NSData dataWithBytes:data length:(NSUInteger)len];
        NSMutableDictionary *q = baseQuery(account, biometric ? YES : NO);
        q[(__bridge id)kSecValueData] = value;
        q[(__bridge id)kSecAttrLabel] = @"PassVault";
        if (biometric) {
            CFErrorRef err = NULL;
            SecAccessControlRef ac = SecAccessControlCreateWithFlags(
                kCFAllocatorDefault,
                kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                kSecAccessControlBiometryCurrentSet,
                &err);
            if (ac == NULL) {
                if (err) CFRelease(err);
                return errSecParam;
            }
            q[(__bridge id)kSecAttrAccessControl] = (__bridge_transfer id)ac;
        }
        OSStatus st = SecItemAdd((__bridge CFDictionaryRef)q, NULL);
        return (int)st;
    }
}

static int copyOne(const char *account, BOOL dataProtection, const char *reason, void **out, int *outLen) {
    NSMutableDictionary *q = baseQuery(account, dataProtection);
    q[(__bridge id)kSecReturnData] = @YES;
    q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
    if (dataProtection) {
        LAContext *ctx = [[LAContext alloc] init];
        NSString *r = (reason && reason[0]) ? [NSString stringWithUTF8String:reason] : @"unlock PassVault";
        ctx.localizedReason = r;
        q[(__bridge id)kSecUseAuthenticationContext] = ctx;
    }
    CFTypeRef result = NULL;
    OSStatus st = SecItemCopyMatching((__bridge CFDictionaryRef)q, &result);
    if (st != errSecSuccess) return (int)st;
    NSData *d = (__bridge_transfer NSData *)result;
    *outLen = (int)d.length;
    *out = malloc(d.length > 0 ? d.length : 1);
    if (*out == NULL) return errSecAllocate;
    memcpy(*out, d.bytes, d.length);
    return errSecSuccess;
}

int pv_kc_get(const char *account, const char *reason, void **out, int *outLen) {
    @autoreleasepool {
        *out = NULL;
        *outLen = 0;
        int st = copyOne(account, YES, reason, out, outLen);
        if (st == errSecItemNotFound || st == errSecMissingEntitlement) {
            st = copyOne(account, NO, reason, out, outLen);
        }
        return st;
    }
}

// Returns 1 when biometrics can be evaluated; on 0 writes an LAError code.
int pv_bio_can_evaluate(int *laError) {
    @autoreleasepool {
        LAContext *ctx = [[LAContext alloc] init];
        NSError *err = nil;
        BOOL ok = [ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&err];
        *laError = ok ? 0 : (int)err.code;
        return ok ? 1 : 0;
    }
}

// Probes the data-protection keychain without UI by adding (and immediately
// deleting) an empty, non-secret marker item. Reads alone return
// errSecItemNotFound even without entitlements; SecItemAdd returns
// errSecMissingEntitlement (-34018) when the binary lacks a
// keychain-access-groups / application-identifier entitlement.
int pv_kc_probe_dp(void) {
    @autoreleasepool {
        const char *probe = "pv.__entitlement_probe__";
        NSMutableDictionary *q = baseQuery(probe, YES);
        q[(__bridge id)kSecValueData] = [NSData data];
        q[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleWhenUnlockedThisDeviceOnly;
        OSStatus st = SecItemAdd((__bridge CFDictionaryRef)q, NULL);
        if (st == errSecSuccess || st == errSecDuplicateItem) {
            deleteOne(probe, YES);
            return errSecSuccess;
        }
        return (int)st;
    }
}

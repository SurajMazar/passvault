#ifndef PV_KEYCHAIN_DARWIN_H
#define PV_KEYCHAIN_DARWIN_H

int pv_kc_set(const char *account, const void *data, int len, int biometric);
int pv_kc_get(const char *account, const char *reason, void **out, int *outLen);
int pv_kc_delete(const char *account);
int pv_bio_can_evaluate(int *laError);
int pv_kc_probe_dp(void);

#endif

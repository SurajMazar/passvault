#ifndef PV_SYSEVENTS_DARWIN_H
#define PV_SYSEVENTS_DARWIN_H

#define PV_READY 0
#define PV_SCREEN_LOCKED 1
#define PV_SCREEN_UNLOCKED 2
#define PV_WILL_SLEEP 3
#define PV_DID_WAKE 4
#define PV_HOTKEY 5

void pv_sysevents_add_test_name(const char *name, int code);
void pv_sysevents_run_main(void);
void pv_sysevents_post_test(const char *name);
int pv_hotkey_set(unsigned int keyCode, unsigned int modifiers);
void pv_hotkey_clear(void);
int pv_hotkey_post_test(void);

#endif

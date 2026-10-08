/** Port name for the popup ↔ background state channel. */
export const POPUP_PORT = 'pv-popup';
/** `target` of messages from the background to the offscreen document (they never carry secrets). */
export const OFFSCREEN_TARGET = 'pv-offscreen';

/** Chrome native-messaging host of PassVault for Mac (pv-touchid): Touch ID unlock. */
export const TOUCH_ID_HOST = 'io.passvault.touchid';

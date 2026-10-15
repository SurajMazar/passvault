import type { WifiFields } from '@passvault/types';

/**
 * The text of a "join this network" QR code (the format phone cameras read):
 *   WIFI:T:WPA;S:<name>;P:<password>;H:true;;
 * Backslash, semicolon, comma, colon and double quote are escaped with a backslash.
 */
export function wifiQrText(f: Pick<WifiFields, 'ssid' | 'password' | 'security' | 'hidden'>): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, '\\$1');
  const t = f.security === 'wpa' ? 'WPA' : f.security === 'wep' ? 'WEP' : 'nopass';
  return `WIFI:T:${t};S:${esc(f.ssid)};${t === 'nopass' ? '' : `P:${esc(f.password)};`}${f.hidden ? 'H:true;' : ''};`;
}

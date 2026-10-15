import { describe, expect, it } from 'vitest';
import { computeInsights, itemSubtitle, newItem, searchableText, wifiQrText } from '../src/index';

describe('wifi networks', () => {
  it('builds the join-network QR text with escaping', () => {
    expect(wifiQrText({ ssid: 'Home', password: 'pass word', security: 'wpa', hidden: false })).toBe('WIFI:T:WPA;S:Home;P:pass word;;');
    expect(wifiQrText({ ssid: 'Café;"1"', password: 'a:b,c\\d', security: 'wep', hidden: true })).toBe(String.raw`WIFI:T:WEP;S:Café\;\"1\";P:a\:b\,c\\d;H:true;;`);
    expect(wifiQrText({ ssid: 'Guest', password: 'ignored', security: 'none', hidden: false })).toBe('WIFI:T:nopass;S:Guest;;');
  });

  it('shows and finds the network name, never the password', () => {
    const p = newItem('wifi', { title: 'Office', fields: { ssid: 'Office-5G', password: 'tr0ub4dor&3-office', security: 'wpa', hidden: true } });
    expect(itemSubtitle(p)).toBe('Office-5G · WPA · hidden');
    const text = searchableText(p);
    expect(text).toContain('office-5g');
    expect(text).not.toContain('tr0ub4dor');
  });

  it('counts Wi-Fi passwords in the weak and reused checks', () => {
    const wifi = newItem('wifi', { title: 'Home', fields: { ssid: 'Home', password: 'password1', security: 'wpa', hidden: false } });
    const login = newItem('login', { title: 'Shop', fields: { username: 'a', password: 'password1', urls: [] } });
    const r = computeInsights([
      { id: 'w', payload: wifi },
      { id: 'l', payload: login },
    ]);
    expect(r.weak.map((x) => x.id)).toContain('w');
    expect(r.reused.some((g) => g.ids.includes('w') && g.ids.includes('l'))).toBe(true);
  });
});

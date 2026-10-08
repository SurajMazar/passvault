import { describe, expect, it } from 'vitest';
import { buildManifest } from '../vite.config';

describe('generated manifest', () => {
  it('is MV3 with minimal permissions and only the API host', () => {
    const m = buildManifest('https://api.passvault.example:8443/some/path');
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect([...m.permissions].sort()).toEqual(['activeTab', 'alarms', 'clipboardWrite', 'offscreen', 'scripting', 'storage']);
    expect(m.host_permissions).toEqual(['https://api.passvault.example:8443/*']);
    // All-sites access is OPTIONAL: requested only when the user enables "Offer to save passwords".
    expect(m.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(m.content_security_policy.extension_pages).toBe("script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
    const json = JSON.stringify(m);
    for (const forbidden of ['<all_urls>', '"tabs"', 'webRequest', 'nativeMessaging', 'content_scripts', 'externally_connectable', 'web_accessible_resources']) {
      expect(json).not.toContain(forbidden);
    }
  });
  it('rejects non-http API URLs', () => {
    expect(() => buildManifest('ftp://example.com')).toThrow();
  });
});

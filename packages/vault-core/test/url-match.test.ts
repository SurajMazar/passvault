import { describe, expect, it } from 'vitest';
import { matchLogin, matchUrl } from '../src/url-match';

describe('URL matching for autofill', () => {
  it('host mode requires exact host and port', () => {
    const saved = { url: 'https://app.example.com', match: 'host' as const };
    expect(matchUrl(saved, 'https://app.example.com/login').matches).toBe(true);
    expect(matchUrl(saved, 'https://evil-app.example.com/').matches).toBe(false);
    expect(matchUrl(saved, 'https://app.example.com.evil.test/').matches).toBe(false);
    expect(matchUrl(saved, 'https://app.example.com:8443/').matches).toBe(false);
    expect(matchUrl(saved, 'https://example.com/').matches).toBe(false);
  });

  it('base domain uses the public suffix list', () => {
    const saved = { url: 'example.co.uk', match: 'base_domain' as const };
    expect(matchUrl(saved, 'https://login.example.co.uk/').matches).toBe(true);
    expect(matchUrl(saved, 'https://other.co.uk/').matches).toBe(false);
    // github.io is a public suffix: different users' pages must not match
    const gh = { url: 'https://alice.github.io', match: 'base_domain' as const };
    expect(matchUrl(gh, 'https://mallory.github.io/').matches).toBe(false);
  });

  it('never silently matches insecure pages', () => {
    const saved = { url: 'https://example.com', match: 'base_domain' as const };
    const r = matchUrl(saved, 'http://example.com/');
    expect(r.matches).toBe(true);
    expect(r.insecure).toBe(true);
  });

  it('rejects non-web schemes and invalid URLs', () => {
    const saved = { url: 'https://example.com', match: 'base_domain' as const };
    for (const page of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'not a url']) {
      expect(matchUrl(saved, page).matches).toBe(false);
    }
    expect(matchUrl({ url: 'javascript:alert(1)', match: 'starts_with' }, 'https://example.com').matches).toBe(false);
  });

  it('starts_with and exact', () => {
    expect(matchUrl({ url: 'https://example.com/admin', match: 'starts_with' }, 'https://example.com/admin/users').matches).toBe(true);
    expect(matchUrl({ url: 'https://example.com/admin', match: 'starts_with' }, 'https://example.com/public').matches).toBe(false);
    expect(matchUrl({ url: 'https://example.com/a?x=1', match: 'exact' }, 'https://example.com/a?x=1#frag').matches).toBe(true);
    expect(matchUrl({ url: 'https://example.com/a', match: 'exact' }, 'https://example.com/a/b').matches).toBe(false);
  });

  it('never mode disables matching; IPs use exact host', () => {
    expect(matchUrl({ url: 'https://example.com', match: 'never' }, 'https://example.com').matches).toBe(false);
    expect(matchUrl({ url: 'https://10.0.0.5', match: 'base_domain' }, 'https://10.0.0.6').matches).toBe(false);
    expect(matchUrl({ url: 'https://10.0.0.5', match: 'base_domain' }, 'https://10.0.0.5/x').matches).toBe(true);
  });

  it('prefers a secure match among several URLs', () => {
    const r = matchLogin(
      [
        { url: 'http://example.com', match: 'host' },
        { url: 'https://example.com', match: 'host' },
      ],
      'https://example.com/',
    );
    expect(r).toMatchObject({ matches: true, insecure: false });
  });
});

import { siteKey } from '../src/url-match';
describe('siteKey', () => {
  it('groups subdomains of a registrable domain but not across private suffixes', () => {
    expect(siteKey('https://accounts.example.co.uk/login')).toBe('example.co.uk');
    expect(siteKey('https://www.example.co.uk/')).toBe('example.co.uk');
    expect(siteKey('https://alice.github.io/')).not.toBe(siteKey('https://mallory.github.io/'));
    expect(siteKey('http://localhost:3000/')).toBe('localhost');
    expect(siteKey('javascript:alert(1)')).toBeNull();
  });
});

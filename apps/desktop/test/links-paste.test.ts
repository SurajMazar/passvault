import { describe, expect, it, vi } from 'vitest';
import { openExternalConfirmed, parseSafeExternalUrl, shellSafeUrl } from '../src/platform/links';
import { analyzePaste, installPasteGuard, stripControlChars } from '../src/terminal/paste-guard';

describe('external links', () => {
  it('accepts only http(s)', () => {
    expect(parseSafeExternalUrl('https://example.com/a?b=c')?.hostname).toBe('example.com');
    expect(parseSafeExternalUrl('http://localhost:3000')).not.toBeNull();
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ssh://host', 'data:text/html,x', 'x-apple.systempreferences:com.apple', 'vbscript:x', '//example.com', 'https://exa mple.com', 'https://example.com/\nx', ''])
      expect(parseSafeExternalUrl(bad)).toBeNull();
  });

  it('percent-encodes shell-special characters (defence in depth; the helper opens links without a shell)', () => {
    const u = parseSafeExternalUrl('https://example.com/p?q=$(id)&r=`whoami`&s="x"&t=\\y')!;
    const s = shellSafeUrl(u);
    expect(s).not.toMatch(/[$`"\\]/);
    expect(s).toContain('%24(id)');
    expect(s).toContain('%60whoami%60');
  });

  it('opens only after confirmation, and never for non-http(s)', async () => {
    const open = vi.fn(async () => undefined);
    await expect(openExternalConfirmed('https://example.com', { confirm: async () => false, open })).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    await expect(openExternalConfirmed('https://example.com', { confirm: async () => true, open })).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/');
    const confirm = vi.fn(async () => true);
    await expect(openExternalConfirmed('file:///etc/passwd', { confirm, open })).rejects.toThrow(/Only http/);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('paste guard', () => {
  it('single plain line passes without confirmation', () => {
    expect(analyzePaste('ls -la').needsConfirm).toBe(false);
  });

  it('any line break (even a trailing one) needs confirmation', () => {
    expect(analyzePaste('rm -rf /tmp/x\n')).toMatchObject({ needsConfirm: true, multiline: true, lineCount: 1 });
    expect(analyzePaste('a\r\nb\r\nc')).toMatchObject({ needsConfirm: true, lineCount: 3, preview: ['a', 'b', 'c'] });
    expect(analyzePaste('a\rb').multiline).toBe(true);
    const big = analyzePaste(Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'));
    expect(big.lineCount).toBe(20);
    expect(big.preview).toHaveLength(5);
  });

  it('control characters need confirmation and are stripped', () => {
    const t = 'echo hi\x1b[201~; curl evil';
    expect(analyzePaste(t)).toMatchObject({ needsConfirm: true, hasControlChars: true });
    expect(analyzePaste(t).preview[0]).toContain('^[');
    expect(stripControlChars(t)).toBe('echo hi[201~; curl evil');
    expect(stripControlChars('a\tb\nc')).toBe('a\tb\nc');
  });

  it('intercepts multi-line pastes in the capture phase and pastes only after confirmation', async () => {
    const container = new EventTarget() as unknown as HTMLElement;
    let answer = true;
    const paste = vi.fn();
    const confirm = vi.fn(async () => answer);
    const off = installPasteGuard(container, { confirm, paste });
    // stands in for xterm's own paste handler, which runs after the capture-phase guard
    const inner = vi.fn();
    container.addEventListener('paste', inner);
    const fire = (text: string) => {
      const e = new Event('paste', { cancelable: true }) as Event & { clipboardData: { getData(): string } };
      Object.defineProperty(e, 'clipboardData', { value: { getData: () => text } });
      container.dispatchEvent(e);
      return e;
    };
    const e1 = fire('one\ntwo\n');
    expect(e1.defaultPrevented).toBe(true);
    expect(inner).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(paste).toHaveBeenCalledWith('one\ntwo\n');
    answer = false;
    fire('three\nfour');
    await Promise.resolve();
    await Promise.resolve();
    expect(paste).toHaveBeenCalledTimes(1);
    const e3 = fire('single line');
    expect(e3.defaultPrevented).toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
    off();
  });
});

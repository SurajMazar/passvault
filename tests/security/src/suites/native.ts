import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { goTest, HELPER_DIR, recordGoTests } from '../lib/gotest';
import { ROOT } from '../lib/paths';
import type { Suite } from '../lib/suite';
import { isMac } from '../lib/suite';
import { gitGrep, run, which } from '../lib/util';

const NAMES: Record<string, string> = {
  TestValidationRejectsInjection: 'IPC parameter validation rejects injection-shaped hosts, users and options',
  TestHost: 'Host names are validated strictly',
  TestUsername: 'User names are validated strictly',
  TestPortAccountID: 'Ports and account ids are validated',
  TestHelloCapabilities: 'IPC handshake advertises only the implemented capabilities',
  TestUnknownOpAndFields: 'IPC refuses unknown operations and unknown fields',
  TestSessionBinding: 'IPC requests are bound to the authenticated UI session',
  TestSecondHelloTearsDownConnections: 'A second handshake tears down existing sessions (no session takeover)',
  TestInvalidHostsAndUsernamesRejected: 'Invalid hosts and user names are refused before connecting',
  TestOversizeRejected: 'Oversized IPC messages are refused',
  TestVaultLockedClosesEverything: 'Locking the vault closes every app-managed SSH session and stops agent signing',
  TestLogsContainNoSecrets: 'Helper logs contain no secrets',
  TestRefusesSymlinkDirAndRegularFile: 'Agent socket path: refuses symlinked directories and pre-existing regular files',
  TestWriteExportMode0600: 'Exports are written with mode 0600',
  TestWriteExportRefusals: 'Exports refuse traversal, symlinks, special files and non-absolute paths',
  TestReadImport: 'Imports read regular files only, with size limits',
  TestNonBiometricRoundTrip: 'Keychain round trip (non-biometric item)',
  TestBiometricHonestOnUnsignedBuild: 'Biometric unlock reports unavailability honestly on unsigned builds (no fake success)',
  TestDistributedNotificationForwarded: 'System lock/sleep notifications reach the UI',
  TestEndToEndWindowClose: 'Helper exits when the window closes (no orphan process)',
  TestEndToEndSocketClose: 'Helper exits when the IPC socket closes (no orphan process)',
  TestBadBootstrap: 'Helper refuses a malformed bootstrap message',
  TestCleanupWhenNeverStarted: 'Temporary files are removed when an external session never starts',
  TestMain: 'test harness',
};
export const describeGoTest = (n: string) => NAMES[n] ?? n.replace(/^Test/, '').replace(/([a-z])([A-Z])/g, '$1 $2');

const SSH_PKGS = ['sshconn', 'agentsrv', 'term', 'sshkeys'];

const suite: Suite = {
  id: 'native',
  title: 'Native helper (Go): IPC, validation, filesystem, Keychain, process lifecycle',
  needsApi: false,
  async run({ t }) {
    if (!which('go')) {
      t.unverified('native.go', 'Go helper tests', 'Go toolchain not installed');
    } else {
      const r = goTest(['./...']);
      const results = r!.results.filter((x) => !SSH_PKGS.some((p) => x.pkg.startsWith(p)));
      if (!results.length) t.unverified('native.go', 'Go helper tests', `no test events: ${r!.stderr.slice(-1000)}`);
      recordGoTests(t, 'native.go', results, describeGoTest);
      await t.check('native.go-vet', 'go vet finds nothing', () => {
        const v = run('go', ['vet', './...'], { cwd: HELPER_DIR, env: { GOTOOLCHAIN: 'local' } });
        return { ok: v.status === 0, evidence: v.status === 0 ? 'clean' : v.stderr.slice(-2000) };
      }, { severity: 'medium' });
    }

    await t.check('native.no-shell', 'The helper starts no shell; its only process launches are the two /usr/bin/open launchers (links, external terminal) and the bundled pv-touchid, each with a fixed argv list', () => {
      const dirs = ['native/desktop-helper/internal', 'native/desktop-helper/cmd'];
      const exec = gitGrep('exec\\.Command|syscall\\.Exec|os\\.StartProcess', dirs, { extended: true }).filter((l) => !l.includes('_test.go'));
      const shells = gitGrep('"(/bin/)?(ba|z)?sh"|"-c"', dirs, { extended: true }).filter((l) => !l.includes('_test.go'));
      const allowed = ['internal/links/links.go', 'internal/term/term.go'];
      const touchId = exec.filter((l) => l.includes('internal/keychain/touchid.go'));
      const touchIdOk = touchId.length === 1 && touchId[0]!.includes('exec.CommandContext(ctx, bin, "--helper")');
      const sitesOk =
        exec.length === allowed.length + 1 && touchIdOk && allowed.every((f) => exec.some((l) => l.includes(f) && l.includes('exec.Command(argv[0], argv[1:]...)')));
      const openOnly = allowed.every((f) => readFileSync(join(HELPER_DIR, f), 'utf8').includes('"/usr/bin/open"'));
      const binOk = /return filepath\.Clean\(c\)/.test(readFileSync(join(HELPER_DIR, 'internal/keychain/touchid.go'), 'utf8'));
      return {
        ok: sitesOk && openOnly && binOk && shells.length === 0,
        evidence: `process launches:\n${exec.join('\n')}\nlaunchers run /usr/bin/open: ${openOnly}\npv-touchid only from the app bundle, argv ["--helper"], request on stdin: ${touchIdOk && binOk}\nshell invocations: ${shells.length}`,
      };
    }, { severity: 'critical' });

    await t.check('native.keychain.biometric-acl', 'Biometric unlock material is protected by the Keychain access control (Touch ID enforced by the OS, not by a UI prompt)', () => {
      const m = readFileSync(join(HELPER_DIR, 'internal/keychain/keychain_darwin.m'), 'utf8');
      const ok =
        m.includes('SecAccessControlCreateWithFlags') &&
        m.includes('kSecAccessControlBiometryCurrentSet') &&
        m.includes('kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly') &&
        m.includes('kSecUseDataProtectionKeychain') &&
        !/evaluatePolicy:/.test(m);
      return {
        ok,
        evidence:
          'biometric items: data-protection keychain + SecAccessControl(BiometryCurrentSet, WhenPasscodeSetThisDeviceOnly); no LAContext evaluatePolicy gate in code (the Keychain itself refuses reads without a fresh Touch ID match; re-enrolled fingers invalidate the item). The item holds a random device key that wraps the user key (wrapUserKeyForDevice).',
      };
    }, { severity: 'critical' });

    await t.check('native.touchid.secure-enclave', 'Unsigned builds: Touch ID unlock material is sealed to a Secure Enclave key that requires a current Touch ID match (pv-touchid)', () => {
      const sw = readFileSync(join(ROOT, 'native/touchid/pv-touchid.swift'), 'utf8');
      const ok =
        sw.includes('SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl:') &&
        sw.includes('[.privateKeyUsage, .biometryCurrentSet]') &&
        sw.includes('kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly') &&
        sw.includes('PrivateKey(dataRepresentation: keyBlob, authenticationContext: ctx)') &&
        sw.includes('AES.GCM.seal(') &&
        !/write\(.*secret/.test(sw);
      return {
        ok,
        evidence:
          'pv-touchid: per-secret Secure Enclave P-256 key (privateKeyUsage + biometryCurrentSet, WhenPasscodeSetThisDeviceOnly); ECDH with an ephemeral key + HKDF-SHA256 → AES-256-GCM. Opening needs the enclave to perform the key agreement, which it refuses without a fresh Touch ID match (the evaluated LAContext is handed to the enclave, which checks it). Records are 0600, namespaced per caller (desktop helper / each extension origin).',
      };
    }, { severity: 'critical' });
    t.unverified(
      'native.keychain.biometric-runtime',
      'Touch ID prompt actually gates the stored key on real hardware',
      'needs a signed build with keychain-access-groups entitlement and a person to touch the sensor; procedure in docs/security/RUNBOOK.md (unsigned builds correctly report biometrics unavailable: TestBiometricHonestOnUnsignedBuild)',
    );

    if (which('govulncheck')) {
      await t.check('native.govulncheck', 'govulncheck reports no reachable known vulnerabilities in the helper', () => {
        const g = run('govulncheck', ['./...'], { cwd: HELPER_DIR });
        return { ok: g.status === 0, evidence: (g.stdout + g.stderr).slice(-2500) };
      }, { severity: 'high' });
    } else {
      t.unverified('native.govulncheck', 'govulncheck on the Go helper', 'govulncheck not installed locally; runs in CI (security.yml)');
    }
    if (!isMac) t.unverified('native.macos-only', 'Keychain, Touch ID and system events', 'not macOS');
  },
};

export default suite;

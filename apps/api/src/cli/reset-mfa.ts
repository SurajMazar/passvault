/**
 * Operator-assisted MFA reset (docs/OPERATIONS.md "Operator MFA reset").
 *
 * Use ONLY after verifying the user's identity out-of-band. Removes the TOTP
 * enrollment and all MFA recovery codes, revokes every session, rotates the
 * securityStamp (drops trusted devices) and writes an audit event. It does NOT
 * touch vault keys or data: the vault still requires the master password or
 * the recovery key. On next sign-in the user must enroll MFA again.
 *
 *   pnpm --filter @passvault/api cli:reset-mfa -- --email user@example.com --reason "TICKET-123" [--yes]
 *   (container) node dist/cli/reset-mfa.js --email user@example.com --reason "TICKET-123"
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const email = arg('email')?.trim().toLowerCase();
  const reason = arg('reason')?.trim().slice(0, 200) ?? '';
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    process.stderr.write('usage: reset-mfa --email <address> --reason <ticket/reference> [--yes]\n');
    return 2;
  }
  if (!reason) {
    process.stderr.write('--reason is required (support ticket or verification reference, recorded in the audit log)\n');
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write('DATABASE_URL is not set\n');
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      process.stderr.write('no account with that email\n');
      return 1;
    }
    const [mfa, codes, sessions] = await Promise.all([
      prisma.mfaEnrollment.count({ where: { userId: user.id } }),
      prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      prisma.session.count({ where: { userId: user.id, revokedAt: null } }),
    ]);
    process.stdout.write(
      `Account ${user.id} (${email})\n  MFA enrollments: ${mfa}\n  unused recovery codes: ${codes}\n  open sessions: ${sessions}\n` +
        `This removes MFA + recovery codes, revokes all sessions and trusted devices. Vault keys/data are NOT changed.\n`,
    );
    if (!flag('yes')) {
      if (!process.stdin.isTTY) {
        process.stderr.write('refusing to continue without --yes in a non-interactive shell\n');
        return 1;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Type the email address to confirm: `);
      rl.close();
      if (answer.trim().toLowerCase() !== email) {
        process.stderr.write('aborted\n');
        return 1;
      }
    }
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.mfaEnrollment.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, revokeReason: 'operator_mfa_reset' } });
      await tx.device.updateMany({ where: { userId: user.id }, data: { trustedTokenHash: null, trustedStamp: null, trustedUntil: null } });
      await tx.user.update({ where: { id: user.id }, data: { securityStamp: randomBytes(16).toString('base64url') } });
      await tx.auditEvent.create({
        data: {
          type: 'auth.mfa_reset',
          subjectUserId: user.id,
          metadata: { by: 'operator_cli', reason, operator: process.env.USER ?? 'unknown' },
        },
      });
    });
    process.stdout.write('MFA reset complete. The user must enroll a new authenticator at next sign-in.\n');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`reset-mfa failed: ${e instanceof Error ? e.name : 'error'}\n`);
    process.exit(1);
  },
);

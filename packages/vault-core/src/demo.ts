import { generatePassword } from '@passvault/crypto';
import type { VaultSession } from './session';
import { newItem, newProject } from './items';

/**
 * Dummy demo data. Every value is fake: hosts use reserved example domains
 * (RFC 2606) and documentation IP ranges (RFC 5737), tokens are random.
 */
export async function seedDemoData(session: VaultSession): Promise<void> {
  const projectId = await session.saveProject(newProject('Acme Storefront', { description: 'Demo project with dummy secrets', tags: ['demo'] }));

  await session.saveItem(
    newItem('login', {
      title: 'Example Admin',
      folder: 'Work',
      tags: ['demo', 'admin'],
      notes: 'Dummy login for the demo.',
      fields: { username: 'admin@example.com', password: generatePassword({ length: 24 }), urls: [{ url: 'https://admin.example.com', match: 'host' }] },
    }),
  );
  await session.saveItem(
    newItem('login', {
      title: 'Reused password demo',
      folder: 'Personal',
      tags: ['demo'],
      fields: { username: 'demo-user', password: 'password123', urls: [{ url: 'https://shop.example.org', match: 'base_domain' }] },
    }),
  );
  await session.saveItem(
    newItem('ssh_connection', {
      title: 'Staging web server',
      projectId,
      environment: 'staging',
      tags: ['demo'],
      fields: { host: '192.0.2.10', port: 22, username: 'deploy', authMethod: 'password', password: generatePassword({ length: 20 }), hostKeys: [] },
    }),
  );
  await session.saveItem(
    newItem('database', {
      title: 'Orders DB (production)',
      projectId,
      environment: 'production',
      tags: ['demo', 'postgres'],
      fields: {
        engine: 'postgresql',
        host: 'db.prod.example.net',
        port: 5432,
        database: 'orders',
        username: 'orders_app',
        password: generatePassword({ length: 32, symbols: false }),
        tlsMode: 'verify-full',
      },
    }),
  );
  await session.saveItem(
    newItem('api_credential', {
      title: 'Payments sandbox key',
      projectId,
      environment: 'development',
      tags: ['demo'],
      fields: { service: 'Example Payments', endpoint: 'https://api.payments.example.com/v1', kind: 'api_key', apiKey: `sk_test_${generatePassword({ length: 32, symbols: false })}`, expiresAt: new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10) },
    }),
  );
  await session.saveItem(
    newItem('env_file', {
      title: 'Storefront .env (development)',
      projectId,
      environment: 'development',
      fields: {
        filename: '.env',
        content: `# Acme Storefront — development (dummy values)\nNODE_ENV=development\nDATABASE_URL="postgres://app:${generatePassword({ length: 16, symbols: false })}@localhost:5432/store"\nSTRIPE_KEY=sk_test_${generatePassword({ length: 24, symbols: false })}\nFEATURE_FLAGS='checkout,search'\n`,
        variableNotes: { STRIPE_KEY: 'Sandbox key from the payments dashboard' },
      },
    }),
  );
  await session.saveItem(
    newItem('env_file', {
      title: 'Storefront .env (production)',
      projectId,
      environment: 'production',
      fields: {
        filename: '.env.production',
        content: `# Acme Storefront — production (dummy values)\nNODE_ENV=production\nDATABASE_URL="postgres://app:${generatePassword({ length: 16, symbols: false })}@db.prod.example.net:5432/store"\nSTRIPE_KEY=sk_live_DUMMY_${generatePassword({ length: 24, symbols: false })}\nSENTRY_DSN=https://public@sentry.example.com/1\n`,
        variableNotes: {},
      },
    }),
  );
  await session.saveItem(
    newItem('secure_note', { title: 'Incident runbook', tags: ['demo'], fields: { content: 'Dummy runbook.\n1. Page the on-call.\n2. Check the status page.\n<script>alert(1)</script> ← rendered as text, never HTML' } }),
  );
}

import { itemIdentifier, itemSubtitle, type DecryptedItem } from '@passvault/vault-core';
import type { DetailField, ItemDetail, ItemSummary } from '../shared/protocol';

export function summarize(it: DecryptedItem): ItemSummary {
  return {
    id: it.id,
    type: it.payload.type,
    title: it.payload.title || '(untitled)',
    subtitle: itemSubtitle(it.payload),
    identifier: itemIdentifier(it.payload),
    environment: it.payload.environment ?? null,
    favorite: it.favorite,
    shared: it.shared,
    readOnly: it.role === 'viewer',
  };
}

/** Full decrypted detail for the popup (trusted extension page) only. */
export function itemDetail(it: DecryptedItem): ItemDetail {
  const p = it.payload;
  const f: DetailField[] = [];
  const add = (key: string, label: string, value: string | number | undefined | null, opts: Partial<DetailField> = {}) => {
    if (value === undefined || value === null || value === '') return;
    f.push({ key, label, value: String(value), secret: false, ...opts });
  };
  switch (p.type) {
    case 'login':
      add('username', 'Username', p.fields.username);
      add('password', 'Password', p.fields.password, { secret: true });
      break;
    case 'ssh_connection':
      add('host', 'Host', p.fields.host, { mono: true });
      add('port', 'Port', p.fields.port);
      add('username', 'Username', p.fields.username);
      add('authMethod', 'Auth method', p.fields.authMethod);
      add('password', 'Password', p.fields.password, { secret: true });
      break;
    case 'ssh_key':
      add('algorithm', 'Algorithm', p.fields.algorithm);
      add('fingerprint', 'Fingerprint', p.fields.fingerprint, { mono: true });
      add('publicKey', 'Public key', p.fields.publicKey, { mono: true });
      add('privateKey', 'Private key', p.fields.privateKey, { secret: true, multiline: true });
      add('passphrase', 'Passphrase', p.fields.passphrase, { secret: true });
      break;
    case 'database':
      add('engine', 'Engine', p.fields.engine);
      add('host', 'Host', p.fields.host, { mono: true });
      add('port', 'Port', p.fields.port);
      add('database', 'Database', p.fields.database);
      add('username', 'Username', p.fields.username);
      add('password', 'Password', p.fields.password, { secret: true });
      add('connectionString', 'Connection string', p.fields.connectionString, { secret: true });
      add('tlsMode', 'TLS', p.fields.tlsMode);
      break;
    case 'api_credential':
      add('service', 'Service', p.fields.service);
      add('endpoint', 'Endpoint', p.fields.endpoint, { mono: true });
      add('clientId', 'Client ID', p.fields.clientId, { mono: true });
      add('username', 'Username', p.fields.username);
      add('token', 'Token', p.fields.token, { secret: true });
      add('apiKey', 'API key', p.fields.apiKey, { secret: true });
      add('clientSecret', 'Client secret', p.fields.clientSecret, { secret: true });
      add('password', 'Password', p.fields.password, { secret: true });
      add('expiresAt', 'Expires', p.fields.expiresAt);
      break;
    case 'env_file':
      add('filename', 'File name', p.fields.filename, { mono: true });
      add('content', 'Contents', p.fields.content, { secret: true, mono: true, multiline: true });
      break;
    case 'secure_note':
      add('content', 'Note', p.fields.content, { secret: true, multiline: true });
      break;
  }
  for (const cf of p.customFields) {
    add(`custom:${cf.id}`, cf.label || 'Field', cf.value, { secret: cf.type === 'secret', multiline: cf.type === 'multiline' });
  }
  return {
    ...summarize(it),
    fields: f,
    urls: p.type === 'login' ? p.fields.urls.map((u) => ({ url: u.url, match: u.match })) : [],
    notes: p.notes,
    folder: p.folder,
    tags: p.tags,
    fillable: p.type === 'login',
  };
}

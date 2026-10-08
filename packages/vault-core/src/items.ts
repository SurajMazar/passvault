import {
  DATABASE_DEFAULT_PORTS,
  ITEM_TYPE_LABELS,
  type ItemFieldsByType,
  type ItemPayload,
  type ItemType,
  type ProjectPayload,
} from '@passvault/types';

export function emptyFields<T extends ItemType>(type: T): ItemFieldsByType[T] {
  const f: { [K in ItemType]: ItemFieldsByType[K] } = {
    login: { username: '', password: '', urls: [] },
    ssh_connection: { host: '', port: 22, username: '', authMethod: 'key', hostKeys: [] },
    ssh_key: { publicKey: '', privateKey: '', fingerprint: '', algorithm: '' },
    database: { engine: 'postgresql', host: '', port: DATABASE_DEFAULT_PORTS.postgresql, database: '', username: '', password: '', tlsMode: 'verify-full' },
    api_credential: { service: '', kind: 'token' },
    env_file: { filename: '.env', content: '', variableNotes: {} },
    secure_note: { content: '' },
  };
  return structuredClone(f[type]);
}

export function newItem<T extends ItemType>(type: T, overrides: Partial<ItemPayload<T>> = {}): ItemPayload<T> {
  return {
    v: 1,
    type,
    title: '',
    description: '',
    notes: '',
    folder: '',
    tags: [],
    projectId: null,
    environment: null,
    favorite: false,
    archived: false,
    trashedAt: null,
    customFields: [],
    fields: emptyFields(type),
    ...overrides,
  } as unknown as ItemPayload<T>;
}

export function newProject(name: string, overrides: Partial<ProjectPayload> = {}): ProjectPayload {
  return {
    v: 1,
    name,
    description: '',
    tags: [],
    favorite: false,
    environments: [
      { id: 'development', name: 'Development', kind: 'development' },
      { id: 'staging', name: 'Staging', kind: 'staging' },
      { id: 'production', name: 'Production', kind: 'production' },
    ],
    trashedAt: null,
    ...overrides,
  };
}

/** One-line secondary text for list rows. Never includes secret values. */
export function itemSubtitle(p: ItemPayload): string {
  switch (p.type) {
    case 'login': {
      const host = p.fields.urls[0] ? safeHost(p.fields.urls[0].url) : '';
      return [p.fields.username, host].filter(Boolean).join(' · ');
    }
    case 'ssh_connection':
      return `${p.fields.username || '?'}@${p.fields.host}${p.fields.port !== 22 ? `:${p.fields.port}` : ''}`;
    case 'ssh_key':
      return [p.fields.algorithm, p.fields.fingerprint].filter(Boolean).join(' · ');
    case 'database':
      return `${p.fields.engine} · ${p.fields.username ? `${p.fields.username}@` : ''}${p.fields.host}${p.fields.database ? `/${p.fields.database}` : ''}`;
    case 'api_credential':
      return [p.fields.service, p.fields.endpoint ? safeHost(p.fields.endpoint) : ''].filter(Boolean).join(' · ');
    case 'env_file':
      return p.fields.filename;
    case 'secure_note':
      return 'Secure note';
  }
}

export function typeLabel(t: ItemType) {
  return ITEM_TYPE_LABELS[t];
}

export function safeHost(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

export function duplicatePayload<T extends ItemPayload>(p: T): T {
  const copy = structuredClone(p);
  copy.title = `${p.title} (copy)`;
  copy.favorite = false;
  copy.trashedAt = null;
  if (copy.type === 'ssh_connection') copy.fields.hostKeys = [...copy.fields.hostKeys];
  return copy;
}

export type ItemStatusFilter = 'active' | 'archived' | 'trash';

export function itemStatus(p: { archived?: boolean; trashedAt: string | null }): ItemStatusFilter {
  if (p.trashedAt) return 'trash';
  if (p.archived) return 'archived';
  return 'active';
}

import { entries, parseEnv } from '@passvault/env-parser';
import type { ItemPayload, ItemType } from '@passvault/types';
import { itemStatus, type ItemStatusFilter } from './items';

/**
 * Local search over decrypted, NON-SECRET fields. Secret values (passwords,
 * tokens, private keys, env values) are never indexed. Nothing is sent to the
 * server; there is no server-side index.
 */
export function searchableText(p: ItemPayload): string {
  const parts: string[] = [p.title, p.description, p.folder, p.environment ?? '', ...p.tags, p.notes];
  for (const cf of p.customFields) parts.push(cf.label, cf.type === 'secret' ? '' : cf.value);
  switch (p.type) {
    case 'login':
      parts.push(p.fields.username, ...p.fields.urls.map((u) => u.url));
      break;
    case 'ssh_connection':
      parts.push(p.fields.host, p.fields.username, String(p.fields.port));
      break;
    case 'ssh_key':
      parts.push(p.fields.fingerprint, p.fields.algorithm, p.fields.comment ?? '');
      break;
    case 'database':
      parts.push(p.fields.engine, p.fields.host, p.fields.database, p.fields.username);
      break;
    case 'api_credential':
      parts.push(p.fields.service, p.fields.endpoint ?? '', p.fields.clientId ?? '', p.fields.username ?? '');
      break;
    case 'env_file': {
      parts.push(p.fields.filename);
      try {
        parts.push(...entries(parseEnv(p.fields.content)).map((e) => e.key));
      } catch {
        /* raw text stays authoritative; names just aren't searchable */
      }
      break;
    }
    case 'secure_note':
      break; // note body is secret content; only its title/metadata are searchable
  }
  return parts.join('\n').toLowerCase();
}

export interface SearchableItem {
  id: string;
  vaultId: string;
  updatedAt: string;
  payload: ItemPayload;
  shared: boolean;
  sharedByMe: boolean;
  favorite: boolean;
}

export interface ItemFilter {
  query?: string;
  types?: ItemType[];
  projectId?: string | null;
  environment?: string | null;
  folder?: string | null;
  tags?: string[];
  status?: ItemStatusFilter;
  favoritesOnly?: boolean;
  shared?: 'with_me' | 'by_me' | null;
  sort?: 'title' | 'updated';
}

export function filterItems<T extends SearchableItem>(items: T[], f: ItemFilter, textCache?: Map<string, string>): T[] {
  const status = f.status ?? 'active';
  const terms = (f.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = items.filter((it) => {
    const p = it.payload;
    if (itemStatus(p) !== status) return false;
    if (f.types?.length && !f.types.includes(p.type)) return false;
    if (f.projectId !== undefined && f.projectId !== null && p.projectId !== f.projectId) return false;
    if (f.environment && (p.environment ?? '').toLowerCase() !== f.environment.toLowerCase()) return false;
    if (f.folder && p.folder !== f.folder && !p.folder.startsWith(`${f.folder}/`)) return false;
    if (f.tags?.length && !f.tags.every((t) => p.tags.includes(t))) return false;
    if (f.favoritesOnly && !it.favorite) return false;
    if (f.shared === 'with_me' && !(it.shared && !it.sharedByMe)) return false;
    if (f.shared === 'by_me' && !it.sharedByMe) return false;
    if (terms.length) {
      const key = `${it.id}:${it.updatedAt}`;
      let text = textCache?.get(key);
      if (text === undefined) {
        text = searchableText(p);
        textCache?.set(key, text);
      }
      if (!terms.every((t) => text!.includes(t))) return false;
    }
    return true;
  });
  const sort = f.sort ?? 'title';
  out.sort((a, b) =>
    sort === 'updated'
      ? b.updatedAt.localeCompare(a.updatedAt)
      : a.payload.title.localeCompare(b.payload.title, undefined, { sensitivity: 'base', numeric: true }),
  );
  return out;
}

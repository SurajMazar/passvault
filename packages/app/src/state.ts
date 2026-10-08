import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { create } from 'zustand';
import type { ItemType } from '@passvault/types';
import type { DecryptedItem, SessionSnapshot, VaultSession } from '@passvault/vault-core';
import type { ThemePref } from '@passvault/ui';

export type NavId =
  | 'overview'
  | 'all'
  | ItemType
  | 'projects'
  | 'favorites'
  | 'shared_with_me'
  | 'shared_by_me'
  | 'archive'
  | 'trash'
  | 'settings'
  | `ext:${string}`;

export type EditorState = { mode: 'create'; type: ItemType; projectId?: string | null; environment?: string | null; preset?: Record<string, unknown> } | { mode: 'edit'; id: string } | null;

export interface UiState {
  nav: NavId;
  selectedId: string | null;
  selectedIds: string[];
  projectId: string | null;
  query: string;
  sort: 'title' | 'updated';
  tagFilter: string | null;
  envFilter: string | null;
  folderFilter: string | null;
  editor: EditorState;
  paletteOpen: boolean;
  generatorOpen: boolean;
  shareTarget: { kind: 'items'; itemIds: string[] } | { kind: 'project'; projectId: string } | null;
  membersVaultId: string | null;
  historyId: string | null;
  conflictId: string | null;
  settingsTab: string;
  theme: ThemePref;
  set: (patch: Partial<Omit<UiState, 'set' | 'go'>>) => void;
  go: (nav: NavId, extra?: Partial<Omit<UiState, 'set' | 'go'>>) => void;
}

export const useUi = create<UiState>((set) => ({
  nav: 'overview',
  selectedId: null,
  selectedIds: [],
  projectId: null,
  query: '',
  sort: 'title',
  tagFilter: null,
  envFilter: null,
  folderFilter: null,
  editor: null,
  paletteOpen: false,
  generatorOpen: false,
  shareTarget: null,
  membersVaultId: null,
  historyId: null,
  conflictId: null,
  settingsTab: 'security',
  theme: 'system',
  set: (patch) => set(patch),
  go: (nav, extra) => set({ nav, selectedId: null, selectedIds: [], tagFilter: null, envFilter: null, folderFilter: null, ...extra }),
}));

/** Extension points that platform shells (desktop) use to add native features. */
export interface ItemAction {
  id: string;
  label: string;
  icon?: ReactNode;
  primary?: boolean;
  onSelect: () => void;
}

export interface AppExtensions {
  /** e.g. "Connect" / "Open in Terminal" for SSH items on desktop */
  itemActions?: (item: DecryptedItem, session: VaultSession) => ItemAction[];
  /** extra sidebar entries rendered as full views (e.g. Terminal) */
  extraNav?: Array<{ id: string; label: string; icon: ReactNode; render: () => ReactNode; badge?: () => ReactNode }>;
  /** extra sections in Security & settings */
  settingsSections?: Array<{ id: string; label: string; render: () => ReactNode }>;
  /** native SSH key tooling (desktop helper) */
  sshKeys?: {
    generate(opts: { algorithm: 'ed25519' | 'ecdsa-p256' | 'rsa-3072' | 'rsa-4096'; comment: string; passphrase?: string }): Promise<{ publicKey: string; privateKey: string; fingerprint: string; algorithm: string }>;
    inspect(opts: { privateKey?: string; publicKey?: string; passphrase?: string }): Promise<{ publicKey: string; fingerprint: string; algorithm: string; encrypted: boolean; comment: string }>;
  };
  /** SSH connection test (desktop helper) */
  testConnection?: (item: DecryptedItem) => Promise<{ ok: boolean; message: string }>;
  /** rendered under the sign-in and lock screens (desktop: server picker) */
  authFooter?: () => ReactNode;
  /** banner text shown in the shell (e.g. helper status) */
  statusBanner?: () => ReactNode;
}

export interface AppContextValue {
  session: VaultSession;
  ext: AppExtensions;
  platformName: 'web' | 'desktop' | 'extension';
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext missing');
  return v;
}

export function useSnapshot(): SessionSnapshot {
  const { session } = useApp();
  return useSyncExternalStore(
    (cb) => session.subscribe(() => cb()),
    () => session.getSnapshot(),
  );
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as Error).message === 'string') {
    const err = e as Error & { code?: string; details?: unknown };
    if (err.code === 'validation_failed' && Array.isArray(err.details)) {
      return (err.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join('; ');
    }
    if (err.name === 'ZodError') {
      const issues = (err as unknown as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
      return issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');
    }
    return err.message;
  }
  return String(e);
}

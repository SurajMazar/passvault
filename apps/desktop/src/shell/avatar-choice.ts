/** The buddy's avatar setting (the drawings are in ui/avatars.tsx). */

export const BUILTIN_AVATAR_IDS = ['keybot', 'owl', 'cat', 'fox', 'robot', 'ghost', 'panda', 'blob'] as const;
export type BuiltinId = (typeof BUILTIN_AVATAR_IDS)[number];
export type AvatarChoice = { kind: 'builtin'; id: BuiltinId } | { kind: 'custom'; dataUrl: string };

export const DEFAULT_AVATAR: AvatarChoice = { kind: 'builtin', id: 'keybot' };

/** Custom pictures are stored only as the app's own re-encoded 128×128 PNG (≤ ~300 KB as base64). */
const CUSTOM_PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]{20,400000}$/;

export function parseAvatar(raw: unknown): AvatarChoice {
  const v = raw as { kind?: unknown; id?: unknown; dataUrl?: unknown } | null;
  if (v && v.kind === 'builtin' && (BUILTIN_AVATAR_IDS as readonly unknown[]).includes(v.id)) return { kind: 'builtin', id: v.id as BuiltinId };
  if (v && v.kind === 'custom' && typeof v.dataUrl === 'string' && CUSTOM_PNG.test(v.dataUrl)) return { kind: 'custom', dataUrl: v.dataUrl };
  return DEFAULT_AVATAR;
}

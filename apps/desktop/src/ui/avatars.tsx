import type { ReactNode } from 'react';
import type { VaultState } from '../shell/menu-bar';
import type { AvatarChoice, BuiltinId } from '../shell/avatar-choice';

export { DEFAULT_AVATAR, parseAvatar, type AvatarChoice } from '../shell/avatar-choice';

/**
 * The buddy's character: built-in avatars (SVG, drawn here — nothing loaded
 * from the network) or the user's own picture. Its face follows the vault:
 * asleep when locked, happy when ready, busy while syncing, alert when
 * something waits for approval, worried when the server cannot be reached.
 */

export type Mood = 'happy' | 'sleepy' | 'busy' | 'alert' | 'worried' | 'meh';

export const MOOD: Record<VaultState, Mood> = {
  ready: 'happy',
  locked: 'sleepy',
  signed_out: 'sleepy',
  syncing: 'busy',
  awaiting_approval: 'alert',
  offline: 'meh',
  connection_error: 'worried',
};

export const GREETING: Record<VaultState, string> = {
  ready: 'All set — what do you need?',
  locked: 'Zzz… unlock me and I’ll help.',
  signed_out: 'Sign in and I’ll keep your secrets handy.',
  syncing: 'Syncing your vault…',
  awaiting_approval: 'Something needs your OK.',
  offline: 'Offline — your saved items still work here.',
  connection_error: 'I can’t reach the server right now.',
};

/** Ring colour around the bubble for each state. */
export const RING: Record<VaultState, string> = {
  ready: '#2bc3ae',
  locked: '#6b7785',
  signed_out: '#6b7785',
  syncing: '#5aa9ff',
  awaiting_approval: '#f2b45a',
  offline: '#a08a5a',
  connection_error: '#ff8266',
};

interface Builtin {
  id: string;
  name: string;
  /** face colour, accent colour */
  face: string;
  accent: string;
  /** head decoration drawn behind the face (ears, antenna…) */
  back?: ReactNode;
  /** decoration drawn above the face (beak, stripes…) */
  front?: (mood: Mood) => ReactNode;
}

const BUILTINS = [
  {
    id: 'keybot',
    name: 'Keybot',
    face: '#2bc3ae',
    accent: '#03201b',
    back: (
      <>
        <rect x="29" y="1" width="6" height="9" rx="3" fill="#2bc3ae" />
        <circle cx="32" cy="3" r="3.2" fill="#f2b45a" />
      </>
    ),
  },
  {
    id: 'owl',
    name: 'Owl',
    face: '#8b6f4e',
    accent: '#f6e7c8',
    back: (
      <>
        <path d="M10 14 L16 2 L24 12 Z" fill="#8b6f4e" />
        <path d="M54 14 L48 2 L40 12 Z" fill="#8b6f4e" />
      </>
    ),
    front: () => <path d="M29 38 L35 38 L32 43 Z" fill="#f2b45a" />,
  },
  {
    id: 'cat',
    name: 'Cat',
    face: '#f2a25a',
    accent: '#3a2412',
    back: (
      <>
        <path d="M8 22 L12 3 L26 12 Z" fill="#f2a25a" />
        <path d="M56 22 L52 3 L38 12 Z" fill="#f2a25a" />
        <path d="M12 18 L14 8 L22 13 Z" fill="#ffd9b8" />
        <path d="M52 18 L50 8 L42 13 Z" fill="#ffd9b8" />
      </>
    ),
    front: () => (
      <g stroke="#3a2412" strokeWidth="1.2" strokeLinecap="round">
        <path d="M14 38 L4 36 M14 41 L4 42 M50 38 L60 36 M50 41 L60 42" />
      </g>
    ),
  },
  {
    id: 'fox',
    name: 'Fox',
    face: '#e8743b',
    accent: '#2a140a',
    back: (
      <>
        <path d="M8 26 L6 2 L26 12 Z" fill="#e8743b" />
        <path d="M56 26 L58 2 L38 12 Z" fill="#e8743b" />
      </>
    ),
    front: () => <path d="M16 40 Q32 62 48 40 Q32 50 16 40 Z" fill="#fff4ea" />,
  },
  {
    id: 'robot',
    name: 'Robot',
    face: '#7d8ea3',
    accent: '#0b1117',
    back: (
      <>
        <rect x="30" y="0" width="4" height="10" fill="#7d8ea3" />
        <circle cx="32" cy="2" r="3" fill="#ff8266" />
        <rect x="0" y="26" width="6" height="14" rx="2" fill="#5f6e80" />
        <rect x="58" y="26" width="6" height="14" rx="2" fill="#5f6e80" />
      </>
    ),
  },
  {
    id: 'ghost',
    name: 'Ghost',
    face: '#e9eef5',
    accent: '#26303c',
    front: () => <path d="M8 52 Q14 60 20 52 Q26 60 32 52 Q38 60 44 52 Q50 60 56 52 L56 46 L8 46 Z" fill="#e9eef5" />,
  },
  {
    id: 'panda',
    name: 'Panda',
    face: '#f4f4f4',
    accent: '#16191d',
    back: (
      <>
        <circle cx="12" cy="10" r="8" fill="#16191d" />
        <circle cx="52" cy="10" r="8" fill="#16191d" />
      </>
    ),
    front: () => (
      <>
        <ellipse cx="22" cy="30" rx="7" ry="8" fill="#16191d" opacity="0.9" />
        <ellipse cx="42" cy="30" rx="7" ry="8" fill="#16191d" opacity="0.9" />
      </>
    ),
  },
  {
    id: 'blob',
    name: 'Blob',
    face: '#a77bf3',
    accent: '#1d0f33',
    back: <circle cx="50" cy="12" r="5" fill="#c8a8ff" />,
  },
] as const satisfies readonly Builtin[];

export const AVATARS: ReadonlyArray<Builtin & { id: BuiltinId }> = BUILTINS;

function Eyes({ mood, color, light }: { mood: Mood; color: string; light: boolean }) {
  const eye = light ? '#ffffff' : color;
  switch (mood) {
    case 'sleepy':
      return (
        <g stroke={color} strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d="M18 30 Q22 33 26 30" />
          <path d="M38 30 Q42 33 46 30" />
        </g>
      );
    case 'alert':
      return (
        <>
          <circle cx="22" cy="29" r="5" fill={eye} />
          <circle cx="42" cy="29" r="5" fill={eye} />
          <circle cx="22" cy="29" r="2.2" fill={light ? color : '#ffffff'} />
          <circle cx="42" cy="29" r="2.2" fill={light ? color : '#ffffff'} />
        </>
      );
    case 'worried':
      return (
        <>
          <path d="M16 23 L26 26 M48 23 L38 26" stroke={color} strokeWidth="2" strokeLinecap="round" />
          <circle cx="22" cy="31" r="3.2" fill={eye} />
          <circle cx="42" cy="31" r="3.2" fill={eye} />
        </>
      );
    case 'busy':
      return (
        <>
          <circle cx="24" cy="29" r="3.4" fill={eye} />
          <circle cx="44" cy="29" r="3.4" fill={eye} />
        </>
      );
    default:
      return (
        <>
          <circle cx="22" cy="30" r="3.6" fill={eye} />
          <circle cx="42" cy="30" r="3.6" fill={eye} />
          <circle cx="23.2" cy="28.8" r="1.1" fill={light ? color : '#ffffff'} />
          <circle cx="43.2" cy="28.8" r="1.1" fill={light ? color : '#ffffff'} />
        </>
      );
  }
}

function Mouth({ mood, color }: { mood: Mood; color: string }) {
  const s = { stroke: color, strokeWidth: 2.4, strokeLinecap: 'round' as const, fill: 'none' };
  switch (mood) {
    case 'happy':
      return <path d="M24 41 Q32 48 40 41" {...s} />;
    case 'sleepy':
      return <ellipse cx="32" cy="43" rx="3" ry="2" fill={color} />;
    case 'busy':
      return <path d="M26 43 L38 43" {...s} />;
    case 'alert':
      return <ellipse cx="32" cy="44" rx="3.5" ry="4.5" fill={color} />;
    case 'worried':
      return <path d="M25 46 Q32 40 39 46" {...s} />;
    case 'meh':
      return <path d="M26 44 Q32 42 38 44" {...s} />;
  }
}

/** Little extras that make the state readable at a glance (Zzz, …, !). */
function Extra({ mood }: { mood: Mood }) {
  const font = 'ui-sans-serif, -apple-system, sans-serif';
  if (mood === 'sleepy')
    return (
      <g fill="#a6b0bd" fontWeight="700" fontFamily={font}>
        <text className="pv-zzz" x="46" y="16" fontSize="9">
          z
        </text>
        <text className="pv-zzz pv-zzz-2" x="52" y="10" fontSize="11">
          z
        </text>
      </g>
    );
  if (mood === 'alert')
    return (
      <g className="pv-alert-badge">
        <circle cx="54" cy="10" r="8" fill="#f2b45a" />
        <rect x="53" y="4.5" width="2" height="7" rx="1" fill="#2a1a03" />
        <circle cx="54" cy="14" r="1.2" fill="#2a1a03" />
      </g>
    );
  if (mood === 'busy')
    return (
      <g fill="#5aa9ff">
        <circle className="pv-dot" cx="46" cy="10" r="2" />
        <circle className="pv-dot pv-dot-2" cx="52" cy="8" r="2" />
        <circle className="pv-dot pv-dot-3" cx="58" cy="6" r="2" />
      </g>
    );
  return null;
}

/** One-shot reactions: a happy hop (it worked) or a shake (it did not). */
export type Reaction = 'hop' | 'shake' | null;

/**
 * Animated avatar: breathes and blinks when idle; "z"s float up while asleep,
 * dots pulse while busy, the "!" bounces while something waits for approval.
 * `reaction` plays once each time `reactionKey` changes. All motion stops with
 * the system's "Reduce motion" setting (desktop.css).
 */
export function Avatar({ choice, state, size = 48, title, reaction = null, reactionKey = 0 }: { choice: AvatarChoice; state: VaultState; size?: number; title?: string; reaction?: Reaction; reactionKey?: number }) {
  const mood = MOOD[state];
  const react = reaction ? `pv-react-${reaction}` : '';
  if (choice.kind === 'custom') {
    return (
      <span key={reactionKey} className={`pv-av relative inline-block shrink-0 ${react}`} style={{ width: size, height: size }} title={title}>
        <img src={choice.dataUrl} alt="" className="size-full rounded-full object-cover" draggable={false} style={{ filter: mood === 'sleepy' ? 'grayscale(0.6) brightness(0.8)' : undefined }} />
        <svg viewBox="0 0 64 64" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
          <Extra mood={mood} />
        </svg>
      </span>
    );
  }
  const a = AVATARS.find((x) => x.id === choice.id) ?? AVATARS[0]!;
  const light = a.face === '#16191d';
  return (
    <svg key={reactionKey} viewBox="0 0 64 64" width={size} height={size} className={`pv-av shrink-0 ${react}`} role="img" aria-label={title ?? `${a.name} (${mood})`}>
      <g className={mood === 'sleepy' ? 'pv-sleep' : 'pv-breathe'}>
        {a.back}
        <circle cx="32" cy="34" r="26" fill={a.face} />
        {a.front?.(mood)}
        <g className={mood === 'sleepy' ? '' : 'pv-blink'}>
          <Eyes mood={mood} color={a.accent} light={light} />
        </g>
        <Mouth mood={mood} color={a.accent} />
        {mood === 'happy' && (
          <>
            <circle cx="15" cy="39" r="3" fill="#ff8aa0" opacity="0.45" />
            <circle cx="49" cy="39" r="3" fill="#ff8aa0" opacity="0.45" />
          </>
        )}
      </g>
      <Extra mood={mood} />
    </svg>
  );
}

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/**
 * The user's own picture: decoded by the browser and re-encoded as a 128×128
 * PNG (center crop). SVG and other formats that can carry scripts or
 * metadata never reach storage; only the re-encoded pixels do.
 */
export async function avatarFromFile(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF picture.');
  if (file.size > MAX_AVATAR_BYTES) throw new Error('That picture is larger than 5 MB.');
  const bmp = await createImageBitmap(file);
  try {
    const side = Math.min(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read the picture.');
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 128, 128);
    return canvas.toDataURL('image/png');
  } finally {
    bmp.close();
  }
}

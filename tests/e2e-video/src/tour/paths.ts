import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const RAW_DIR = join(ROOT, 'tests/e2e-video/.raw');
export const TTS_DIR = join(RAW_DIR, 'tts');
export const OUT_DIR = join(ROOT, 'docs/media');
/** Kokoro voice (American English, female). */
export const VOICE = process.env.PV_TTS_VOICE ?? 'af_heart';

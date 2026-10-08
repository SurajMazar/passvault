/**
 * Synthesises the tour narration with Kokoro TTS (kokoro-js, ONNX, local).
 * Writes .raw/tts/<id>.wav and .raw/tts/durations.json; unchanged lines are
 * cached by a hash of voice + text.
 *
 *   pnpm --filter @passvault/e2e-video tour:tts
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CHAPTERS } from './narration';
import { RAW_DIR, TTS_DIR, VOICE } from './paths';

mkdirSync(TTS_DIR, { recursive: true });
const manifestPath = join(TTS_DIR, 'durations.json');
const previous: Record<string, { hash: string; seconds: number }> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const out: typeof previous = {};

const todo = CHAPTERS.filter((c) => {
  const hash = createHash('sha256').update(`${VOICE}\n${c.say}`).digest('hex').slice(0, 16);
  const wav = join(TTS_DIR, `${c.id}.wav`);
  if (previous[c.id]?.hash === hash && existsSync(wav)) {
    out[c.id] = previous[c.id]!;
    return false;
  }
  return true;
});

if (todo.length) {
  console.log(`Loading Kokoro (${VOICE})…`);
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  for (const c of todo) {
    const hash = createHash('sha256').update(`${VOICE}\n${c.say}`).digest('hex').slice(0, 16);
    const wav = join(TTS_DIR, `${c.id}.wav`);
    const audio = await tts.generate(c.say, { voice: VOICE as 'af_heart' });
    await audio.save(wav);
    const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' }).trim());
    out[c.id] = { hash, seconds };
    console.log(`  ${c.id.padEnd(20)} ${seconds.toFixed(1)} s`);
  }
}
writeFileSync(manifestPath, JSON.stringify(out, null, 2));
const total = CHAPTERS.reduce((n, c) => n + (out[c.id]?.seconds ?? 0), 0);
console.log(`${CHAPTERS.length} chapters, ${total.toFixed(0)} s of narration → ${TTS_DIR}`);
void RAW_DIR;

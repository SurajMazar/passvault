// Verification-only Neutralino WebSocket client (see scripts/verify-harness.sh).
// Reads the exported auth info of the *verification* app id and calls one
// allow-listed native method:   node scripts/nl-client.mjs extensions.getStats
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const auth = JSON.parse(readFileSync(`${homedir()}/Library/Application Support/io.passvault.desktop.verify/.tmp/auth_info.json`, 'utf8'));
const [method, data = '{}'] = process.argv.slice(2);
const ws = new WebSocket(`ws://127.0.0.1:${auth.nlPort}?connectToken=${auth.nlConnectToken}`);
const id = randomUUID();
const timer = setTimeout(() => { console.error('timeout'); process.exit(2); }, 15000);
ws.onopen = () => ws.send(JSON.stringify({ id, method, data: JSON.parse(data), accessToken: auth.nlToken }));
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id !== id) return; // ignore broadcasts
  clearTimeout(timer);
  console.log(JSON.stringify(msg.data));
  ws.close();
  process.exit(msg.data?.error ? 1 : 0);
};

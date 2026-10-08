/** pnpm --filter @passvault/security-harness stack:up | stack:down */
import { stackDown, stackUp } from './lib/stack';

const cmd = process.argv[2];
if (cmd === 'up') {
  const s = await stackUp({ log: console.log });
  console.log(`API ${s.apiUrl}\nMailpit ${s.mailpitUrl}\nRun suites against it with PV_SEC_KEEP_STACK=1 (the runner reuses it).`);
} else if (cmd === 'down') {
  stackDown(console.log);
} else {
  console.error('usage: stack-cli.ts up|down');
  process.exit(2);
}

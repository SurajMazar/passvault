import 'reflect-metadata';
import { ConfigError, loadConfig } from './config/config';
import { createApp } from './app.factory';

async function bootstrap(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  const app = await createApp(cfg);
  await app.listen(cfg.PORT, cfg.HOST);
}

void bootstrap();

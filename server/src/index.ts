import 'dotenv/config';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/config.js';
import { MapepireMetadataDb } from './db/mapepire.js';
import { createApp } from './app.js';
import { JSON_SOURCE_TEXT_SUPPORTED } from './sql/results.js';

const cfg = loadConfig();
const metadataDb = new MapepireMetadataDb(cfg);
const staticDir =
  process.env.STATIC_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const { app, scheduler, executor } = createApp({ cfg, metadataDb, staticDir });

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(
    `IBM i Query Reports API listening on http://${cfg.host}:${cfg.port} (Mapepire ${cfg.mapepire.host}:${cfg.mapepire.port})`,
  );
});

if (!JSON_SOURCE_TEXT_SUPPORTED)
  console.warn(
    `Node.js ${process.version} lacks JSON.parse source-text access: BIGINT and DECIMAL values wider than 15 digits may be rounded by @ibm/mapepire-js. Run on Node.js 22 or later for exact values.`,
  );

if (cfg.scheduler.enabled) {
  scheduler.start();
  console.log(
    `Scheduler enabled (instance ${scheduler.instanceId}, poll ${cfg.scheduler.pollMs} ms)`,
  );
}

const shutdown = async () => {
  server.close();
  await scheduler.stop();
  await executor.shutdown();
  await metadataDb.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

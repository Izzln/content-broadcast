import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';
import { DeviceHub } from './hub.js';
import { StreamManager } from './streams/manager.js';
import { Controller } from './controller.js';
import { registerRoutes } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.resolve(__dirname, '../public');

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

  const db = new Db(DATA_DIR);
  const streams = new StreamManager(DATA_DIR);
  const hub = new DeviceHub(app.server);
  const controller = new Controller(db, hub, streams);

  // Restreamed HLS output (playlists + segments).
  await app.register(fastifyStatic, {
    root: streams.streamsDir,
    prefix: '/streams/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  });

  // Admin UI (built React app), when present.
  if (fs.existsSync(PUBLIC_DIR)) {
    await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      // SPA fallback for non-API, non-stream paths.
      if (req.raw.url?.startsWith('/api/') || req.raw.url?.startsWith('/streams/')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html', PUBLIC_DIR);
    });
  }

  registerRoutes(app, { db, hub, streams, controller });

  const shutdown = () => {
    streams.stopAll();
    hub.close();
    db.close();
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`data dir: ${DATA_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

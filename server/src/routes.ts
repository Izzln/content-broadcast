import type { FastifyInstance } from 'fastify';
import type { Controller } from './controller.js';
import type { Db } from './db.js';
import type { DeviceHub } from './hub.js';
import type { StreamManager } from './streams/manager.js';
import type { SourceSpec } from './types.js';

interface Deps {
  db: Db;
  hub: DeviceHub;
  streams: StreamManager;
  controller: Controller;
}

function parseSource(body: unknown): SourceSpec | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.url !== 'string' || !b.url.trim()) return null;
  return {
    url: b.url.trim(),
    title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : undefined,
    restream: b.restream === false ? false : undefined,
  };
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, hub, streams, controller } = deps;

  // Full snapshot for the admin UI (polled).
  app.get('/api/state', async () => {
    const displays = db.listDisplays().map((d) => {
      const playback = controller.currentPlayback(d.id);
      return {
        id: d.id,
        name: d.name,
        playlistId: d.playlist_id,
        online: hub.isOnline(d.id),
        playerState: hub.deviceState(d.id) ?? null,
        lastSeenAt: d.last_seen_at,
        nowPlaying: playback
          ? {
              title: playback.title,
              origin: playback.origin,
              sourceUrl: playback.sourceUrl,
              playUrl: playback.playUrl,
            }
          : null,
      };
    });
    const playlists = db.listPlaylists().map((p) => ({
      id: p.id,
      name: p.name,
      items: db.listItems(p.id).map((i) => ({
        id: i.id,
        position: i.position,
        title: i.title,
        url: i.url,
        durationSec: i.duration_sec,
        restream: i.restream === 1,
      })),
    }));
    return {
      displays,
      playlists,
      broadcast: controller.getBroadcast(),
      channels: streams.list(),
    };
  });

  // ---- displays ------------------------------------------------------------

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/displays/:id',
    async (req, reply) => {
      if (!db.getDisplay(req.params.id)) return reply.code(404).send({ error: 'not found' });
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        db.renameDisplay(req.params.id, req.body.name.trim());
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/displays/:id', async (req) => {
    db.deleteDisplay(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/displays/:id/play', async (req, reply) => {
    const source = parseSource(req.body);
    if (!source) return reply.code(400).send({ error: 'url required' });
    if (!db.getDisplay(req.params.id)) return reply.code(404).send({ error: 'not found' });
    controller.playNow(req.params.id, source);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/displays/:id/stop', async (req) => {
    controller.stopAdhoc(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { playlistId: string | null } }>(
    '/api/displays/:id/assign',
    async (req, reply) => {
      if (!db.getDisplay(req.params.id)) return reply.code(404).send({ error: 'not found' });
      const playlistId = req.body?.playlistId ?? null;
      if (playlistId !== null && !db.getPlaylist(playlistId)) {
        return reply.code(400).send({ error: 'unknown playlist' });
      }
      controller.assignPlaylist(req.params.id, playlistId);
      return { ok: true };
    },
  );

  // ---- broadcast (all displays, same content) -------------------------------

  app.post('/api/broadcast', async (req, reply) => {
    const source = parseSource(req.body);
    if (!source) return reply.code(400).send({ error: 'url required' });
    controller.setBroadcast(source);
    return { ok: true };
  });

  app.delete('/api/broadcast', async () => {
    controller.setBroadcast(null);
    return { ok: true };
  });

  // ---- playlists -------------------------------------------------------------

  app.post<{ Body: { name?: string } }>('/api/playlists', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    return db.createPlaylist(name);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/api/playlists/:id',
    async (req, reply) => {
      if (!db.getPlaylist(req.params.id)) return reply.code(404).send({ error: 'not found' });
      if (req.body?.name?.trim()) db.renamePlaylist(req.params.id, req.body.name.trim());
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/playlists/:id', async (req) => {
    db.deletePlaylist(req.params.id);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: { title?: string; url?: string; durationSec?: number | null; restream?: boolean };
  }>('/api/playlists/:id/items', async (req, reply) => {
    if (!db.getPlaylist(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const url = req.body?.url?.trim();
    if (!url) return reply.code(400).send({ error: 'url required' });
    const item = db.addItem(req.params.id, {
      title: req.body?.title?.trim() || url,
      url,
      duration_sec:
        typeof req.body?.durationSec === 'number' && req.body.durationSec > 0
          ? Math.floor(req.body.durationSec)
          : null,
      restream: req.body?.restream,
    });
    controller.refreshDisplaysUsingPlaylist(req.params.id);
    return item;
  });

  app.patch<{
    Params: { playlistId: string; itemId: string };
    Body: {
      title?: string;
      url?: string;
      durationSec?: number | null;
      restream?: boolean;
      position?: number;
    };
  }>('/api/playlists/:playlistId/items/:itemId', async (req) => {
    const b = req.body ?? {};
    db.updateItem(req.params.itemId, {
      title: b.title,
      url: b.url,
      duration_sec:
        b.durationSec === undefined
          ? undefined
          : typeof b.durationSec === 'number' && b.durationSec > 0
            ? Math.floor(b.durationSec)
            : null,
      restream: b.restream,
    });
    if (typeof b.position === 'number') db.moveItem(req.params.itemId, b.position);
    controller.refreshDisplaysUsingPlaylist(req.params.playlistId);
    return { ok: true };
  });

  app.delete<{ Params: { playlistId: string; itemId: string } }>(
    '/api/playlists/:playlistId/items/:itemId',
    async (req) => {
      db.deleteItem(req.params.itemId);
      controller.refreshDisplaysUsingPlaylist(req.params.playlistId);
      return { ok: true };
    },
  );

  app.get('/api/health', async () => ({ ok: true }));
}

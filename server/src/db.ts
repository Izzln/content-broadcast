import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { DisplayRow, PlaylistItemRow, PlaylistRow } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS displays (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  playlist_id  TEXT REFERENCES playlists(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS playlists (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id           TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  duration_sec INTEGER,
  restream     INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Db {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'broadcast.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  // ---- displays --------------------------------------------------------

  upsertDisplay(id: string, name?: string): DisplayRow {
    const existing = this.getDisplay(id);
    if (existing) {
      this.db
        .prepare(`UPDATE displays SET last_seen_at = datetime('now') WHERE id = ?`)
        .run(id);
      return this.getDisplay(id)!;
    }
    const displayName = name || `Display ${id.slice(0, 6)}`;
    this.db
      .prepare(
        `INSERT INTO displays (id, name, last_seen_at) VALUES (?, ?, datetime('now'))`,
      )
      .run(id, displayName);
    return this.getDisplay(id)!;
  }

  getDisplay(id: string): DisplayRow | undefined {
    return this.db.prepare(`SELECT * FROM displays WHERE id = ?`).get(id) as
      | DisplayRow
      | undefined;
  }

  listDisplays(): DisplayRow[] {
    return this.db.prepare(`SELECT * FROM displays ORDER BY created_at`).all() as DisplayRow[];
  }

  renameDisplay(id: string, name: string): void {
    this.db.prepare(`UPDATE displays SET name = ? WHERE id = ?`).run(name, id);
  }

  deleteDisplay(id: string): void {
    this.db.prepare(`DELETE FROM displays WHERE id = ?`).run(id);
  }

  assignPlaylist(displayId: string, playlistId: string | null): void {
    this.db
      .prepare(`UPDATE displays SET playlist_id = ? WHERE id = ?`)
      .run(playlistId, displayId);
  }

  touchDisplay(id: string): void {
    this.db.prepare(`UPDATE displays SET last_seen_at = datetime('now') WHERE id = ?`).run(id);
  }

  // ---- playlists -------------------------------------------------------

  createPlaylist(name: string): PlaylistRow {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO playlists (id, name) VALUES (?, ?)`).run(id, name);
    return { id, name };
  }

  getPlaylist(id: string): PlaylistRow | undefined {
    return this.db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(id) as
      | PlaylistRow
      | undefined;
  }

  listPlaylists(): PlaylistRow[] {
    return this.db.prepare(`SELECT * FROM playlists ORDER BY name`).all() as PlaylistRow[];
  }

  renamePlaylist(id: string, name: string): void {
    this.db.prepare(`UPDATE playlists SET name = ? WHERE id = ?`).run(name, id);
  }

  deletePlaylist(id: string): void {
    this.db.prepare(`DELETE FROM playlists WHERE id = ?`).run(id);
  }

  // ---- playlist items ----------------------------------------------------

  listItems(playlistId: string): PlaylistItemRow[] {
    return this.db
      .prepare(`SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position`)
      .all(playlistId) as PlaylistItemRow[];
  }

  addItem(
    playlistId: string,
    item: { title: string; url: string; duration_sec?: number | null; restream?: boolean },
  ): PlaylistItemRow {
    const id = randomUUID();
    const max = this.db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS max FROM playlist_items WHERE playlist_id = ?`)
      .get(playlistId) as { max: number };
    this.db
      .prepare(
        `INSERT INTO playlist_items (id, playlist_id, position, title, url, duration_sec, restream)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        playlistId,
        max.max + 1,
        item.title,
        item.url,
        item.duration_sec ?? null,
        item.restream === false ? 0 : 1,
      );
    return this.db.prepare(`SELECT * FROM playlist_items WHERE id = ?`).get(id) as PlaylistItemRow;
  }

  updateItem(
    id: string,
    patch: { title?: string; url?: string; duration_sec?: number | null; restream?: boolean },
  ): void {
    const row = this.db.prepare(`SELECT * FROM playlist_items WHERE id = ?`).get(id) as
      | PlaylistItemRow
      | undefined;
    if (!row) return;
    this.db
      .prepare(
        `UPDATE playlist_items SET title = ?, url = ?, duration_sec = ?, restream = ? WHERE id = ?`,
      )
      .run(
        patch.title ?? row.title,
        patch.url ?? row.url,
        patch.duration_sec === undefined ? row.duration_sec : patch.duration_sec,
        patch.restream === undefined ? row.restream : patch.restream ? 1 : 0,
        id,
      );
  }

  deleteItem(id: string): void {
    const row = this.db.prepare(`SELECT * FROM playlist_items WHERE id = ?`).get(id) as
      | PlaylistItemRow
      | undefined;
    if (!row) return;
    this.db.prepare(`DELETE FROM playlist_items WHERE id = ?`).run(id);
    this.db
      .prepare(
        `UPDATE playlist_items SET position = position - 1 WHERE playlist_id = ? AND position > ?`,
      )
      .run(row.playlist_id, row.position);
  }

  moveItem(id: string, newPosition: number): void {
    const row = this.db.prepare(`SELECT * FROM playlist_items WHERE id = ?`).get(id) as
      | PlaylistItemRow
      | undefined;
    if (!row) return;
    const count = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?`)
        .get(row.playlist_id) as { n: number }
    ).n;
    const target = Math.max(0, Math.min(count - 1, newPosition));
    if (target === row.position) return;
    const shift = this.db.prepare(
      target > row.position
        ? `UPDATE playlist_items SET position = position - 1
           WHERE playlist_id = ? AND position > ? AND position <= ?`
        : `UPDATE playlist_items SET position = position + 1
           WHERE playlist_id = ? AND position < ? AND position >= ?`,
    );
    const apply = this.db.transaction(() => {
      shift.run(row.playlist_id, row.position, target);
      this.db.prepare(`UPDATE playlist_items SET position = ? WHERE id = ?`).run(target, id);
    });
    apply();
  }

  // ---- settings ----------------------------------------------------------

  getSetting(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
    } else {
      this.db
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    }
  }

  close(): void {
    this.db.close();
  }
}

import type { Db } from './db.js';
import type { DeviceHub } from './hub.js';
import type { StreamManager } from './streams/manager.js';
import type { Playback, SourceSpec } from './types.js';

const BROADCAST_KEY = 'broadcast';
/** Ignore duplicate advance triggers (TV "ended" + channel end) within this window. */
const ADVANCE_DEBOUNCE_MS = 3_000;

interface DisplayRuntime {
  adhoc: SourceSpec | null;
  playlistIndex: number;
  current: Playback | null;
  itemTimer: NodeJS.Timeout | null;
  lastAdvanceAt: number;
}

/**
 * Decides what every display should be showing and pushes it to the TVs.
 * Priority: global broadcast > ad-hoc "play now" > assigned playlist.
 */
export class Controller {
  private runtimes = new Map<string, DisplayRuntime>();

  constructor(
    private db: Db,
    private hub: DeviceHub,
    private streams: StreamManager,
  ) {
    hub.on('hello', (deviceId: string, name?: string) => {
      this.db.upsertDisplay(deviceId, name);
      this.apply(deviceId);
    });
    hub.on('disconnect', (deviceId: string) => this.suspend(deviceId));
    hub.on('ended', (deviceId: string) => this.onEnded(deviceId));
    hub.on('status', (deviceId: string) => this.db.touchDisplay(deviceId));
    streams.on('channel-ended', (channelId: string) => {
      for (const [displayId, rt] of this.runtimes) {
        if (rt.current?.channelId === channelId) this.onEnded(displayId);
      }
    });
  }

  // ---- admin actions -----------------------------------------------------

  playNow(displayId: string, source: SourceSpec): void {
    const rt = this.runtime(displayId);
    rt.adhoc = source;
    this.apply(displayId);
  }

  /** Clear ad-hoc content; the display falls back to its playlist (or idles). */
  stopAdhoc(displayId: string): void {
    const rt = this.runtime(displayId);
    rt.adhoc = null;
    this.apply(displayId);
  }

  assignPlaylist(displayId: string, playlistId: string | null): void {
    this.db.assignPlaylist(displayId, playlistId);
    const rt = this.runtime(displayId);
    rt.playlistIndex = 0;
    this.apply(displayId);
  }

  setBroadcast(source: SourceSpec | null): void {
    this.db.setSetting(BROADCAST_KEY, source ? JSON.stringify(source) : null);
    for (const id of this.hub.onlineIds()) this.apply(id);
  }

  getBroadcast(): SourceSpec | null {
    const raw = this.db.getSetting(BROADCAST_KEY);
    return raw ? (JSON.parse(raw) as SourceSpec) : null;
  }

  /** Re-push state after playlist content changed in the admin UI. */
  refreshDisplaysUsingPlaylist(playlistId: string): void {
    for (const display of this.db.listDisplays()) {
      if (display.playlist_id === playlistId && this.hub.isOnline(display.id)) {
        this.apply(display.id);
      }
    }
  }

  currentPlayback(displayId: string): Playback | null {
    return this.runtimes.get(displayId)?.current ?? null;
  }

  // ---- playback resolution -------------------------------------------------

  /** Compute and push what displayId should be playing right now. */
  private apply(displayId: string): void {
    const rt = this.runtime(displayId);
    const desired = this.resolveDesired(displayId, rt);

    if (desired === null) {
      this.setCurrent(displayId, rt, null);
      this.hub.sendTo(displayId, { type: 'stop' });
      return;
    }
    if (
      rt.current &&
      rt.current.playUrl === desired.playUrl &&
      rt.current.origin === desired.origin
    ) {
      return; // already playing the right thing
    }
    this.setCurrent(displayId, rt, desired);
    this.hub.sendTo(displayId, { type: 'play', url: desired.playUrl, title: desired.title });
  }

  private resolveDesired(displayId: string, rt: DisplayRuntime): Playback | null {
    const broadcast = this.getBroadcast();
    if (broadcast) return this.toPlayback(displayId, broadcast, 'broadcast');
    if (rt.adhoc) return this.toPlayback(displayId, rt.adhoc, 'adhoc');

    const display = this.db.getDisplay(displayId);
    if (!display?.playlist_id) return null;
    const items = this.db.listItems(display.playlist_id);
    if (items.length === 0) return null;
    if (rt.playlistIndex >= items.length) rt.playlistIndex = 0;
    const item = items[rt.playlistIndex];
    const playback = this.toPlayback(
      displayId,
      { url: item.url, title: item.title, restream: item.restream === 1 },
      'playlist',
    );
    // Rotate on a timer when the item has an explicit duration (needed for
    // live sources, which never end on their own).
    if (item.duration_sec && item.duration_sec > 0) {
      if (rt.itemTimer) clearTimeout(rt.itemTimer);
      rt.itemTimer = setTimeout(() => this.advance(displayId), item.duration_sec * 1_000);
      rt.itemTimer.unref();
    }
    return playback;
  }

  private toPlayback(
    displayId: string,
    source: SourceSpec,
    origin: Playback['origin'],
  ): Playback {
    const title = source.title || source.url;
    if (source.restream === false) {
      return { playUrl: source.url, title, origin, sourceUrl: source.url };
    }
    const { channelId, hlsPath } = this.streams.acquire(source.url, displayId);
    // hlsPath is server-relative; the TV resolves it against its configured
    // server address, so the server never needs to know its own LAN IP.
    return { playUrl: hlsPath, title, origin, sourceUrl: source.url, channelId };
  }

  private setCurrent(displayId: string, rt: DisplayRuntime, next: Playback | null): void {
    if (rt.current?.channelId && rt.current.channelId !== next?.channelId) {
      this.streams.release(rt.current.channelId, displayId);
    }
    if (rt.itemTimer && (next === null || next.origin !== 'playlist')) {
      clearTimeout(rt.itemTimer);
      rt.itemTimer = null;
    }
    rt.current = next;
  }

  // ---- progression ---------------------------------------------------------

  private onEnded(displayId: string): void {
    const rt = this.runtime(displayId);
    if (!rt.current) return;
    if (rt.current.origin === 'adhoc') {
      rt.adhoc = null;
      this.apply(displayId);
      return;
    }
    if (rt.current.origin === 'playlist') this.advance(displayId);
    // 'broadcast' that ends just stays until the admin changes it; the TV
    // idles on the ended stream.
  }

  private advance(displayId: string): void {
    const rt = this.runtime(displayId);
    const now = Date.now();
    if (now - rt.lastAdvanceAt < ADVANCE_DEBOUNCE_MS) return;
    rt.lastAdvanceAt = now;
    const display = this.db.getDisplay(displayId);
    if (!display?.playlist_id) return;
    const items = this.db.listItems(display.playlist_id);
    if (items.length === 0) return;
    rt.playlistIndex = (rt.playlistIndex + 1) % items.length;
    // Force re-apply even if the next item resolves to the same URL (single-item
    // VOD playlist looping): clear current first.
    this.setCurrent(displayId, rt, null);
    this.apply(displayId);
  }

  /** Display went offline: stop holding stream resources for it. */
  private suspend(displayId: string): void {
    const rt = this.runtimes.get(displayId);
    if (!rt) return;
    this.setCurrent(displayId, rt, null);
  }

  private runtime(displayId: string): DisplayRuntime {
    let rt = this.runtimes.get(displayId);
    if (!rt) {
      rt = { adhoc: null, playlistIndex: 0, current: null, itemTimer: null, lastAdvanceAt: 0 };
      this.runtimes.set(displayId, rt);
    }
    return rt;
  }
}

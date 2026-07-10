export interface NowPlaying {
  title: string;
  origin: 'broadcast' | 'adhoc' | 'playlist';
  sourceUrl: string;
  playUrl: string;
}

export interface Display {
  id: string;
  name: string;
  playlistId: string | null;
  online: boolean;
  playerState: string | null;
  lastSeenAt: string | null;
  nowPlaying: NowPlaying | null;
}

export interface PlaylistItem {
  id: string;
  position: number;
  title: string;
  url: string;
  durationSec: number | null;
  restream: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
}

export interface Channel {
  id: string;
  sourceUrl: string;
  state: string;
  viewers: string[];
  error?: string;
}

export interface Broadcast {
  url: string;
  title?: string;
  restream?: boolean;
}

export interface State {
  displays: Display[];
  playlists: Playlist[];
  broadcast: Broadcast | null;
  channels: Channel[];
}

async function req(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) detail = data.error;
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  state: () => req('/api/state') as Promise<State>,
  renameDisplay: (id: string, name: string) => req(`/api/displays/${id}`, 'PATCH', { name }),
  deleteDisplay: (id: string) => req(`/api/displays/${id}`, 'DELETE'),
  playNow: (id: string, url: string, title?: string) =>
    req(`/api/displays/${id}/play`, 'POST', { url, title }),
  stopAdhoc: (id: string) => req(`/api/displays/${id}/stop`, 'POST'),
  assign: (id: string, playlistId: string | null) =>
    req(`/api/displays/${id}/assign`, 'POST', { playlistId }),
  setBroadcast: (url: string, title?: string) => req('/api/broadcast', 'POST', { url, title }),
  clearBroadcast: () => req('/api/broadcast', 'DELETE'),
  createPlaylist: (name: string) => req('/api/playlists', 'POST', { name }),
  renamePlaylist: (id: string, name: string) => req(`/api/playlists/${id}`, 'PATCH', { name }),
  deletePlaylist: (id: string) => req(`/api/playlists/${id}`, 'DELETE'),
  addItem: (
    playlistId: string,
    item: { title?: string; url: string; durationSec?: number | null; restream?: boolean },
  ) => req(`/api/playlists/${playlistId}/items`, 'POST', item),
  updateItem: (
    playlistId: string,
    itemId: string,
    patch: Partial<{ title: string; url: string; durationSec: number | null; restream: boolean; position: number }>,
  ) => req(`/api/playlists/${playlistId}/items/${itemId}`, 'PATCH', patch),
  deleteItem: (playlistId: string, itemId: string) =>
    req(`/api/playlists/${playlistId}/items/${itemId}`, 'DELETE'),
};

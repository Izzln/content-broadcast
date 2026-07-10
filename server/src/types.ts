/** A piece of content an admin can schedule or play ad-hoc. */
export interface SourceSpec {
  /** Original URL as entered by the admin (YouTube, ABEMA, direct HLS/MP4, ...). */
  url: string;
  title?: string;
  /**
   * When true (default) the server pulls the source via yt-dlp/ffmpeg and
   * re-serves it as local HLS. When false the TV plays the URL directly —
   * only useful for URLs reachable from the venue LAN.
   */
  restream?: boolean;
}

export interface PlaylistItemRow {
  id: string;
  playlist_id: string;
  position: number;
  title: string;
  url: string;
  /** null = play to the end (VOD) or indefinitely (live). */
  duration_sec: number | null;
  restream: number; // sqlite boolean
}

export interface PlaylistRow {
  id: string;
  name: string;
}

export interface DisplayRow {
  id: string;
  name: string;
  playlist_id: string | null;
  created_at: string;
  last_seen_at: string | null;
}

/** What a display should be showing right now, resolved to a playable URL. */
export interface Playback {
  /** URL the TV should feed to its player (local HLS path or direct URL). */
  playUrl: string;
  title: string;
  /** Where the content came from, for the admin UI. */
  origin: 'broadcast' | 'adhoc' | 'playlist';
  sourceUrl: string;
  /** Channel id when the content is restreamed by this server. */
  channelId?: string;
}

// ---- WebSocket protocol -----------------------------------------------

/** TV -> server */
export type DeviceMessage =
  | { type: 'hello'; deviceId: string; name?: string }
  | { type: 'status'; state: 'playing' | 'idle' | 'buffering' | 'error'; detail?: string }
  | { type: 'ended' }
  | { type: 'pong' };

/** server -> TV */
export type ServerMessage =
  | { type: 'play'; url: string; title: string }
  | { type: 'stop' }
  | { type: 'ping' };

export type ChannelState = 'starting' | 'running' | 'error' | 'stopped';

export interface ChannelInfo {
  id: string;
  sourceUrl: string;
  state: ChannelState;
  viewers: string[];
  error?: string;
}

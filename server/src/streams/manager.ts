import { spawn, ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelInfo, ChannelState } from '../types.js';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
/** HTTP/SOCKS proxy used for pulling upstream sources (the VPN egress). */
const PROXY = process.env.RESTREAM_PROXY || '';
/** Set RESTREAM_TRANSCODE=1 to force h264/aac transcoding instead of stream copy. */
const TRANSCODE = process.env.RESTREAM_TRANSCODE === '1';
/** Prefer h264+aac so stream-copied output stays playable in HLS/TS. */
const FORMAT = process.env.RESTREAM_FORMAT || 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/b';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const IDLE_STOP_MS = 30_000;
const MAX_RESTARTS = 5;

const DIRECT_RE = /\.(m3u8|mp4|ts|mpd|flv|webm|mkv)(\?.*)?$/i;
const DIRECT_SCHEMES = ['rtmp://', 'rtsp://', 'udp://', 'srt://'];

interface ResolvedSource {
  inputs: string[];
  isLive: boolean;
  headers: string[];
}

class Channel extends EventEmitter {
  readonly id: string;
  readonly sourceUrl: string;
  state: ChannelState = 'starting';
  error?: string;
  viewers = new Set<string>();
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly dir: string;

  constructor(sourceUrl: string, streamsDir: string) {
    super();
    this.sourceUrl = sourceUrl;
    this.id = createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
    this.dir = path.join(streamsDir, this.id);
  }

  get hlsPath(): string {
    return `/streams/${this.id}/index.m3u8`;
  }

  async start(): Promise<void> {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    let resolved: ResolvedSource;
    try {
      resolved = await this.resolve();
    } catch (err) {
      this.fail(`resolve failed: ${(err as Error).message}`);
      return;
    }
    if (this.stopping) return;
    this.runFfmpeg(resolved);
  }

  addViewer(displayId: string): void {
    this.viewers.add(displayId);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  removeViewer(displayId: string): void {
    this.viewers.delete(displayId);
    if (this.viewers.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.emit('idle'), IDLE_STOP_MS);
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.proc && this.proc.exitCode === null) {
      const proc = this.proc;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5_000).unref();
    }
    this.state = 'stopped';
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Resolve the admin-entered URL to direct media input(s) for ffmpeg. */
  private async resolve(): Promise<ResolvedSource> {
    const lower = this.sourceUrl.toLowerCase();
    if (DIRECT_RE.test(this.sourceUrl) || DIRECT_SCHEMES.some((s) => lower.startsWith(s))) {
      return {
        inputs: [this.sourceUrl],
        // Unknown for direct URLs; assume live-ish (no -re pacing) unless plain file.
        isLive: !/\.(mp4|webm|mkv)(\?.*)?$/i.test(this.sourceUrl),
        headers: [],
      };
    }
    const args = ['-j', '--no-playlist', '-f', FORMAT];
    if (PROXY) args.push('--proxy', PROXY);
    args.push(this.sourceUrl);
    const json = await runCapture(YTDLP, args, 60_000);
    const info = JSON.parse(json);
    const formats: Array<{ url: string; http_headers?: Record<string, string> }> =
      info.requested_formats ?? (info.url ? [{ url: info.url, http_headers: info.http_headers }] : []);
    if (formats.length === 0) throw new Error('yt-dlp returned no playable formats');
    const headers: string[] = [];
    const h = formats[0].http_headers;
    if (h) {
      for (const [k, v] of Object.entries(h)) {
        if (/^(user-agent|referer|origin|cookie)$/i.test(k)) headers.push(`${k}: ${v}`);
      }
    }
    return { inputs: formats.map((f) => f.url), isLive: Boolean(info.is_live), headers };
  }

  private runFfmpeg(src: ResolvedSource): void {
    const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
    for (const input of src.inputs) {
      if (/^https?:/i.test(input)) {
        args.push('-user_agent', USER_AGENT);
        if (src.headers.length > 0) args.push('-headers', src.headers.join('\r\n') + '\r\n');
        if (PROXY && /^http/i.test(PROXY)) args.push('-http_proxy', PROXY);
        args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10');
      }
      if (!src.isLive) args.push('-re');
      args.push('-i', input);
    }
    if (src.inputs.length > 1) {
      args.push('-map', '0:v:0', '-map', '1:a:0');
    } else {
      args.push('-map', '0:v:0?', '-map', '0:a:0?');
    }
    if (TRANSCODE) {
      args.push(
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
      );
    } else {
      args.push('-c', 'copy');
    }
    args.push('-f', 'hls', '-hls_time', '4');
    if (src.isLive) {
      // Sliding window, playlist never ends.
      args.push('-hls_list_size', '6', '-hls_flags', 'delete_segments+omit_endlist');
    } else {
      // Keep every segment so displays joining mid-way can still play through;
      // ffmpeg appends ENDLIST on completion so players fire "ended".
      args.push('-hls_list_size', '0');
    }
    args.push(
      '-hls_segment_filename', path.join(this.dir, 'seg%06d.ts'),
      path.join(this.dir, 'index.m3u8'),
    );

    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    let stderrTail = '';
    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    proc.once('spawn', () => {
      if (this.state === 'starting') this.state = 'running';
    });
    proc.once('exit', (code) => {
      if (this.stopping) return;
      if (code === 0 && !src.isLive) {
        // VOD played through: keep segments so late joiners can finish, mark ended.
        this.state = 'stopped';
        this.emit('ended');
        return;
      }
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** this.restarts);
        console.warn(
          `[stream ${this.id}] ffmpeg exited (code ${code}), restart ${this.restarts}/${MAX_RESTARTS} in ${delay}ms`,
        );
        setTimeout(() => {
          if (!this.stopping) void this.start();
        }, delay).unref();
      } else {
        this.fail(`ffmpeg kept failing (last exit ${code}): ${stderrTail.slice(-500)}`);
      }
    });
    proc.once('error', (err) => {
      this.fail(`failed to spawn ffmpeg: ${err.message}`);
    });
  }

  private fail(message: string): void {
    console.error(`[stream ${this.id}] ${message}`);
    this.state = 'error';
    this.error = message;
    this.emit('error-state', message);
  }
}

function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-1000)));
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
  });
}

export class StreamManager extends EventEmitter {
  private channels = new Map<string, Channel>();
  readonly streamsDir: string;

  constructor(dataDir: string) {
    super();
    this.streamsDir = path.join(dataDir, 'streams');
    fs.mkdirSync(this.streamsDir, { recursive: true });
    // Clear leftovers from a previous run.
    for (const entry of fs.readdirSync(this.streamsDir)) {
      fs.rmSync(path.join(this.streamsDir, entry), { recursive: true, force: true });
    }
  }

  /**
   * Ensure a restream channel exists for sourceUrl and count displayId as a
   * viewer. Returns the local HLS path the TV should play.
   */
  acquire(sourceUrl: string, displayId: string): { channelId: string; hlsPath: string } {
    let channel = [...this.channels.values()].find(
      (c) => c.sourceUrl === sourceUrl && c.state !== 'error' && c.state !== 'stopped',
    );
    if (!channel) {
      channel = new Channel(sourceUrl, this.streamsDir);
      this.channels.set(channel.id, channel);
      channel.on('idle', () => this.destroy(channel!.id));
      channel.on('ended', () => this.emit('channel-ended', channel!.id));
      channel.on('error-state', () => this.emit('channel-error', channel!.id));
      void channel.start();
    }
    channel.addViewer(displayId);
    return { channelId: channel.id, hlsPath: channel.hlsPath };
  }

  release(channelId: string, displayId: string): void {
    this.channels.get(channelId)?.removeViewer(displayId);
  }

  destroy(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.stop();
    this.channels.delete(channelId);
  }

  list(): ChannelInfo[] {
    return [...this.channels.values()].map((c) => ({
      id: c.id,
      sourceUrl: c.sourceUrl,
      state: c.state,
      viewers: [...c.viewers],
      error: c.error,
    }));
  }

  stopAll(): void {
    for (const id of [...this.channels.keys()]) this.destroy(id);
  }
}

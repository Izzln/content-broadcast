// End-to-end smoke test: fake TV over WS + REST admin actions + restream pipeline.
// Run against a fresh server instance (empty DATA_DIR):
//   DATA_DIR=/tmp/cb-test PORT=8080 npm run dev     # terminal 1
//   npm run smoke                                   # terminal 2
// Requires ffmpeg on PATH (used to generate local test clips).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const api = async (path, method = 'GET', body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake TV ---------------------------------------------------------------
const received = [];
const ws = new WebSocket(WS_URL);
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type !== 'ping') {
    received.push(msg);
    console.log('  [tv] <-', JSON.stringify(msg));
  }
});
ws.send(JSON.stringify({ type: 'hello', deviceId: 'test-tv-0001', name: 'Smoke TV' }));
await sleep(500);

// 1. display auto-registered and online
let state = (await api('/api/state')).json;
const disp = state.displays.find((d) => d.id === 'test-tv-0001');
ok('display auto-registers on hello', disp && disp.online, JSON.stringify(disp?.name));

// 2. rename
await api('/api/displays/test-tv-0001', 'PATCH', { name: 'Counter TV' });
state = (await api('/api/state')).json;
ok('rename display', state.displays[0].name === 'Counter TV');

// 3. ad-hoc play of local test files through the restream pipeline
const clipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-smoke-'));
const makeClip = (name) => {
  const file = path.join(clipDir, name);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', file,
  ]);
  return file;
};
console.log('generating test clips…');
const src = makeClip('test-a.mp4');
const srcB = makeClip('test-b.mp4');
const srcC = makeClip('test-c.mp4');
await api('/api/displays/test-tv-0001/play', 'POST', { url: src, title: 'Test clip' });
await sleep(1000);
const play1 = received.find((m) => m.type === 'play');
ok('TV receives play command', play1, JSON.stringify(play1));
ok('play URL is local HLS path', play1 && play1.url.startsWith('/streams/'), play1?.url);

// ffmpeg paces VOD in realtime (-re); poll for the first segment.
let m3u8 = { status: 0 };
for (let i = 0; i < 15 && play1; i++) {
  m3u8 = await api(play1.url);
  if (m3u8.status === 200) break;
  await sleep(1000);
}
ok('HLS playlist served', m3u8.status === 200 && String(m3u8.json).includes('#EXTM3U'),
  `status=${m3u8.status}`);
ok('HLS has segments', String(m3u8.json).includes('.ts'));

state = (await api('/api/state')).json;
ok('channel visible in state', state.channels.length === 1 && state.channels[0].state === 'running',
  JSON.stringify(state.channels));
ok('nowPlaying origin adhoc', state.displays[0].nowPlaying?.origin === 'adhoc');

// 4. playlist with two items + assignment; adhoc end falls back to playlist
const pl = (await api('/api/playlists', 'POST', { name: 'News loop' })).json;
await api(`/api/playlists/${pl.id}/items`, 'POST', { title: 'Clip A', url: src });
await api(`/api/playlists/${pl.id}/items`, 'POST', { title: 'Clip B', url: srcB });
await api('/api/displays/test-tv-0001/assign', 'POST', { playlistId: pl.id });

// adhoc still wins until it ends
state = (await api('/api/state')).json;
ok('adhoc outranks playlist', state.displays[0].nowPlaying?.origin === 'adhoc');

received.length = 0;
ws.send(JSON.stringify({ type: 'ended' })); // adhoc content finished
await sleep(1500);
const play2 = received.find((m) => m.type === 'play');
ok('falls back to playlist item 1 after adhoc ends', play2 && play2.title === 'Clip A',
  JSON.stringify(play2));

// 5. ended -> advance to item 2 (respecting debounce)
await sleep(3000);
received.length = 0;
ws.send(JSON.stringify({ type: 'ended' }));
await sleep(1500);
const play3 = received.find((m) => m.type === 'play');
ok('playlist advances to Clip B on ended', play3 && play3.title === 'Clip B',
  JSON.stringify(play3));

// 6. broadcast overrides everything
received.length = 0;
await api('/api/broadcast', 'POST', { url: srcC, title: 'All hands' });
await sleep(2500);
const play4 = received.find((m) => m.type === 'play');
ok('broadcast pushed to TV', play4 && play4.title === 'All hands', JSON.stringify(play4));
state = (await api('/api/state')).json;
ok('broadcast in state', state.broadcast?.title === 'All hands');

await api('/api/broadcast', 'DELETE');
await sleep(1500);
state = (await api('/api/state')).json;
ok('broadcast cleared, back to playlist', state.displays[0].nowPlaying?.origin === 'playlist',
  JSON.stringify(state.displays[0].nowPlaying));

// 7. direct (no restream) play
received.length = 0;
await api('/api/displays/test-tv-0001/play', 'POST',
  { url: 'http://192.168.1.50/lan.mp4', restream: false });
await sleep(800);
const play5 = received.find((m) => m.type === 'play');
ok('restream:false sends direct URL', play5 && play5.url === 'http://192.168.1.50/lan.mp4',
  JSON.stringify(play5));

// 8. stop adhoc -> back to playlist
await api('/api/displays/test-tv-0001/stop', 'POST');
await sleep(1200);
state = (await api('/api/state')).json;
ok('stop adhoc returns to playlist', state.displays[0].nowPlaying?.origin === 'playlist');

// 9. disconnect -> offline
ws.close();
await sleep(800);
state = (await api('/api/state')).json;
ok('display offline after disconnect', state.displays[0].online === false);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

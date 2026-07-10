import { useCallback, useEffect, useState } from 'react';
import { api, type Display, type Playlist, type State } from './api';
import { Player } from './Player';

const ORIGIN_LABEL = { broadcast: 'Broadcast', adhoc: 'Play now', playlist: 'Playlist' } as const;

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [refresh],
  );

  if (!state) {
    return <div className="loading">{error ? `Cannot reach server: ${error}` : 'Loading…'}</div>;
  }

  return (
    <div className="app">
      <header>
        <h1>Content Broadcast</h1>
        {error && <div className="error-bar">{error}</div>}
      </header>

      <BroadcastBar state={state} act={act} />

      <section>
        <h2>Displays</h2>
        {state.displays.length === 0 && (
          <p className="hint">
            No displays yet. Install the TV app and point it at this server — displays register
            themselves automatically.
          </p>
        )}
        <div className="display-grid">
          {state.displays.map((d) => (
            <DisplayCard
              key={d.id}
              display={d}
              playlists={state.playlists}
              act={act}
              onPreview={(title, url) => setPreview({ title, url })}
            />
          ))}
        </div>
      </section>

      <section>
        <h2>Playlists</h2>
        <Playlists playlists={state.playlists} act={act} />
      </section>

      {state.channels.length > 0 && (
        <section>
          <h2>Active streams</h2>
          <table className="channels">
            <thead>
              <tr>
                <th>Source</th>
                <th>State</th>
                <th>Viewers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.channels.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.sourceUrl}</td>
                  <td>
                    <span className={`chip chip-${c.state}`}>{c.state}</span>
                    {c.error && <span className="hint"> {c.error}</span>}
                  </td>
                  <td>{c.viewers.length}</td>
                  <td>
                    <button
                      onClick={() =>
                        setPreview({ title: c.sourceUrl, url: `/streams/${c.id}/index.m3u8` })
                      }
                    >
                      Preview
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{preview.title}</span>
              <button onClick={() => setPreview(null)}>✕</button>
            </div>
            <Player src={preview.url} />
          </div>
        </div>
      )}
    </div>
  );
}

function BroadcastBar({
  state,
  act,
}: {
  state: State;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const active = state.broadcast;
  return (
    <section className={`broadcast ${active ? 'broadcast-active' : ''}`}>
      <h2>All displays</h2>
      {active ? (
        <div className="row">
          <span>
            Broadcasting <strong>{active.title || active.url}</strong> to every display
          </span>
          <button className="danger" onClick={() => act(() => api.clearBroadcast())}>
            Stop broadcast
          </button>
        </div>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim()) return;
            void act(() => api.setBroadcast(url.trim())).then(() => setUrl(''));
          }}
        >
          <input
            placeholder="YouTube / ABEMA / stream URL — play on ALL displays"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="submit" className="primary">
            Broadcast to all
          </button>
        </form>
      )}
    </section>
  );
}

function DisplayCard({
  display,
  playlists,
  act,
  onPreview,
}: {
  display: Display;
  playlists: Playlist[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onPreview: (title: string, url: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const np = display.nowPlaying;

  return (
    <div className={`card ${display.online ? '' : 'card-offline'}`}>
      <div className="card-head">
        <span className={`dot ${display.online ? 'dot-on' : 'dot-off'}`} />
        {editingName === null ? (
          <strong onDoubleClick={() => setEditingName(display.name)} title="Double-click to rename">
            {display.name}
          </strong>
        ) : (
          <input
            autoFocus
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => {
              if (editingName.trim()) void act(() => api.renameDisplay(display.id, editingName.trim()));
              setEditingName(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        )}
        <button
          className="ghost"
          title="Remove display"
          onClick={() => {
            if (confirm(`Remove display "${display.name}"?`)) {
              void act(() => api.deleteDisplay(display.id));
            }
          }}
        >
          ✕
        </button>
      </div>

      <div className="now-playing">
        {np ? (
          <>
            <span className={`chip chip-${np.origin}`}>{ORIGIN_LABEL[np.origin]}</span>{' '}
            <span className="title">{np.title}</span>{' '}
            {np.playUrl.startsWith('/streams/') && (
              <button className="ghost" onClick={() => onPreview(np.title, np.playUrl)}>
                preview
              </button>
            )}
            {np.origin === 'adhoc' && (
              <button className="ghost danger" onClick={() => act(() => api.stopAdhoc(display.id))}>
                stop
              </button>
            )}
          </>
        ) : (
          <span className="hint">{display.online ? 'Idle' : 'Offline'}</span>
        )}
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          void act(() => api.playNow(display.id, url.trim())).then(() => setUrl(''));
        }}
      >
        <input
          placeholder="Play a link now…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit">Play</button>
      </form>

      <label className="row">
        <span className="hint">Playlist</span>
        <select
          value={display.playlistId ?? ''}
          onChange={(e) => act(() => api.assign(display.id, e.target.value || null))}
        >
          <option value="">— none —</option>
          {playlists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Playlists({
  playlists,
  act,
}: {
  playlists: Playlist[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [newName, setNewName] = useState('');
  return (
    <div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          void act(() => api.createPlaylist(newName.trim())).then(() => setNewName(''));
        }}
      >
        <input
          placeholder="New playlist name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit">Create playlist</button>
      </form>
      {playlists.map((p) => (
        <PlaylistEditor key={p.id} playlist={p} act={act} />
      ))}
    </div>
  );
}

function PlaylistEditor({
  playlist,
  act,
}: {
  playlist: Playlist;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState('');

  return (
    <div className="card playlist">
      <div className="card-head">
        <strong>{playlist.name}</strong>
        <button
          className="ghost"
          title="Delete playlist"
          onClick={() => {
            if (confirm(`Delete playlist "${playlist.name}"?`)) {
              void act(() => api.deletePlaylist(playlist.id));
            }
          }}
        >
          ✕
        </button>
      </div>
      {playlist.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>URL</th>
              <th title="Blank = play to the end (VOD) or until changed (live)">Duration (s)</th>
              <th title="Pull via server (needed when TVs cannot reach the source)">Restream</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {playlist.items.map((item, idx) => (
              <tr key={item.id}>
                <td>{idx + 1}</td>
                <td>{item.title}</td>
                <td className="mono">{item.url}</td>
                <td>{item.durationSec ?? '—'}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={item.restream}
                    onChange={(e) =>
                      act(() => api.updateItem(playlist.id, item.id, { restream: e.target.checked }))
                    }
                  />
                </td>
                <td className="actions">
                  <button
                    className="ghost"
                    disabled={idx === 0}
                    onClick={() =>
                      act(() => api.updateItem(playlist.id, item.id, { position: idx - 1 }))
                    }
                  >
                    ↑
                  </button>
                  <button
                    className="ghost"
                    disabled={idx === playlist.items.length - 1}
                    onClick={() =>
                      act(() => api.updateItem(playlist.id, item.id, { position: idx + 1 }))
                    }
                  >
                    ↓
                  </button>
                  <button
                    className="ghost danger"
                    onClick={() => act(() => api.deleteItem(playlist.id, item.id))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          void act(() =>
            api.addItem(playlist.id, {
              title: title.trim() || undefined,
              url: url.trim(),
              durationSec: duration ? Number(duration) : null,
            }),
          ).then(() => {
            setTitle('');
            setUrl('');
            setDuration('');
          });
        }}
      >
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input
          placeholder="URL (YouTube / ABEMA / HLS / MP4)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: 2 }}
        />
        <input
          placeholder="Duration s (live)"
          value={duration}
          onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))}
          style={{ width: '8rem' }}
        />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}

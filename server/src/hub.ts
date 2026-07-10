import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { DeviceMessage, ServerMessage } from './types.js';

const HEARTBEAT_MS = 20_000;

interface DeviceSession {
  socket: WebSocket;
  deviceId: string;
  lastState: string;
  alive: boolean;
}

/**
 * WebSocket hub for TV clients. TVs connect to /ws, identify with a `hello`
 * message, then receive play/stop commands and report status/ended events.
 *
 * Events: 'hello' (deviceId, name?), 'ended' (deviceId),
 * 'status' (deviceId, state), 'disconnect' (deviceId).
 */
export class DeviceHub extends EventEmitter {
  private sessions = new Map<string, DeviceSession>();
  private wss: WebSocketServer;
  private heartbeat: NodeJS.Timeout;

  constructor(httpServer: HttpServer) {
    super();
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private onConnection(socket: WebSocket): void {
    let session: DeviceSession | null = null;

    socket.on('message', (data) => {
      let msg: DeviceMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'hello' && typeof msg.deviceId === 'string' && msg.deviceId) {
        // Replace any stale session for the same device (e.g. after TV reboot).
        const old = this.sessions.get(msg.deviceId);
        if (old && old.socket !== socket) old.socket.terminate();
        session = { socket, deviceId: msg.deviceId, lastState: 'idle', alive: true };
        this.sessions.set(msg.deviceId, session);
        this.emit('hello', msg.deviceId, msg.name);
        return;
      }
      if (!session) return; // ignore anything before hello
      session.alive = true;
      switch (msg.type) {
        case 'status':
          session.lastState = msg.state;
          this.emit('status', session.deviceId, msg.state, msg.detail);
          break;
        case 'ended':
          this.emit('ended', session.deviceId);
          break;
        case 'pong':
          break;
      }
    });

    socket.on('pong', () => {
      if (session) session.alive = true;
    });

    socket.on('close', () => {
      if (session && this.sessions.get(session.deviceId)?.socket === socket) {
        this.sessions.delete(session.deviceId);
        this.emit('disconnect', session.deviceId);
      }
    });

    socket.on('error', () => socket.terminate());
  }

  private pingAll(): void {
    for (const [deviceId, session] of this.sessions) {
      if (!session.alive) {
        session.socket.terminate();
        this.sessions.delete(deviceId);
        this.emit('disconnect', deviceId);
        continue;
      }
      session.alive = false;
      try {
        session.socket.ping();
        this.sendTo(deviceId, { type: 'ping' });
      } catch {
        // handled by close/error
      }
    }
  }

  sendTo(deviceId: string, message: ServerMessage): boolean {
    const session = this.sessions.get(deviceId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) return false;
    session.socket.send(JSON.stringify(message));
    return true;
  }

  isOnline(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  deviceState(deviceId: string): string | undefined {
    return this.sessions.get(deviceId)?.lastState;
  }

  onlineIds(): string[] {
    return [...this.sessions.keys()];
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.wss.close();
    for (const s of this.sessions.values()) s.socket.terminate();
    this.sessions.clear();
  }
}

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Side } from '../engine/types.js';
import type { ServerMessage } from '../shared/protocol.js';

/** Overlay sockets per server: two local overlays plus a remote partner and a few reloads. */
export const DEFAULT_MAX_CLIENTS = 64;
/** Ping cadence: detects dead sockets and keeps tunnels from closing idle connections. */
export const DEFAULT_HEARTBEAT_MS = 30_000;
/** Slow consumers are dropped instead of buffering snapshots without bound. */
const MAX_BUFFERED_BYTES = 1_000_000;

export type UpgradeDecision =
  | { readonly ok: true; readonly side: Side }
  | { readonly ok: false; readonly status: 400 | 403 | 404 };

export interface WsHubOptions {
  /** Access model for `GET /ws?side=A|B[&room=TOKEN]` (see access.ts). */
  readonly authorize: (request: IncomingMessage, url: URL) => UpgradeDecision;
  /** Connect sequence: hello → meta → round → snapshot (protocol.ts). */
  readonly initialMessages: (side: Side) => readonly ServerMessage[];
  readonly maxClients?: number;
  readonly heartbeatMs?: number;
}

export interface WsHub {
  broadcast(message: ServerMessage): void;
  clientCount(): number;
  close(): Promise<void>;
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

function refuseUpgrade(socket: Duplex, status: number): void {
  // Same pattern as ws' own abortHandshake: flush the status line, then drop the socket.
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function attachWsHub(server: Server, options: WsHubOptions): WsHub {
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const alive = new WeakSet<WebSocket>();

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    // This listener runs synchronously outside any request promise: a throw here (e.g. a
    // request-target like `//x:99999` that WHATWG URL rejects) would crash the whole process.
    let decision: UpgradeDecision;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      decision = options.authorize(request, url);
    } catch {
      refuseUpgrade(socket, 400);
      return;
    }
    if (!decision.ok) {
      refuseUpgrade(socket, decision.status);
      return;
    }
    if (sockets.clients.size >= maxClients) {
      refuseUpgrade(socket, 503);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      alive.add(client);
      client.on('pong', () => alive.add(client));
      client.on('error', () => client.terminate());
      // Overlay sockets are read-only. Commands belong on protected local HTTP routes.
      client.on('message', () => client.close(1008, 'Read-only overlay connection'));
      try {
        // Sent synchronously, so no broadcast can interleave with the connect sequence.
        for (const message of options.initialMessages(decision.side)) {
          client.send(JSON.stringify(message));
        }
      } catch (error) {
        console.error(`[ws] connect failed: ${error instanceof Error ? error.name : 'error'}`);
        client.close(1011, 'Server error');
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of sockets.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    broadcast(message) {
      const json = JSON.stringify(message);
      for (const client of sockets.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.bufferedAmount > MAX_BUFFERED_BYTES) client.terminate();
        else client.send(json);
      }
    },
    clientCount: () => sockets.clients.size,
    async close() {
      clearInterval(heartbeat);
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

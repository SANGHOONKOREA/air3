/*
 * Air3 Live — signaling on Cloudflare Workers + Durable Objects.
 * ------------------------------------------------------------------
 * Replaces the Node/VM server. One Worker handles:
 *   GET /healthz     → liveness
 *   GET /ice-config  → Cloudflare Realtime TURN short-lived credentials
 *   GET /ws?room=..  → WebSocket upgrade, routed to a per-room Durable Object
 *
 * The Durable Object (SignalRoom) holds the WebSocket connections for one room
 * and relays SDP/ICE 1:N between one broadcaster and many viewers. It uses the
 * WebSocket Hibernation API so it costs nothing while idle (free-tier friendly).
 *
 * Secrets: CF_TURN_API_TOKEN is a Worker secret (wrangler secret put ...).
 * CF_TURN_KEY_ID / ALLOW_ORIGIN / TURN_TTL are plain vars in wrangler.toml.
 */

const STUN_FALLBACK = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// In-isolate cache to avoid re-minting TURN creds on every request.
let iceCache = { at: 0, ttl: 0, servers: null, hasTurn: false };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/healthz') {
      return json({ ok: true, ts: Date.now() }, cors);
    }

    if (url.pathname === '/ice-config') {
      return json(await fetchIceServers(env), cors);
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const room = (url.searchParams.get('room') || 'default').slice(0, 64);
      const id = env.SIGNAL_ROOM.idFromName(room);
      const stub = env.SIGNAL_ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response('air3-live signaling (Cloudflare Workers) — OK', {
      status: 200,
      headers: cors,
    });
  },
};

// ---------------------------------------------------------------------------
// Durable Object: one instance per room.
// ---------------------------------------------------------------------------
export class SignalRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = crypto.randomUUID().slice(0, 8);
    // Hibernation: the runtime persists the socket + attachment across evictions.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, role: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  meta(ws) {
    return ws.deserializeAttachment() || {};
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket gone */
    }
  }

  find(id) {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.meta(ws).id === id) return ws;
    }
    return null;
  }

  broadcasterWs() {
    for (const ws of this.ctx.getWebSockets()) {
      if (this.meta(ws).role === 'broadcaster') return ws;
    }
    return null;
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const me = this.meta(ws);

    switch (msg.type) {
      case 'join': {
        const role = msg.role === 'broadcaster' ? 'broadcaster' : 'viewer';
        ws.serializeAttachment({ id: me.id, role });
        this.send(ws, { type: 'joined', id: me.id, role });

        if (role === 'broadcaster') {
          for (const other of this.ctx.getWebSockets()) {
            if (other === ws) continue;
            const om = this.meta(other);
            if (om.role === 'viewer') {
              this.send(other, { type: 'broadcaster-ready', id: me.id });
              this.send(ws, { type: 'viewer-join', id: om.id });
            }
          }
        } else {
          const b = this.broadcasterWs();
          if (b) {
            this.send(ws, { type: 'broadcaster-ready', id: this.meta(b).id });
            this.send(b, { type: 'viewer-join', id: me.id });
          }
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice': {
        const target = msg.to ? this.find(msg.to) : null;
        if (!target) return;
        const out = { type: msg.type, from: me.id };
        if (msg.sdp !== undefined) out.sdp = msg.sdp;
        if (msg.candidate !== undefined) out.candidate = msg.candidate;
        this.send(target, out);
        break;
      }

      case 'bye':
        try {
          ws.close(1000, 'bye');
        } catch {
          /* ignore */
        }
        this.handleGone(ws);
        break;

      default:
        break;
    }
  }

  async webSocketClose(ws) {
    this.handleGone(ws);
  }

  async webSocketError(ws) {
    this.handleGone(ws);
  }

  handleGone(ws) {
    const me = this.meta(ws);
    if (me.role === 'broadcaster') {
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        if (this.meta(other).role === 'viewer') this.send(other, { type: 'broadcaster-gone' });
      }
    } else if (me.role === 'viewer') {
      const b = this.broadcasterWs();
      if (b && b !== ws) this.send(b, { type: 'viewer-leave', id: me.id });
    }
  }
}

// ---------------------------------------------------------------------------
// TURN credentials (identical policy to the Node server: filter :53, cache,
// STUN fallback on any failure).
// ---------------------------------------------------------------------------
async function fetchIceServers(env) {
  const now = Date.now();
  const ttl = Number(env.TURN_TTL || 86400);
  if (iceCache.servers && now - iceCache.at < iceCache.ttl * 0.9 * 1000) {
    return { iceServers: iceCache.servers, hasTurn: iceCache.hasTurn };
  }

  const keyId = env.CF_TURN_KEY_ID;
  const token = env.CF_TURN_API_TOKEN;
  if (!keyId || !token) {
    return { iceServers: STUN_FALLBACK, hasTurn: false };
  }

  const endpoint =
    'https://rtc.live.cloudflare.com/v1/turn/keys/' +
    encodeURIComponent(keyId) +
    '/credentials/generate';

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    });
    if (!resp.ok) return { iceServers: STUN_FALLBACK, hasTurn: false };
    const data = await resp.json();
    const servers = normalizeIceServers(data.iceServers || data);
    iceCache = {
      at: now,
      ttl,
      servers,
      hasTurn: servers.some((s) => hasTurnUrl(s.urls)),
    };
    return { iceServers: iceCache.servers, hasTurn: iceCache.hasTurn };
  } catch {
    return { iceServers: STUN_FALLBACK, hasTurn: false };
  }
}

function normalizeIceServers(cf) {
  const list = Array.isArray(cf) ? cf : [cf];
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    let urls = entry.urls || entry.url || [];
    if (typeof urls === 'string') urls = [urls];
    urls = urls.filter((u) => typeof u === 'string' && !/:53(\?|$|\b)/.test(u));
    if (!urls.length) continue;
    const server = { urls };
    if (entry.username != null) server.username = entry.username;
    if (entry.credential != null) server.credential = entry.credential;
    out.push(server);
  }
  return out.length ? out : STUN_FALLBACK;
}

function hasTurnUrl(urls) {
  const arr = Array.isArray(urls) ? urls : [urls];
  return arr.some((u) => typeof u === 'string' && /^turns?:/.test(u));
}

function json(obj, headers) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

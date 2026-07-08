'use strict';

/*
 * Air3 Live — signaling + Cloudflare TURN credential broker
 * ---------------------------------------------------------
 * Responsibilities:
 *   1. HTTP  GET /ice-config  → issues short-lived Cloudflare Realtime TURN
 *      credentials to the browser (secrets never leave the VM).
 *   2. HTTP  GET /healthz     → liveness probe.
 *   3. WebSocket signaling    → room-based 1:N SDP/ICE relay between one
 *      broadcaster (Air3 glasses) and many viewers (office PCs).
 *
 * Secrets come from the environment (see deploy/.env.example). A tiny .env
 * loader is built in so no dotenv dependency is required.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// .env loader (zero-dependency). Reads KEY=VALUE lines; does not override
// variables already present in process.env.
// ---------------------------------------------------------------------------
function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[env] load failed:', err.message);
  }
}
loadEnv(path.join(__dirname, '.env'));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8080);
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || '';
const TURN_TTL = Number(process.env.TURN_TTL || 86400);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

const STUN_FALLBACK = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// ---------------------------------------------------------------------------
// Cloudflare TURN credential fetch (cached until near expiry)
// ---------------------------------------------------------------------------
let iceCache = { at: 0, ttl: 0, servers: null, hasTurn: false };

async function fetchIceServers() {
  const now = Date.now();
  // Refresh when we are within 10% of expiry (or nothing cached yet).
  if (iceCache.servers && now - iceCache.at < iceCache.ttl * 0.9 * 1000) {
    return { iceServers: iceCache.servers, hasTurn: iceCache.hasTurn };
  }

  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) {
    console.warn('[ice] Cloudflare credentials missing → STUN-only fallback');
    return { iceServers: STUN_FALLBACK, hasTurn: false };
  }

  const url =
    'https://rtc.live.cloudflare.com/v1/turn/keys/' +
    encodeURIComponent(CF_TURN_KEY_ID) +
    '/credentials/generate';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + CF_TURN_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[ice] Cloudflare error', resp.status, body.slice(0, 200));
      return { iceServers: STUN_FALLBACK, hasTurn: false };
    }
    const data = await resp.json();
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }
    const cf = data.iceServers || data;
    const servers = normalizeIceServers(cf);
    iceCache = {
      at: now,
      ttl: TURN_TTL,
      servers,
      hasTurn: servers.some((s) => hasTurnUrl(s.urls)),
    };
    return { iceServers: iceCache.servers, hasTurn: iceCache.hasTurn };
  } catch (err) {
    console.error('[ice] fetch failed:', err.message);
    return { iceServers: STUN_FALLBACK, hasTurn: false };
  } finally {
    clearTimeout(timer);
  }
}

// Normalize into an array of { urls, username?, credential? } and drop any
// URL on port :53 — some browsers hang on those (DNS-port TURN), so we filter
// them to avoid ICE-gathering timeouts.
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

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------
const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/ice-config', async (_req, res) => {
  const result = await fetchIceServers();
  res.json(result);
});

// Optionally serve the static front-end too (handy for all-in-one VM hosting;
// on GitHub Pages this is unused). Ignored if public/ is absent.
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket signaling — room-based 1:N
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

// rooms: Map<roomName, { broadcaster: id|null, peers: Map<id, ws> }>
const rooms = new Map();
let seq = 0;

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = { broadcaster: null, peers: new Map() };
    rooms.set(name, room);
  }
  return room;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendTo(room, id, msg) {
  const target = room.peers.get(id);
  if (target) send(target, msg);
}

wss.on('connection', (ws) => {
  ws.id = 'c' + ++seq;
  ws.room = null;
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join':
        handleJoin(ws, msg);
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        relay(ws, msg);
        break;
      case 'bye':
        cleanup(ws);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => cleanup(ws));
  ws.on('error', () => cleanup(ws));
});

function handleJoin(ws, msg) {
  const roomName = String(msg.room || 'default').slice(0, 64);
  const role = msg.role === 'broadcaster' ? 'broadcaster' : 'viewer';

  cleanup(ws); // idempotent: leave any prior room

  const room = getRoom(roomName);
  ws.room = roomName;
  ws.role = role;
  room.peers.set(ws.id, ws);

  send(ws, { type: 'joined', id: ws.id, role });

  if (role === 'broadcaster') {
    room.broadcaster = ws.id;
    // Tell every waiting viewer their broadcaster is live, and tell the
    // broadcaster about each viewer so it can open a peer connection.
    for (const [pid, pws] of room.peers) {
      if (pws.role === 'viewer') {
        send(pws, { type: 'broadcaster-ready', id: ws.id });
        send(ws, { type: 'viewer-join', id: pid });
      }
    }
  } else {
    // Viewer. If a broadcaster is already live, notify both sides.
    if (room.broadcaster && room.peers.has(room.broadcaster)) {
      send(ws, { type: 'broadcaster-ready', id: room.broadcaster });
      sendTo(room, room.broadcaster, { type: 'viewer-join', id: ws.id });
    }
  }
}

// Relay offer/answer/ice to the addressed peer (msg.to), stamping the sender.
function relay(ws, msg) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (!room) return;
  const to = msg.to;
  if (!to || !room.peers.has(to)) return;
  const out = { type: msg.type, from: ws.id };
  if (msg.sdp !== undefined) out.sdp = msg.sdp;
  if (msg.candidate !== undefined) out.candidate = msg.candidate;
  sendTo(room, to, out);
}

function cleanup(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  const wasRoom = ws.room;
  const wasRole = ws.role;
  const wasId = ws.id;
  ws.room = null;
  ws.role = null;
  if (!room) return;

  room.peers.delete(wasId);

  if (wasRole === 'broadcaster' && room.broadcaster === wasId) {
    room.broadcaster = null;
    for (const [, pws] of room.peers) {
      if (pws.role === 'viewer') send(pws, { type: 'broadcaster-gone' });
    }
  } else if (wasRole === 'viewer' && room.broadcaster) {
    sendTo(room, room.broadcaster, { type: 'viewer-leave', id: wasId });
  }

  if (room.peers.size === 0) rooms.delete(wasRoom);
}

// Heartbeat: drop dead sockets (satellite links go silent, not FIN).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[air3-live] listening on :${PORT}`);
  console.log(`[air3-live] TURN: ${CF_TURN_KEY_ID ? 'Cloudflare' : 'STUN-only'}`);
});

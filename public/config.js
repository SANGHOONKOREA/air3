/*
 * Air3 Live — front-end configuration (PUBLIC, no secrets).
 *
 * SERVER_URL must point at the signaling VM (Caddy HTTPS front, e.g.
 *   https://air3-signal.snsys.net
 * The front-end derives the WebSocket URL (wss://.../ws) and the
 * /ice-config endpoint from this base automatically.
 *
 * ROOM lets you run more than one simultaneous stream (e.g. per ship/team).
 * Broadcaster and viewer must use the same ROOM. You can also override it at
 * runtime with a ?room=NAME query parameter on either page.
 */
window.AIR3_CONFIG = {
  // Cloudflare Workers 시그널링 주소 (배포 완료).
  SERVER_URL: 'https://air3-signal.rms-snsys.workers.dev',
  ROOM: 'ship1',
};

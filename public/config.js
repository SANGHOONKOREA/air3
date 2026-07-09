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
  // ⬇️ Cloudflare Workers 배포 주소. `wrangler deploy` 후 출력되는
  //    https://air3-signal.<계정서브도메인>.workers.dev 로 이 값을 바꾸세요.
  SERVER_URL: 'https://air3-signal.CHANGE-ME.workers.dev',
  ROOM: 'ship1',
};

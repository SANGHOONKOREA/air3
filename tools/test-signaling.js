'use strict';
/*
 * End-to-end smoke test of the signaling server (no browser / no real WebRTC).
 * Starts nothing itself — expects the server already running on PORT.
 * Simulates one broadcaster + two viewers and asserts the relay protocol:
 *   - broadcaster is told about each viewer (viewer-join)
 *   - viewers are told the broadcaster is ready (broadcaster-ready)
 *   - offer → viewer, answer → broadcaster, ice both ways, all addressed
 *   - viewer-leave propagates to broadcaster
 * Exits non-zero on any failure.
 */
const WebSocket = require('ws');

const PORT = process.env.PORT || 8099;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const ROOM = 'test-' + PORT;

const results = [];
function assert(cond, name) {
  results.push({ name, ok: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name);
}
function open(role) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.inbox = [];
    ws.on('message', (d) => ws.inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
  });
}
const send = (ws, m) => ws.send(JSON.stringify(m));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const got = (ws, type) => ws.inbox.find((m) => m.type === type);

(async () => {
  // Broadcaster joins first.
  const b = await open();
  send(b, { type: 'join', room: ROOM, role: 'broadcaster' });
  await wait(150);
  const bJoined = got(b, 'joined');
  assert(bJoined && bJoined.role === 'broadcaster', 'broadcaster receives joined');
  const bId = bJoined && bJoined.id;

  // Viewer 1 joins → broadcaster should get viewer-join, viewer gets broadcaster-ready.
  const v1 = await open();
  send(v1, { type: 'join', room: ROOM, role: 'viewer' });
  await wait(150);
  const v1Joined = got(v1, 'joined');
  const v1Id = v1Joined && v1Joined.id;
  assert(!!v1Joined, 'viewer1 receives joined');
  assert(!!got(v1, 'broadcaster-ready'), 'viewer1 receives broadcaster-ready');
  const vJoinMsg = b.inbox.find((m) => m.type === 'viewer-join' && m.id === v1Id);
  assert(!!vJoinMsg, 'broadcaster receives viewer-join for viewer1');

  // Broadcaster sends an offer addressed to viewer1.
  send(b, { type: 'offer', to: v1Id, sdp: 'FAKE_OFFER' });
  await wait(120);
  const offer = v1.inbox.find((m) => m.type === 'offer' && m.sdp === 'FAKE_OFFER');
  assert(offer && offer.from === bId, 'offer relayed to viewer1 stamped from broadcaster');

  // Viewer1 answers.
  send(v1, { type: 'answer', to: bId, sdp: 'FAKE_ANSWER' });
  await wait(120);
  const answer = b.inbox.find((m) => m.type === 'answer' && m.sdp === 'FAKE_ANSWER');
  assert(answer && answer.from === v1Id, 'answer relayed to broadcaster stamped from viewer1');

  // ICE both directions.
  send(b, { type: 'ice', to: v1Id, candidate: { candidate: 'B->V' } });
  send(v1, { type: 'ice', to: bId, candidate: { candidate: 'V->B' } });
  await wait(120);
  assert(v1.inbox.some((m) => m.type === 'ice' && m.candidate.candidate === 'B->V'), 'ice relayed broadcaster→viewer');
  assert(b.inbox.some((m) => m.type === 'ice' && m.candidate.candidate === 'V->B'), 'ice relayed viewer→broadcaster');

  // Second viewer joins → broadcaster gets another viewer-join.
  const v2 = await open();
  send(v2, { type: 'join', room: ROOM, role: 'viewer' });
  await wait(150);
  const v2Id = got(v2, 'joined').id;
  assert(b.inbox.some((m) => m.type === 'viewer-join' && m.id === v2Id), 'broadcaster receives viewer-join for viewer2');

  // Misaddressed relay is dropped (offer to unknown id must not reach anyone).
  const beforeCounts = [v1.inbox.length, v2.inbox.length];
  send(b, { type: 'offer', to: 'nonexistent', sdp: 'X' });
  await wait(120);
  assert(v1.inbox.length === beforeCounts[0] && v2.inbox.length === beforeCounts[1], 'misaddressed offer is dropped');

  // Viewer1 leaves → broadcaster gets viewer-leave.
  v1.close();
  await wait(200);
  assert(b.inbox.some((m) => m.type === 'viewer-leave' && m.id === v1Id), 'broadcaster receives viewer-leave');

  // Broadcaster leaves → remaining viewer gets broadcaster-gone.
  b.close();
  await wait(200);
  assert(v2.inbox.some((m) => m.type === 'broadcaster-gone'), 'viewer2 receives broadcaster-gone');

  v2.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('test error:', e);
  process.exit(2);
});

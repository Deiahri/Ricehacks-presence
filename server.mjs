// Presence relay + 1v1 challenge referee.
// Every client says hello, streams its position, and receives a snapshot of everyone.
// Challenges (request → accept → pick → ready → live → result) are refereed here so both phones agree on the
// exercise, the start moment and the winner, and each result is stored exactly once.
// Accounts, friends, BP and the shop are in Postgres (db.mjs) behind a small JSON API (http-api.mjs).
// Live state is in memory only — restart = empty world. Good enough for a spike.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { accountFor, clerkEnabled } from './auth.mjs';
import { getProfile, hasDb, initDb, recordChallenge, recordSolo } from './db.mjs';
import { DURATIONS, battleBp } from './game-config.mjs';
import { createApi } from './http-api.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const BROADCAST_MS = 200; // snapshot at most 5×/s, only when something changed
const STALE_MS = 60_000; // hide players from the map that stop sending positions
const HEARTBEAT_MS = 25_000; // ping to detect dead sockets + keep proxies from idling us out

const REQUEST_TIMEOUT_MS = 30_000; // unanswered challenge request
const PICK_TIMEOUT_MS = 90_000; // both must lock in exercise + duration
const READY_TIMEOUT_MS = 60_000; // both cameras must be running
const COUNTDOWN_MS = 10_000; // "get in position" before counting starts
const FINAL_GRACE_MS = 15_000; // wait this long past the end for both final scores

const EXERCISES = new Set(['squat', 'pushup']);
const QUALITIES = new Set(['red', 'yellow', 'green']);

/**
 * `userId` is the account's stable key (Clerk user id, or the device secret without Clerk; never sent to other clients);
 * until the account resolves it is the device secret or connection id. `uid` is the account, filled in once the
 * database answers. `soloSince` = when the current solo workout began.
 * @type {Map<import('ws').WebSocket, {id:string,userId:string,uid:string|null,username:string|null,name:string,shirt:string,skin:string|null,equipped:object,lat:number|null,lng:number|null,heading:number|null,acc:number|null,ts:number,soloBusy:boolean,soloSince:number|null}>}
 */
const players = new Map();
/** Active challenge per socket (both participants point at the same object). */
const challengeOf = new Map();
let dirty = false;

const api = createApi({ presenceOf, patchUser, pushToUser });

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${players.size}\n`);
    return;
  }
  api(req, res).then(
    (handled) => { if (!handled) res.writeHead(404).end(); },
    (e) => { console.error('[api] unhandled:', e.message); if (!res.headersSent) res.writeHead(500).end(); },
  );
});

// A 5-minute set's final message carries up to ~450 rep scores.
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const HEX = /^#[0-9a-f]{6}$/i;
const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const brief = (p) => ({ id: p.id, name: p.name, shirt: p.shirt, skin: p.skin, equipped: p.equipped });
/** A profile as clients see it (no internal id). */
const pubProfile = ({ id: _id, ...p }) => p;
const clampInt = (v, lo, hi) => (isNum(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo);
/** Same formula as the app's src/game/scoring.ts: each rep is worth 0-10 points by form. */
const totalScore = (scores) => Math.round(scores.reduce((s, v) => s + v, 0) / 10);
const avgForm = (scores) => (scores.length ? scores.reduce((s, v) => s + v, 0) / scores.length : null);
/** Generous upper bound on reps in a set (the fastest counted rep is 0.8 s). */
const maxReps = (durationS) => Math.ceil(durationS * 1.5);

function repScoresFrom(v, durationS) {
  if (!Array.isArray(v)) return null;
  return v.filter(isNum).slice(0, maxReps(durationS)).map((s) => Math.round(Math.min(100, Math.max(0, s)) * 10) / 10);
}

function socketOf(id) {
  let found = null;
  for (const [ws, p] of players) if (p.id === id) found = ws; // newest connection wins
  return found;
}

// --- accounts ---------------------------------------------------------------

/** Every open connection signed in as account `uid` (one per tab or phone). */
function* connectionsOf(uid) {
  for (const [ws, p] of players) if (p.uid === uid) yield [ws, p];
}

function pushToUser(uid, msg) {
  for (const [ws] of connectionsOf(uid)) send(ws, msg);
}

/** Where to reach `uid` for a challenge: its newest connection, or null when offline. */
function presenceOf(uid) {
  let found = null;
  for (const [ws, p] of connectionsOf(uid)) found = { id: p.id, busy: p.soloBusy || challengeOf.has(ws) };
  return found;
}

/** A username, look, purchase or equip changed: update the map snapshot and every tab of that account. */
function patchUser(uid, profile) {
  for (const [, p] of connectionsOf(uid)) {
    p.username = profile.username;
    if (profile.username) p.name = profile.username;
    if (profile.shirt) p.shirt = profile.shirt;
    p.skin = profile.skin ?? null;
    p.equipped = profile.equipped ?? {};
  }
  dirty = true;
  pushToUser(uid, { type: 'profile', profile: pubProfile(profile) });
}

/** BP changed after a set: send the fresh profile to that account's tabs. */
function notifyProfile(uid) {
  getProfile(uid).then(
    (profile) => pushToUser(uid, { type: 'profile', profile: pubProfile(profile) }),
    (e) => console.error('[db] profile refresh failed:', e.message),
  );
}

/** After hello: find (or create) the account for this credential and tell the client who it is. */
async function resolveAccount(ws, entry, credential) {
  try {
    const { uid, key } = await accountFor(credential, entry.shirt);
    const profile = await getProfile(uid);
    if (players.get(ws) !== entry) return; // closed or said hello again meanwhile
    entry.uid = uid;
    entry.userId = key;
    entry.username = profile.username;
    if (profile.username) entry.name = profile.username;
    if (profile.shirt) entry.shirt = profile.shirt;
    entry.skin = profile.skin ?? null;
    entry.equipped = profile.equipped;
    dirty = true;
    send(ws, { type: 'profile', profile: pubProfile(profile) });
  } catch (e) {
    console.error('[db] account lookup failed:', e.message);
  }
}

// --- challenges -------------------------------------------------------------

function createChallenge(a, b) {
  const ch = {
    id: randomUUID(),
    a, // challenger
    b, // challenged
    info: new Map([[a, { ...players.get(a) }], [b, { ...players.get(b) }]]), // survives a socket closing
    phase: 'pending', // pending → picking → ready → live → done
    picks: new Map(),
    config: null,
    ready: new Set(),
    live: new Map(), // latest {reps, score} per socket
    finals: new Map(), // final repScores per socket
    timer: undefined,
  };
  challengeOf.set(a, ch);
  challengeOf.set(b, ch);
  dirty = true; // busy flags changed
  return ch;
}

const other = (ch, ws) => (ws === ch.a ? ch.b : ch.a);

function setTimer(ch, ms, fn) {
  clearTimeout(ch.timer);
  ch.timer = setTimeout(fn, ms);
}

function release(ch) {
  clearTimeout(ch.timer);
  ch.phase = 'done';
  for (const ws of [ch.a, ch.b]) if (challengeOf.get(ws) === ch) challengeOf.delete(ws);
  dirty = true;
}

/** End a challenge that never went live; nothing is stored. */
function abort(ch, status) {
  if (ch.phase === 'done') return;
  release(ch);
  for (const ws of [ch.a, ch.b]) send(ws, { type: 'challenge_update', challengeId: ch.id, status });
}

/** Score a live challenge, pay BP, tell both players, store one row. `forfeitBy` = the socket that left early. */
function finish(ch, forfeitBy = null) {
  if (ch.phase === 'done') return;
  release(ch);
  const side = (ws) => {
    const { id, userId, uid, name, shirt, skin, equipped } = ch.info.get(ws);
    const f = ch.finals.get(ws);
    if (f) return { id, userId, uid, name, shirt, skin, equipped, reps: f.length, score: totalScore(f), repScores: f };
    const l = ch.live.get(ws) ?? { reps: 0, score: 0 }; // never sent a final: last live update
    return { id, userId, uid, name, shirt, skin, equipped, reps: l.reps, score: l.score, repScores: [] };
  };
  const A = side(ch.a);
  const B = side(ch.b);
  let winner = null;
  if (forfeitBy) winner = forfeitBy === ch.a ? B : A;
  else if (A.score !== B.score) winner = A.score > B.score ? A : B;
  else if (A.reps !== B.reps) winner = A.reps > B.reps ? A : B;

  // Only accounts can hold BP, so a side the database never resolved earns nothing.
  const forfeiter = forfeitBy ? (forfeitBy === ch.a ? A : B) : null;
  for (const S of [A, B]) {
    const outcome = winner === null ? 'draw' : winner === S ? 'win' : 'loss';
    S.bpAwarded = S.uid ? battleBp(S.score, outcome, S === forfeiter) : 0;
  }

  const pub = ({ userId: _userId, uid: _uid, ...rest }) => rest;
  const base = { type: 'challenge_result', challengeId: ch.id, winnerId: winner?.id ?? null, forfeit: Boolean(forfeitBy) };
  send(ch.a, { ...base, you: pub(A), opponent: pub(B) });
  send(ch.b, { ...base, you: pub(B), opponent: pub(A) });

  recordChallenge({
    mode: 'challenge', exercise: ch.config.exercise, duration_s: ch.config.durationS,
    user_id: A.userId, user_name: A.name, score: A.score, reps: A.reps, avg_form: avgForm(A.repScores), rep_scores: A.repScores,
    challenge_id: ch.id, opponent_id: B.userId, opponent_name: B.name, opponent_score: B.score, opponent_reps: B.reps,
    winner_id: winner?.userId ?? null, forfeit: Boolean(forfeitBy),
    user_uid: A.uid, opponent_uid: B.uid, winner_uid: winner?.uid ?? null, user_bp: A.bpAwarded, opponent_bp: B.bpAwarded,
  }, [A, B]).then(
    (stored) => { if (stored) for (const S of [A, B]) if (S.uid) notifyProfile(S.uid); },
    (e) => console.error('[db] challenge save failed:', e.message),
  );
}

function resolvePicks(ch) {
  const pa = ch.picks.get(ch.a);
  const pb = ch.picks.get(ch.b);
  const flip = (x, y) => (x === y ? x : Math.random() < 0.5 ? x : y); // split vote → coin flip
  ch.config = { exercise: flip(pa.exercise, pb.exercise), durationS: flip(pa.durationS, pb.durationS) };
  ch.phase = 'ready';
  setTimer(ch, READY_TIMEOUT_MS, () => abort(ch, 'timeout'));
  const msg = {
    type: 'challenge_resolved', challengeId: ch.id, ...ch.config,
    picks: { [ch.info.get(ch.a).id]: pa, [ch.info.get(ch.b).id]: pb },
    coinFlips: { exercise: pa.exercise !== pb.exercise, duration: pa.durationS !== pb.durationS },
  };
  send(ch.a, msg);
  send(ch.b, msg);
}

/** Refuse a request: the client still gets an id so it can match the refusal to its pending request. */
function refuse(ws, status, opponent) {
  const challengeId = randomUUID();
  send(ws, { type: 'challenge_outgoing', challengeId, opponent });
  send(ws, { type: 'challenge_update', challengeId, status });
}

function onChallenge(ws, me, msg) {
  const ch = challengeOf.get(ws);
  const mine = ch !== undefined && ch.id === msg.challengeId;

  switch (msg.type) {
    case 'challenge_request': {
      if (ch || typeof msg.to !== 'string') return;
      const target = msg.to === me.id ? null : socketOf(msg.to);
      const t = target && players.get(target);
      if (!t) return refuse(ws, 'offline', { id: msg.to, name: 'Player', shirt: '#7fb0e0' });
      if (challengeOf.has(target) || t.soloBusy) return refuse(ws, 'busy', brief(t));
      const nch = createChallenge(ws, target);
      send(ws, { type: 'challenge_outgoing', challengeId: nch.id, opponent: brief(t) });
      send(target, { type: 'challenge_incoming', challengeId: nch.id, from: brief(me) });
      setTimer(nch, REQUEST_TIMEOUT_MS, () => abort(nch, 'timeout'));
      return;
    }
    case 'challenge_cancel': {
      if (!mine) return;
      if (ch.phase !== 'live') return abort(ch, 'cancelled');
      if (!ch.finals.has(ws)) finish(ch, ws); // leaving mid-set forfeits; after your final it's just closing the screen
      return;
    }
    case 'challenge_respond': {
      if (!mine || ws !== ch.b || ch.phase !== 'pending') return;
      if (msg.accept !== true) return abort(ch, 'declined');
      ch.phase = 'picking';
      setTimer(ch, PICK_TIMEOUT_MS, () => abort(ch, 'timeout'));
      send(ch.a, { type: 'challenge_accepted', challengeId: ch.id, opponent: brief(ch.info.get(ch.b)) });
      send(ch.b, { type: 'challenge_accepted', challengeId: ch.id, opponent: brief(ch.info.get(ch.a)) });
      return;
    }
    case 'challenge_pick': {
      if (!mine || ch.phase !== 'picking') return;
      if (!EXERCISES.has(msg.exercise) || !DURATIONS.has(msg.durationS)) return;
      ch.picks.set(ws, { exercise: msg.exercise, durationS: msg.durationS });
      if (ch.picks.size === 2) resolvePicks(ch);
      return;
    }
    case 'challenge_ready': {
      if (!mine || ch.phase !== 'ready') return;
      ch.ready.add(ws);
      if (ch.ready.size < 2) return;
      ch.phase = 'live';
      setTimer(ch, COUNTDOWN_MS + ch.config.durationS * 1000 + FINAL_GRACE_MS, () => finish(ch));
      const go = { type: 'challenge_go', challengeId: ch.id, countdownMs: COUNTDOWN_MS, durationS: ch.config.durationS };
      send(ch.a, go);
      send(ch.b, go);
      return;
    }
    case 'challenge_rep': {
      if (!mine || ch.phase !== 'live' || !QUALITIES.has(msg.quality)) return;
      const reps = clampInt(msg.reps, 0, maxReps(ch.config.durationS));
      const score = clampInt(msg.score, 0, reps * 10);
      ch.live.set(ws, { reps, score });
      send(other(ch, ws), { type: 'challenge_opp', challengeId: ch.id, reps, score, quality: msg.quality });
      return;
    }
    case 'challenge_final': {
      if (!mine || ch.phase !== 'live' || ch.finals.has(ws)) return;
      const scores = repScoresFrom(msg.repScores, ch.config.durationS);
      if (!scores) return;
      ch.finals.set(ws, scores);
      if (ch.finals.size === 2) finish(ch);
      return;
    }
  }
}

function onSoloResult(ws, me, msg) {
  if (!EXERCISES.has(msg.exercise) || !DURATIONS.has(msg.durationS)) return;
  const scores = repScoresFrom(msg.repScores, msg.durationS);
  if (!scores) return;
  // BP only for a set that really took its full length since the workout began, and once per workout.
  const earn = me.soloSince !== null && Date.now() - me.soloSince >= msg.durationS * 1000 - 2000;
  me.soloSince = null;
  recordSolo({
    uid: me.uid, secret: me.userId, name: me.name, exercise: msg.exercise, durationS: msg.durationS,
    scores, score: totalScore(scores), avgForm: avgForm(scores), earn,
  }).then(
    ({ stored, bpAwarded, bp }) => {
      send(ws, { type: 'saved', ok: stored, reason: stored ? undefined : 'no-db', bpAwarded, bp });
      if (stored && me.uid) notifyProfile(me.uid);
    },
    (e) => {
      console.error('[db] solo save failed:', e.message);
      send(ws, { type: 'saved', ok: false, reason: 'error' });
    },
  );
}

// --- connections ------------------------------------------------------------

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      if (typeof msg.id !== 'string' || msg.id.length < 4 || msg.id.length > 64) return;
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 24) : '';
      const userId = typeof msg.userId === 'string' && msg.userId.length >= 4 && msg.userId.length <= 64 ? msg.userId : msg.id;
      // With Clerk the account comes from the session token; without it, from the device secret. No credential
      // (bots, or signed out) = on the map without an account.
      const token = typeof msg.token === 'string' && msg.token.length >= 4 && msg.token.length <= 4096 ? msg.token : null;
      const credential = clerkEnabled() ? token : userId;
      const prev = players.get(ws);
      const same = !clerkEnabled() && prev?.userId === userId;
      const entry = {
        id: msg.id,
        userId,
        uid: same ? prev.uid : null,
        username: same ? prev.username : null,
        name: (same && prev.username) || name || 'Player',
        shirt: typeof msg.shirt === 'string' && HEX.test(msg.shirt) ? msg.shirt : '#7fb0e0',
        skin: same ? prev.skin : null,
        equipped: same ? prev.equipped : {},
        lat: prev?.lat ?? null, lng: prev?.lng ?? null, heading: prev?.heading ?? null, acc: prev?.acc ?? null,
        ts: Date.now(),
        soloBusy: prev?.soloBusy ?? false,
        soloSince: prev?.soloSince ?? null,
      };
      players.set(ws, entry);
      ws.send(JSON.stringify({ type: 'you', id: msg.id }));
      dirty = true;
      if (hasDb() && credential) void resolveAccount(ws, entry, credential);
      return;
    }

    const me = players.get(ws);
    if (!me) return; // must hello first

    if (msg.type === 'pos') {
      const { lat, lng, heading, acc } = msg;
      if (!isNum(lat) || !isNum(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      me.lat = lat;
      me.lng = lng;
      me.heading = isNum(heading) ? ((heading % 360) + 360) % 360 : null;
      me.acc = isNum(acc) && acc >= 0 ? Math.min(acc, 100_000) : null;
      me.ts = Date.now();
      dirty = true;
      return;
    }

    if (msg.type === 'status') {
      const busy = msg.busy === true; // in a solo workout: refuse challenges
      if (busy && !me.soloBusy) me.soloSince = Date.now();
      me.soloBusy = busy;
      dirty = true;
      return;
    }

    if (msg.type === 'solo_result') return onSoloResult(ws, me, msg);
    if (typeof msg.type === 'string' && msg.type.startsWith('challenge_')) onChallenge(ws, me, msg);
  });

  ws.on('close', () => {
    const ch = challengeOf.get(ws);
    if (ch) {
      if (ch.phase !== 'live') abort(ch, 'left');
      else if (!ch.finals.has(ws)) finish(ch, ws);
    }
    if (players.delete(ws)) dirty = true;
  });
});

// Snapshot broadcast (only players with a fresh position).
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (p.lat !== null && now - p.ts > STALE_MS) { p.lat = p.lng = null; dirty = true; }
  }
  if (!dirty) return;
  dirty = false;
  const list = [];
  for (const [ws, p] of players) {
    if (p.lat === null) continue;
    list.push({
      id: p.id, name: p.name, username: p.username, shirt: p.shirt, skin: p.skin, equipped: p.equipped,
      lat: p.lat, lng: p.lng, heading: p.heading, acc: p.acc, ts: p.ts,
      busy: p.soloBusy || challengeOf.has(ws),
    });
  }
  const payload = JSON.stringify({ type: 'players', players: list });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}, BROADCAST_MS);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

initDb().catch((e) => console.error('[db] init failed (will retry on first write):', e.message));
server.listen(PORT, () => console.log(`presence server on :${PORT}`));

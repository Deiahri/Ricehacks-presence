// End-to-end check of accounts, friends, BP, the shop and battles, with two fake players.
// Run it against a server that uses a THROWAWAY database: it creates users and never deletes them.
//
//     DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres node server.mjs &
//     npm run smoke                      # or: node scripts/smoke.mjs http://localhost:8787
//
// Takes ~20 s (a solo set only earns BP once its full 15 s have passed).
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://localhost:8787';
const WS_URL = BASE.replace(/^http/, 'ws');
const tag = randomUUID().slice(0, 5);
let failures = 0;

function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  <- ${detail}`}`);
}

async function call(secret, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function player(label) {
  const secret = `smoke-${tag}-${label}-${randomUUID()}`;
  const id = randomUUID();
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiting = [];
  let players = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'players') players = m.players;
    inbox.push(m);
    for (const w of [...waiting]) if (w.test(m)) { waiting.splice(waiting.indexOf(w), 1); inbox.splice(inbox.indexOf(m), 1); w.resolve(m); }
  });
  const next = (type, pred = () => true, ms = 5000) => {
    const test = (m) => m.type === type && pred(m);
    const found = inbox.find(test);
    if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      waiting.push(w);
      setTimeout(() => { if (waiting.includes(w)) { waiting.splice(waiting.indexOf(w), 1); reject(new Error(`${label}: no ${type}`)); } }, ms);
    });
  };
  const send = (m) => ws.send(JSON.stringify(m));
  const open = new Promise((r) => ws.once('open', r));
  return {
    label, secret, id, ws, next, send, open,
    snapshot: () => players,
    api: (method, path, body) => call(secret, method, path, body),
    hello: () => send({ type: 'hello', id, userId: secret, name: `Smoke ${label}`, shirt: '#7fb0e0' }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = player('a');
const B = player('b');
await Promise.all([A.open, B.open]);
A.hello();
B.hello();
check('hello → you', (await A.next('you')).id === A.id);
const firstProfile = await A.next('profile');
check('hello → profile for a new device', firstProfile.profile.username === null && firstProfile.profile.bp === 0);
await B.next('profile');

// Usernames
const nameA = `smk_${tag}a`;
const nameB = `smk_${tag}b`;
check('claim username', (await A.api('POST', '/api/username', { username: nameA })).status === 200);
check('taken username (case-insensitive) → 409', (await B.api('POST', '/api/username', { username: nameA.toUpperCase() })).status === 409);
check('invalid username → 400', (await B.api('POST', '/api/username', { username: 'no spaces!' })).status === 400);
check('claim second username', (await B.api('POST', '/api/username', { username: nameB })).status === 200);
check('no auth → 401', (await call('', 'GET', '/api/me')).status === 401);
check('GET /api/me', (await A.api('GET', '/api/me')).body?.username === nameA);

// Identity verification: on when the server has PERSONA_API_KEY. Smoke accounts never verify, so with it on they are
// unverified and kept off the global board.
const verifyStart = await A.api('GET', '/api/verify/start');
const PERSONA_ON = verifyStart.status === 200;
console.log(`INFO  identity verification is ${PERSONA_ON ? 'ON (PERSONA_API_KEY set)' : 'off'}`);
check('profile.verified: true only while verification is off', (await A.api('GET', '/api/me')).body?.verified === !PERSONA_ON);
if (PERSONA_ON) {
  check('verify/start hands back a reference id', typeof verifyStart.body?.referenceId === 'string' && verifyStart.body.referenceId.length > 8);
  check('verify: bad inquiry id → 400', (await A.api('POST', '/api/verify', { inquiryId: '../nope' })).status === 400);
} else {
  check('verify/start → 503 without Persona', verifyStart.status === 503 && verifyStart.body?.error === 'persona-not-configured');
  check('verify → 503 without Persona', (await A.api('POST', '/api/verify', { inquiryId: 'inq_abcdef123' })).status === 503);
}

// Friends
const sent = await A.api('POST', '/api/friends/requests', { username: nameB });
check('friend request sent', sent.body?.status === 'sent', JSON.stringify(sent));
await B.next('friend_request');
check('recipient is pushed the request', true);
const incoming = (await B.api('GET', '/api/friends')).body;
check('request shows in recipient incoming', incoming?.incoming?.some((p) => p.username === nameA), JSON.stringify(incoming));
check('unknown user → 404', (await A.api('POST', '/api/friends/requests', { username: 'nobody_here_x' })).status === 404);
check('accept request', (await B.api('POST', '/api/friends/respond', { username: nameA, accept: true })).status === 200);
await A.next('friend_update');
const friendsA = (await A.api('GET', '/api/friends')).body;
const fB = friendsA?.friends?.find((f) => f.username === nameB);
check('friend listed, online, with presence id', fB?.online === true && fB.presenceId === B.id, JSON.stringify(friendsA));
check('already friends → 409', (await A.api('POST', '/api/friends/requests', { username: nameB })).status === 409);

// Request outcomes reach the sender: pushed live and kept in their inbox
const accepted = await A.next('notification');
check('sender is pushed "accepted"', accepted.notification?.type === 'friend_accepted' && accepted.notification.actor?.username === nameB,
  JSON.stringify(accepted));
const inboxA = (await A.api('GET', '/api/notifications')).body;
check('inbox has it, unread', inboxA?.unread === 1 && inboxA.items[0]?.type === 'friend_accepted' && !('id' in (inboxA.items[0].actor ?? {})),
  JSON.stringify(inboxA));
await A.api('POST', '/api/notifications/read');
check('mark read clears unread', (await A.api('GET', '/api/notifications')).body?.unread === 0);
const C = player('c');
await C.open;
C.hello();
await C.next('profile');
const nameC = `smk_${tag}c`;
await C.api('POST', '/api/username', { username: nameC });
await C.api('POST', '/api/friends/requests', { username: nameB });
check('decline request', (await B.api('POST', '/api/friends/respond', { username: nameC, accept: false })).status === 200);
const declined = await C.next('notification');
check('sender is pushed "declined"', declined.notification?.type === 'friend_declined' && declined.notification.actor?.username === nameB,
  JSON.stringify(declined));

// Appearance
check('bad skin → 400', (await A.api('POST', '/api/appearance', { skin: 'green' })).status === 400);
check('bad shirt → 400', (await A.api('POST', '/api/appearance', { shirt: 'red' })).status === 400);
const look = (await A.api('POST', '/api/appearance', { skin: 's5', shirt: '#12AB34' })).body;
check('set skin + shirt', look?.skin === 's5' && look.shirt === '#12ab34', JSON.stringify(look));

// Solo BP (anti-spam: an instant result earns nothing). The early set also carries a malformed pose track, which is
// dropped without losing the set.
A.send({ type: 'status', busy: true });
await sleep(100);
A.send({
  type: 'solo_result', exercise: 'squat', durationS: 15, repScores: Array(15).fill(100),
  track: { v: 1, fps: 10, joints: 13, aspect: 0.56, mirrored: true, frames: 'not base64!' },
});
const early = await A.next('saved');
check('instant solo result earns 0 BP', early.ok === true && early.bpAwarded === 0, JSON.stringify(early));
A.send({ type: 'status', busy: false });
await sleep(100);
A.send({ type: 'status', busy: true });
await sleep(13_200);
// A replayable set: per-rep detail + a 15 s pose track (10 fps × 13 joints × x,y bytes).
const trackBytes = Buffer.alloc(150 * 13 * 2);
for (let i = 0; i < trackBytes.length; i++) trackBytes[i] = (i * 7) % 255;
const soloTrack = { v: 1, fps: 10, joints: 13, aspect: 0.5625, mirrored: true, frames: trackBytes.toString('base64') };
const soloDetail = Array.from({ length: 15 }, (_, i) => ({ t: i + 0.9, d: 0.9, sub: { depth: 100, torso: 100, symmetry: 100 }, c: ['Good rep'] }));
A.send({ type: 'solo_result', exercise: 'squat', durationS: 15, repScores: Array(15).fill(100), repDetail: soloDetail, track: soloTrack });
const solo = await A.next('saved');
check('15 s solo: BP = score (150)', solo.bpAwarded === 150 && solo.bp === 150, JSON.stringify(solo));
check('saved carries the workout id', typeof solo.workoutId === 'string' && typeof early.workoutId === 'string');
A.send({ type: 'status', busy: false });

// Shop
check('buy without enough BP → 402', (await B.api('POST', '/api/shop/buy', { itemId: 'warlock_hat' })).status === 402);
const bought = await A.api('POST', '/api/shop/buy', { itemId: 'low_tier_shield' });
check('buy shield: BP spent, owned, auto-equipped',
  bought.body?.bp === 0 && bought.body.owned.includes('low_tier_shield') && bought.body.equipped.offhand === 'low_tier_shield', JSON.stringify(bought));
check('buy twice → 409', (await A.api('POST', '/api/shop/buy', { itemId: 'low_tier_shield' })).status === 409);
check('equip unowned → 403', (await A.api('POST', '/api/equip', { slot: 'mainhand', itemId: 'magic_wand' })).status === 403);
check('equip wrong slot → 400', (await A.api('POST', '/api/equip', { slot: 'head', itemId: 'low_tier_shield' })).status === 400);
check('unequip', (await A.api('POST', '/api/equip', { slot: 'offhand', itemId: null })).body?.equipped?.offhand === undefined);
check('re-equip', (await A.api('POST', '/api/equip', { slot: 'offhand', itemId: 'low_tier_shield' })).body?.equipped?.offhand === 'low_tier_shield');
A.send({ type: 'pos', lat: 29.7174, lng: -95.4018, heading: 0, acc: 5 });
await sleep(600);
const seen = B.snapshot().find((p) => p.id === A.id);
check('map snapshot has username + gear + look + verified flag',
  seen?.username === nameA && seen.equipped?.offhand === 'low_tier_shield' && seen.skin === 's5' && seen.shirt === '#12ab34'
  && seen.verified === !PERSONA_ON, JSON.stringify(seen));

// 15 s battle, settled by finals: A 5×100 = 50 pts beats B 4×50 = 20 pts
async function startBattle() {
  A.send({ type: 'challenge_request', to: B.id });
  const inc = await B.next('challenge_incoming');
  const challengeId = inc.challengeId;
  check('incoming challenge shows gear', inc.from.equipped?.offhand === 'low_tier_shield');
  B.send({ type: 'challenge_respond', challengeId, accept: true });
  await Promise.all([A.next('challenge_accepted'), B.next('challenge_accepted')]);
  A.send({ type: 'challenge_pick', challengeId, exercise: 'squat', durationS: 15 });
  B.send({ type: 'challenge_pick', challengeId, exercise: 'squat', durationS: 15 });
  const resolved = await A.next('challenge_resolved');
  check('15 s is a valid battle length', resolved.durationS === 15);
  await B.next('challenge_resolved');
  A.send({ type: 'challenge_ready', challengeId });
  B.send({ type: 'challenge_ready', challengeId });
  const [go] = await Promise.all([A.next('challenge_go'), B.next('challenge_go')]);
  return { challengeId, go };
}
// HP duel: A wears the shield, so B's hits land at 70%.
let { challengeId: cid, go } = await startBattle();
check('go carries HP and loadouts', go.hpMax === 75 && go.loadouts?.[A.id]?.shield === true && go.loadouts?.[B.id]?.shield === false,
  JSON.stringify(go));
A.send({ type: 'challenge_rep', challengeId: cid, reps: 1, score: 10, quality: 'green', formScore: 100 });
const hpA1 = await A.next('challenge_hp');
check('live HP: my hit lands on the opponent', hpA1.hpMax === 75 && hpA1.you.dealt === 10 && hpA1.opponent.hp === 65, JSON.stringify(hpA1));
B.send({ type: 'challenge_rep', challengeId: cid, reps: 1, score: 5, quality: 'yellow', formScore: 50 });
const hpB = await B.next('challenge_hp', (m) => m.you.dealt > 0);
check('live HP: the shield absorbs 30%', hpB.you.dealt === 3.5 && hpB.opponent.absorbed === 1.5 && hpB.opponent.hp === 71.5, JSON.stringify(hpB));
A.send({ type: 'challenge_final', challengeId: cid, repScores: Array(5).fill(100) });
B.send({ type: 'challenge_final', challengeId: cid, repScores: Array(4).fill(50) });
const [rA, rB] = await Promise.all([A.next('challenge_result'), B.next('challenge_result')]);
check('winner gets score + 50', rA.winnerId === A.id && rA.you.bpAwarded === 100, JSON.stringify(rA.you));
check('loser gets score + 0', rB.you.bpAwarded === 20, JSON.stringify(rB.you));
check('result has the duel: 50 dealt, 6 absorbed by the shield, 14 taken',
  rA.battle?.you.dealt === 50 && rA.battle.you.absorbed === 6 && rA.battle.you.taken === 14 && rB.battle?.opponent.dealt === 50,
  JSON.stringify(rA.battle));
check('result links the stored workout', typeof rA.workoutId === 'string' && rA.workoutId === rB.workoutId);
check('result hides device secrets', !JSON.stringify(rA).includes(A.secret) && !JSON.stringify(rA).includes(B.secret));

// Forfeit: A leaves mid-set (B's rep has no formScore, like an older app)
({ challengeId: cid } = await startBattle());
B.send({ type: 'challenge_rep', challengeId: cid, reps: 1, score: 8, quality: 'green' });
await sleep(100);
A.send({ type: 'challenge_cancel', challengeId: cid });
const fB2 = await B.next('challenge_result');
check('forfeit: stayer wins with live score + 50', fB2.forfeit && fB2.winnerId === B.id && fB2.you.bpAwarded === 58, JSON.stringify(fB2.you));
check('forfeit: leaver gets 0', fB2.opponent.bpAwarded === 0);

await sleep(500); // let both battles commit
const meA = (await A.api('GET', '/api/me')).body;
const meB = (await B.api('GET', '/api/me')).body;
check('A balance 0 + 100 + 0 = 100, 1W 1L', meA.bp === 100 && meA.wins === 1 && meA.losses === 1, JSON.stringify(meA));
check('B balance 20 + 58 = 78, 1W 1L', meB.bp === 78 && meB.wins === 1 && meB.losses === 1, JSON.stringify(meB));
const pr = (await A.api('GET', '/api/pr?exercise=squat&durationS=15')).body;
check('personal record = best of solo and battles', pr?.bestScore === 150 && pr.bestReps === 15, JSON.stringify(pr));

// Workout history, newest first, from my side of each row
const histA = (await A.api('GET', '/api/workouts')).body;
const histB = (await B.api('GET', '/api/workouts')).body;
const brief = (h) => JSON.stringify(h?.map((w) => [w.mode, w.score, w.result, w.opponent?.name, w.bp, w.forfeit]));
check('history A: forfeit loss, win vs B, solo 150, early solo',
  histA?.length === 4
  && histA[0].result === 'loss' && histA[0].forfeit && histA[0].opponent?.name === nameB
  && histA[1].result === 'win' && histA[1].score === 50 && histA[1].opponent?.score === 20 && histA[1].bp === 100
  && histA[2].mode === 'solo' && histA[2].score === 150 && histA[2].bp === 150 && histA[2].opponent === null && histA[2].result === null
  && histA[3].mode === 'solo' && histA[3].bp === 0, brief(histA));
check('history B: forfeit win, loss vs A (scores from B side)',
  histB?.length === 2 && histB[0].result === 'win' && histB[0].bp === 58
  && histB[1].result === 'loss' && histB[1].score === 20 && histB[1].opponent?.name === nameA && histB[1].opponent.score === 50, brief(histB));
check('history: replay flag and avg form', histA[2].hasReplay === true && histA[3].hasReplay === false && histA[2].avgForm === 100
  && histB[1].avgForm === 50, brief(histA));

// One workout: replay data from my side only
const detail = await A.api('GET', `/api/workout?id=${solo.workoutId}`);
check('workout detail: rep detail + pose track round-trip',
  detail.status === 200 && detail.body.me.repDetail.length === 15 && detail.body.me.repDetail[0].t === 0.9
  && detail.body.me.repDetail[0].sub.depth === 100 && detail.body.track?.frames === soloTrack.frames && detail.body.track.fps === 10,
  JSON.stringify({ ...detail.body, track: detail.body?.track && { ...detail.body.track, frames: '…' } }).slice(0, 400));
check('workout detail: malformed track was dropped, set kept',
  (await A.api('GET', `/api/workout?id=${early.workoutId}`)).body?.track === null);
check('workout detail: not mine → 404', (await B.api('GET', `/api/workout?id=${solo.workoutId}`)).status === 404);
check('workout detail: bad id → 400', (await A.api('GET', '/api/workout?id=nope')).status === 400);
const battleB = (await B.api('GET', `/api/workout?id=${rA.workoutId}`)).body;
check('battle detail from the opponent side',
  battleB?.me.name === nameB && battleB.me.repScores.length === 4 && battleB.opponent?.name === nameA && battleB.opponent.repScores.length === 5
  && battleB.battle?.you.dealt === 14 && battleB.battle.opponent.absorbed === 6 && battleB.result === 'loss', JSON.stringify(battleB));

// Trends
const series = (await A.api('GET', '/api/workouts/series?exercise=squat&durationS=15')).body;
check('series: my sets oldest first', series?.length === 4 && series[0].id === early.workoutId && series[3].result === 'loss'
  && new Date(series[0].createdAt) <= new Date(series[3].createdAt), JSON.stringify(series?.map((s) => [s.mode, s.score])));
check('series without a set filter', (await A.api('GET', '/api/workouts/series')).body?.length === 4);
check('series: bad set → 400', (await A.api('GET', '/api/workouts/series?exercise=lunge&durationS=15')).status === 400);

// AI coaching (rule-based text without GEMINI_API_KEY)
const advice = await A.api('GET', `/api/workout/advice?id=${solo.workoutId}`);
check('advice: headline + tips', advice.status === 200 && advice.body.headline && advice.body.tips?.length >= 1, JSON.stringify(advice));
console.log(`INFO  /api/workout/advice source=${advice.body?.source}: ${advice.body?.headline} | ${advice.body?.summary}`);
check('advice: not mine → 404', (await B.api('GET', `/api/workout/advice?id=${solo.workoutId}`)).status === 404);
const recap = await A.api('GET', '/api/recap');
check('recap: text + trend', recap.status === 200 && recap.body.text && recap.body.count === 4, JSON.stringify(recap));
console.log(`INFO  /api/recap source=${recap.body?.source} trend=${recap.body?.trend}: ${recap.body?.text}`);
check('recap: nothing to say without workouts', (await C.api('GET', '/api/recap')).body?.source === 'none');

// Global leaderboard: best single set per person; people without sets are listed last
const board = (await A.api('GET', '/api/leaderboard')).body;
const row = (n) => board?.entries?.find((e) => e.username === n);
if (PERSONA_ON) {
  check('leaderboard: unverified players are not listed', !row(nameA) && !row(nameB) && !row(nameC), JSON.stringify(board?.entries?.slice(0, 5)));
  check('leaderboard: me = unverified, unranked', board?.me?.verified === false && board.me.rank === null, JSON.stringify(board?.me));
} else {
  check('leaderboard: A best 150, B best 20, C listed with no score',
    row(nameA)?.bestScore === 150 && row(nameB)?.bestScore === 20 && row(nameC) && row(nameC).bestScore === null, JSON.stringify(board?.entries?.slice(0, 5)));
  check('leaderboard: ranks in order, me = A', row(nameA).rank < row(nameB).rank && row(nameB).rank < row(nameC).rank
    && row(nameA).isMe && board.me?.rank === row(nameA).rank && board.me.verified === true, JSON.stringify(board?.me));
}

// Coach targets (the global best only counts verified players)
const targets = (await A.api('GET', `/api/targets?exercise=squat&durationS=15&opponent=${nameB}`)).body;
const globalOk = PERSONA_ON ? !targets?.global?.username?.startsWith(`smk_${tag}`) : targets?.global?.score >= 150;
check('targets: personal, friends (B), opponent (B), global',
  targets?.personal?.score === 150 && targets.friends?.score === 20 && targets.friends.username === nameB
  && targets.opponent?.score === 20 && globalOk, JSON.stringify(targets));
check('targets: bad set → 400', (await A.api('GET', '/api/targets?exercise=lunge&durationS=15')).status === 400);
const token = await A.api('GET', '/api/coach/token');
console.log(`INFO  /api/coach/token → ${token.status}${token.status === 200 ? ' (token received)' : ` ${JSON.stringify(token.body)}`}`);

A.ws.close();
B.ws.close();
C.ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;

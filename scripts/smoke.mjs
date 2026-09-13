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

// Solo BP (anti-spam: an instant result earns nothing)
A.send({ type: 'status', busy: true });
await sleep(100);
A.send({ type: 'solo_result', exercise: 'squat', durationS: 15, repScores: Array(15).fill(100) });
const early = await A.next('saved');
check('instant solo result earns 0 BP', early.ok === true && early.bpAwarded === 0, JSON.stringify(early));
A.send({ type: 'status', busy: false });
await sleep(100);
A.send({ type: 'status', busy: true });
await sleep(13_200);
A.send({ type: 'solo_result', exercise: 'squat', durationS: 15, repScores: Array(15).fill(100) });
const solo = await A.next('saved');
check('15 s solo: BP = score (150)', solo.bpAwarded === 150 && solo.bp === 150, JSON.stringify(solo));
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
check('map snapshot has username + gear', seen?.username === nameA && seen.equipped?.offhand === 'low_tier_shield', JSON.stringify(seen));

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
  await Promise.all([A.next('challenge_go'), B.next('challenge_go')]);
  return challengeId;
}
let cid = await startBattle();
A.send({ type: 'challenge_final', challengeId: cid, repScores: Array(5).fill(100) });
B.send({ type: 'challenge_final', challengeId: cid, repScores: Array(4).fill(50) });
const [rA, rB] = await Promise.all([A.next('challenge_result'), B.next('challenge_result')]);
check('winner gets score + 50', rA.winnerId === A.id && rA.you.bpAwarded === 100, JSON.stringify(rA.you));
check('loser gets score + 0', rB.you.bpAwarded === 20, JSON.stringify(rB.you));
check('result hides device secrets', !JSON.stringify(rA).includes(A.secret) && !JSON.stringify(rA).includes(B.secret));

// Forfeit: A leaves mid-set
cid = await startBattle();
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
const token = await A.api('GET', '/api/coach/token');
console.log(`INFO  /api/coach/token → ${token.status}${token.status === 200 ? ' (token received)' : ` ${JSON.stringify(token.body)}`}`);

A.ws.close();
B.ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;

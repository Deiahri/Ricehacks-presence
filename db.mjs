// Accounts, friends, BP and workout history in Postgres (Tiger Cloud). DATABASE_URL comes from the environment
// and is never logged. Without it (local dev) nothing is stored and the /api routes answer 503, so the relay still runs.
import pg from 'pg';
import { AUTO_EQUIP_ON_BUY, COSMETICS, SLOTS, STARTING_BP, battleBp, levelFor, soloBp } from './game-config.mjs';

const DDL = `
CREATE TABLE IF NOT EXISTS workouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  mode           text NOT NULL CHECK (mode IN ('solo', 'challenge')),
  exercise       text NOT NULL CHECK (exercise IN ('squat', 'pushup')),
  duration_s     integer NOT NULL,
  user_id        text NOT NULL,
  user_name      text NOT NULL,
  score          integer NOT NULL,
  reps           integer NOT NULL,
  avg_form       real,
  rep_scores     real[] NOT NULL DEFAULT '{}',
  challenge_id   uuid UNIQUE,
  opponent_id    text,
  opponent_name  text,
  opponent_score integer,
  opponent_reps  integer,
  winner_id      text,
  forfeit        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS workouts_user_idx ON workouts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workouts_opponent_idx ON workouts (opponent_id, created_at DESC);

-- Accounts. device_secret is the random id the app keeps in localStorage; it is never broadcast.
-- id is the stable key everything else points at, so a username is just a renameable handle
-- (and a future auth provider's subject id can map onto the same row).
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_secret text NOT NULL UNIQUE,
  username      text CHECK (username IS NULL OR username ~ '^[A-Za-z0-9_]{3,16}$'),
  shirt         text,
  bp            integer NOT NULL DEFAULT 0 CHECK (bp >= 0),
  equipped      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

CREATE TABLE IF NOT EXISTS friend_requests (
  from_user  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_user, to_user),
  CHECK (from_user <> to_user)
);
CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON friend_requests (to_user, created_at DESC);

-- One row per pair, smaller id first.
CREATE TABLE IF NOT EXISTS friendships (
  user_a     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_b_idx ON friendships (user_b);

CREATE TABLE IF NOT EXISTS user_items (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);

-- Every BP change. (user, reason, ref) is unique, so an award can't be paid twice.
CREATE TABLE IF NOT EXISTS bp_ledger (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      integer NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('solo', 'battle', 'purchase', 'grant')),
  ref        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, reason, ref)
);

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS user_uid     uuid,
  ADD COLUMN IF NOT EXISTS opponent_uid uuid,
  ADD COLUMN IF NOT EXISTS winner_uid   uuid,
  ADD COLUMN IF NOT EXISTS user_bp      integer,
  ADD COLUMN IF NOT EXISTS opponent_bp  integer;
CREATE INDEX IF NOT EXISTS workouts_uid_pr_idx ON workouts (user_uid, exercise, duration_s);
CREATE INDEX IF NOT EXISTS workouts_opp_uid_pr_idx ON workouts (opponent_uid, exercise, duration_s);
CREATE INDEX IF NOT EXISTS workouts_winner_uid_idx ON workouts (winner_uid);

-- Sign-in: a Clerk user id owns one row. device_secret is only used without Clerk (local dev, the smoke test).
ALTER TABLE users ALTER COLUMN device_secret DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_sub text,
  ADD COLUMN IF NOT EXISTS skin     text;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_sub_key ON users (auth_sub);

-- What happened to friend requests I sent.
CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('friend_accepted', 'friend_declined')),
  actor      uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
`;

const COLUMNS = [
  'mode', 'exercise', 'duration_s', 'user_id', 'user_name', 'score', 'reps', 'avg_form', 'rep_scores',
  'challenge_id', 'opponent_id', 'opponent_name', 'opponent_score', 'opponent_reps', 'winner_id', 'forfeit',
  'user_uid', 'opponent_uid', 'winner_uid', 'user_bp', 'opponent_bp',
];
const INSERT = `INSERT INTO workouts (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;

/** An error the HTTP layer turns into a status code and a short machine-readable reason. */
export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Tiger Cloud connection strings say sslmode=require, meaning libpq's "encrypt, don't verify": their CA
// (ca.timescale.com) is private, so it isn't in Node's trust store. pg 8 treats require as verify-full and rejects
// that chain, so opt into libpq semantics. A URL that picks its own mode (e.g. verify-full + sslrootcert) is untouched.
function pgUrl(raw) {
  const url = new URL(raw);
  if (url.searchParams.get('sslmode') === 'require' && !url.searchParams.has('uselibpqcompat')) {
    url.searchParams.set('uselibpqcompat', 'true');
  }
  return url.toString();
}

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: pgUrl(process.env.DATABASE_URL), max: 5, idleTimeoutMillis: 30_000 })
  : null;
pool?.on('error', (e) => console.error('[db] idle client error:', e.message));

export const hasDb = () => pool !== null;

let ready = null;
function ensureTables() {
  ready ??= pool.query(DDL).then(
    () => console.log('[db] tables ready'),
    (e) => { ready = null; throw e; }, // retry on the next query
  );
  return ready;
}

export function initDb() {
  if (!pool) {
    console.log('[db] DATABASE_URL not set; accounts and workouts will not be stored');
    return Promise.resolve();
  }
  return ensureTables();
}

async function q(text, params) {
  await ensureTables();
  return pool.query(text, params);
}

async function withTx(fn) {
  await ensureTables();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- accounts -----------------------------------------------------------------

const uidBySecret = new Map(); // a user's id never changes, so cache it

/** The user row for a device secret, created on first sight. Resolves to its id. */
export async function ensureUser(secret, shirt = null) {
  const cached = uidBySecret.get(secret);
  if (cached) return cached;
  const { rows } = await q(
    `INSERT INTO users (device_secret, shirt, bp) VALUES ($1, $2, $3)
     ON CONFLICT (device_secret) DO UPDATE SET shirt = COALESCE(users.shirt, EXCLUDED.shirt)
     RETURNING id, (xmax = 0) AS inserted`,
    [secret, shirt, STARTING_BP],
  );
  const { id, inserted } = rows[0];
  if (inserted) {
    // Workouts stored before accounts existed carry the device secret; attach them to the new account.
    await q(
      `UPDATE workouts SET
         user_uid     = CASE WHEN user_id = $2 THEN $1::uuid ELSE user_uid END,
         opponent_uid = CASE WHEN opponent_id = $2 THEN $1::uuid ELSE opponent_uid END,
         winner_uid   = CASE WHEN winner_id = $2 THEN $1::uuid ELSE winner_uid END
       WHERE (user_id = $2 AND user_uid IS NULL) OR (opponent_id = $2 AND opponent_uid IS NULL)
          OR (winner_id = $2 AND winner_uid IS NULL)`,
      [id, secret],
    );
  }
  uidBySecret.set(secret, id);
  return id;
}

const uidBySub = new Map();

/** The user row for a signed-in (Clerk) user id, created on first sight. Resolves to its id. */
export async function ensureAuthUser(sub, shirt = null) {
  const cached = uidBySub.get(sub);
  if (cached) return cached;
  const { rows } = await q(
    `INSERT INTO users (auth_sub, shirt, bp) VALUES ($1, $2, $3)
     ON CONFLICT (auth_sub) DO UPDATE SET shirt = COALESCE(users.shirt, EXCLUDED.shirt)
     RETURNING id`,
    [sub, shirt, STARTING_BP],
  );
  uidBySub.set(sub, rows[0].id);
  return rows[0].id;
}

const PROFILE_SELECT = `
  SELECT u.id, u.username, u.shirt, u.skin, u.bp, u.equipped,
    ARRAY(SELECT item_id FROM user_items WHERE user_id = u.id ORDER BY acquired_at) AS owned,
    (SELECT COALESCE(sum(delta), 0) FROM bp_ledger WHERE user_id = u.id AND delta > 0)::int AS earned,
    (SELECT count(*) FROM workouts WHERE winner_uid = u.id)::int AS wins,
    (SELECT count(*) FROM workouts WHERE mode = 'challenge' AND winner_uid IS NOT NULL AND winner_uid <> u.id
       AND (user_uid = u.id OR opponent_uid = u.id))::int AS losses
  FROM users u WHERE u.id = ANY($1::uuid[])`;

const toProfile = (r) => ({
  id: r.id, username: r.username, shirt: r.shirt, skin: r.skin, bp: r.bp, equipped: r.equipped ?? {}, owned: r.owned,
  wins: r.wins, losses: r.losses, level: levelFor(r.earned),
});

async function profiles(ids) {
  if (!ids.length) return [];
  const { rows } = await q(PROFILE_SELECT, [ids]);
  return rows.map(toProfile);
}

/** { id, username, shirt, bp, equipped, owned[], wins, losses, level } */
export async function getProfile(uid) {
  const [p] = await profiles([uid]);
  if (!p) throw new HttpError(404, 'no-user');
  return p;
}

export async function claimUsername(uid, username) {
  try {
    await q('UPDATE users SET username = $2 WHERE id = $1', [uid, username]);
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'taken');
    if (e.code === '23514') throw new HttpError(400, 'invalid');
    throw e;
  }
  return getProfile(uid);
}

/** Change skin tone and/or shirt colour (null keeps the current one). Values are validated by the caller. */
export async function setAppearance(uid, { skin, shirt }) {
  await q('UPDATE users SET skin = COALESCE($2, skin), shirt = COALESCE($3, shirt) WHERE id = $1', [uid, skin, shirt]);
  return getProfile(uid);
}

async function uidOfUsername(client, username) {
  const { rows } = await client.query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  return rows[0]?.id ?? null;
}

async function requireUsername(client, uid) {
  const { rows } = await client.query('SELECT username FROM users WHERE id = $1', [uid]);
  if (!rows[0]?.username) throw new HttpError(400, 'no-username');
  return rows[0].username;
}

// --- friends ------------------------------------------------------------------

const pair = (x, y) => (x < y ? [x, y] : [y, x]);

/** Tell `uid` what `actor` did with their request. Resolves the notification id. */
async function notify(c, uid, type, actor) {
  const { rows } = await c.query('INSERT INTO notifications (user_id, type, actor) VALUES ($1, $2, $3) RETURNING id', [uid, type, actor]);
  return rows[0].id;
}

/**
 * Resolves { status: 'sent' | 'accepted', to: uid, notification?: id }. A request to someone who already asked you
 * accepts theirs (and tells them so).
 */
export function sendFriendRequest(uid, username) {
  return withTx(async (c) => {
    await requireUsername(c, uid);
    const to = await uidOfUsername(c, username);
    if (!to) throw new HttpError(404, 'not-found');
    if (to === uid) throw new HttpError(400, 'self');
    const [a, b] = pair(uid, to);
    const friends = await c.query('SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2', [a, b]);
    if (friends.rowCount) throw new HttpError(409, 'already-friends');
    const reverse = await c.query('DELETE FROM friend_requests WHERE from_user = $1 AND to_user = $2', [to, uid]);
    if (reverse.rowCount) {
      await c.query('INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a, b]);
      return { status: 'accepted', to, notification: await notify(c, to, 'friend_accepted', uid) };
    }
    await c.query('INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, to]);
    return { status: 'sent', to };
  });
}

/** Accept or decline `username`'s request to `uid`, and tell them. Resolves { from: requester id, notification: id }. */
export function respondFriendRequest(uid, username, accept) {
  return withTx(async (c) => {
    const from = await uidOfUsername(c, username);
    if (!from) throw new HttpError(404, 'not-found');
    const req = await c.query('DELETE FROM friend_requests WHERE from_user = $1 AND to_user = $2', [from, uid]);
    if (!req.rowCount) throw new HttpError(404, 'no-request');
    if (accept) {
      await c.query('INSERT INTO friendships (user_a, user_b) VALUES ($1, $2) ON CONFLICT DO NOTHING', pair(uid, from));
    }
    return { from, notification: await notify(c, from, accept ? 'friend_accepted' : 'friend_declined', uid) };
  });
}

// --- notifications --------------------------------------------------------------

/** My latest notifications (or just one, by id), newest first: { id, type, createdAt, read, actor: profile | null }. */
export async function listNotifications(uid, onlyId = null) {
  const { rows } = await q(
    `SELECT id, type, actor, created_at, read_at FROM notifications
     WHERE user_id = $1 AND ($2::bigint IS NULL OR id = $2) ORDER BY created_at DESC, id DESC LIMIT 30`,
    [uid, onlyId],
  );
  const actors = new Map((await profiles([...new Set(rows.map((r) => r.actor).filter(Boolean))])).map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: Number(r.id), type: r.type, createdAt: r.created_at, read: r.read_at !== null, actor: actors.get(r.actor) ?? null,
  }));
}

export async function markNotificationsRead(uid) {
  await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [uid]);
}

/** Profiles of my friends plus pending requests both ways (each includes its `id`). */
export async function listFriends(uid) {
  const [friends, incoming, outgoing] = await Promise.all([
    q(`SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = $1 OR user_b = $1`, [uid]),
    q('SELECT from_user AS id FROM friend_requests WHERE to_user = $1 ORDER BY created_at DESC', [uid]),
    q('SELECT to_user AS id FROM friend_requests WHERE from_user = $1 ORDER BY created_at DESC', [uid]),
  ]);
  const ids = (r) => r.rows.map((x) => x.id);
  const all = await profiles([...new Set([...ids(friends), ...ids(incoming), ...ids(outgoing)])]);
  const byId = new Map(all.map((p) => [p.id, p]));
  const pick = (r) => ids(r).map((id) => byId.get(id)).filter((p) => p?.username);
  return { friends: pick(friends), incoming: pick(incoming), outgoing: pick(outgoing) };
}

/** Ids of everyone `uid` is friends with. */
export async function friendIds(uid) {
  const { rows } = await q(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id FROM friendships WHERE user_a = $1 OR user_b = $1`, [uid]);
  return rows.map((r) => r.id);
}

// --- shop ---------------------------------------------------------------------

export async function buyItem(uid, itemId) {
  const item = Object.hasOwn(COSMETICS, itemId) ? COSMETICS[itemId] : null;
  if (!item) throw new HttpError(404, 'no-item');
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT bp FROM users WHERE id = $1 FOR UPDATE', [uid]);
    if (!rows[0]) throw new HttpError(404, 'no-user');
    const owned = await c.query('SELECT 1 FROM user_items WHERE user_id = $1 AND item_id = $2', [uid, itemId]);
    if (owned.rowCount) throw new HttpError(409, 'owned');
    if (rows[0].bp < item.cost) throw new HttpError(402, 'insufficient-bp');
    await c.query('UPDATE users SET bp = bp - $2 WHERE id = $1', [uid, item.cost]);
    await c.query('INSERT INTO user_items (user_id, item_id) VALUES ($1, $2)', [uid, itemId]);
    await c.query(`INSERT INTO bp_ledger (user_id, delta, reason, ref) VALUES ($1, $2, 'purchase', $3)`, [uid, -item.cost, itemId]);
    if (AUTO_EQUIP_ON_BUY) {
      await c.query('UPDATE users SET equipped = equipped || jsonb_build_object($2::text, $3::text) WHERE id = $1', [uid, item.slot, itemId]);
    }
  });
  return getProfile(uid);
}

/** Put `itemId` in `slot`, or empty the slot when itemId is null. */
export async function equipItem(uid, slot, itemId) {
  if (!SLOTS.includes(slot)) throw new HttpError(400, 'bad-slot');
  if (itemId === null) {
    await q('UPDATE users SET equipped = equipped - $2::text WHERE id = $1', [uid, slot]);
    return getProfile(uid);
  }
  const item = Object.hasOwn(COSMETICS, itemId) ? COSMETICS[itemId] : null;
  if (!item) throw new HttpError(404, 'no-item');
  if (item.slot !== slot) throw new HttpError(400, 'wrong-slot');
  const { rowCount } = await q(
    `UPDATE users SET equipped = equipped || jsonb_build_object($2::text, $3::text)
     WHERE id = $1 AND EXISTS (SELECT 1 FROM user_items WHERE user_id = $1 AND item_id = $3)`,
    [uid, slot, itemId],
  );
  if (!rowCount) throw new HttpError(403, 'not-owned');
  return getProfile(uid);
}

// --- workouts and awards --------------------------------------------------------

/** Best score and best reps for this exercise and set length, from either side of any stored set. */
export async function personalRecord(uid, exercise, durationS) {
  const { rows } = await q(
    `SELECT max(score)::int AS best_score, max(reps)::int AS best_reps FROM (
       SELECT score, reps FROM workouts WHERE user_uid = $1 AND exercise = $2 AND duration_s = $3
       UNION ALL
       SELECT opponent_score, opponent_reps FROM workouts WHERE opponent_uid = $1 AND exercise = $2 AND duration_s = $3
     ) t`,
    [uid, exercise, durationS],
  );
  return { bestScore: rows[0].best_score, bestReps: rows[0].best_reps };
}

/** Every stored set as (uid, score, reps, exercise, duration_s, created_at), from either side of a battle. */
const ALL_SETS = `
  SELECT user_uid AS uid, score, reps, exercise, duration_s, created_at FROM workouts WHERE user_uid IS NOT NULL
  UNION ALL
  SELECT opponent_uid, opponent_score, opponent_reps, exercise, duration_s, created_at FROM workouts
  WHERE opponent_uid IS NOT NULL AND opponent_score IS NOT NULL`;

/** The best set for one exercise + length, among `uids` (null = everyone). { score, reps, username } or null. */
async function topSet(exercise, durationS, uids) {
  const { rows } = await q(
    `SELECT s.score, s.reps, u.username FROM (${ALL_SETS}) s JOIN users u ON u.id = s.uid
     WHERE s.exercise = $1 AND s.duration_s = $2 AND ($3::uuid[] IS NULL OR s.uid = ANY($3::uuid[]))
     ORDER BY s.score DESC, s.reps DESC, s.created_at LIMIT 1`,
    [exercise, durationS, uids],
  );
  return rows[0] ?? null;
}

/**
 * Scores to beat for one exercise + set length (for the coach): my best, the best on the server, the best among my
 * friends, and — given a username — that opponent's best. Each is { score, reps, username? } or null.
 */
export async function scoreTargets(uid, exercise, durationS, opponentUsername = null) {
  const opponentId = async () =>
    (await q('SELECT id FROM users WHERE lower(username) = lower($1)', [opponentUsername])).rows[0]?.id ?? null;
  const [mine, global, friends, opponent] = await Promise.all([
    personalRecord(uid, exercise, durationS),
    topSet(exercise, durationS, null),
    friendIds(uid).then((ids) => (ids.length ? topSet(exercise, durationS, ids) : null)),
    opponentUsername ? opponentId().then((id) => (id ? topSet(exercise, durationS, [id]) : null)) : null,
  ]);
  const personal = mine.bestScore === null ? null : { score: mine.bestScore, reps: mine.bestReps };
  return { personal, global, friends, opponent };
}

/**
 * The global leaderboard: everyone with a username, ranked by their best single set (any exercise or length).
 * People with no sets are included and share the last rank. Resolves { entries (top `limit`), me: { rank, bestScore } }.
 */
export async function globalLeaderboard(uid, limit = 100) {
  const { rows } = await q(
    `WITH best AS (
       SELECT DISTINCT ON (uid) uid, score, reps, exercise, duration_s FROM (${ALL_SETS}) s
       ORDER BY uid, score DESC, created_at
     ), ranked AS (
       SELECT u.id, b.score, b.reps, b.exercise, b.duration_s,
         rank() OVER (ORDER BY b.score DESC NULLS LAST) AS rank,
         row_number() OVER (ORDER BY b.score DESC NULLS LAST, lower(u.username)) AS pos
       FROM users u LEFT JOIN best b ON b.uid = u.id
       WHERE u.username IS NOT NULL
     )
     SELECT * FROM ranked WHERE pos <= $2 OR id = $1 ORDER BY pos`,
    [uid, limit],
  );
  const byId = new Map((await profiles(rows.map((r) => r.id))).map((p) => [p.id, p]));
  const entries = rows.filter((r) => Number(r.pos) <= limit).map((r) => {
    const p = byId.get(r.id);
    return {
      rank: Number(r.rank), username: p.username, shirt: p.shirt, skin: p.skin, equipped: p.equipped, level: p.level,
      bestScore: r.score, bestReps: r.reps, exercise: r.exercise, durationS: r.duration_s, isMe: r.id === uid,
    };
  });
  const mine = rows.find((r) => r.id === uid);
  return { entries, me: mine ? { rank: Number(mine.rank), bestScore: mine.score } : null };
}

/** Pay an award once. Resolves the user's new balance, or null if this award was already paid. */
async function award(c, uid, delta, reason, ref) {
  const paid = await c.query(
    'INSERT INTO bp_ledger (user_id, delta, reason, ref) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [uid, delta, reason, ref]);
  if (!paid.rowCount) return null;
  const { rows } = await c.query('UPDATE users SET bp = bp + $2 WHERE id = $1 RETURNING bp', [uid, delta]);
  return rows[0]?.bp ?? null;
}

/**
 * Store a solo set and pay its BP (when `earn`). Resolves { stored, bpAwarded, bp }.
 * Without a database the set is only logged.
 */
export async function recordSolo({ uid, secret, name, exercise, durationS, scores, score, avgForm, earn }) {
  const bpAwarded = uid && earn ? soloBp(score) : 0;
  if (!pool) {
    console.log(`[db] skipped solo ${exercise} ${durationS}s score=${score} reps=${scores.length}`);
    return { stored: false, bpAwarded: 0, bp: null };
  }
  return withTx(async (c) => {
    const row = {
      mode: 'solo', exercise, duration_s: durationS, user_id: secret, user_name: name, score, reps: scores.length,
      avg_form: avgForm, rep_scores: scores, forfeit: false, user_uid: uid, user_bp: bpAwarded,
    };
    const { rows } = await c.query(INSERT, COLUMNS.map((k) => row[k] ?? null));
    let bp = null;
    if (uid && bpAwarded > 0) bp = await award(c, uid, bpAwarded, 'solo', rows[0].id);
    return { stored: true, bpAwarded, bp };
  });
}

/**
 * Store a finished battle (one row) and pay both sides. `sides` = [{ uid, bpAwarded }] for the user and opponent.
 * Resolves true when stored.
 */
export async function recordChallenge(row, sides) {
  if (!pool) {
    console.log(`[db] skipped challenge ${row.exercise} ${row.duration_s}s ${row.score}-${row.opponent_score}`);
    return false;
  }
  await withTx(async (c) => {
    await c.query(INSERT, COLUMNS.map((k) => row[k] ?? null));
    for (const s of sides) if (s.uid && s.bpAwarded > 0) await award(c, s.uid, s.bpAwarded, 'battle', row.challenge_id);
  });
  return true;
}

export { battleBp };

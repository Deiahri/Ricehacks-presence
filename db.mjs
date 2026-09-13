// Accounts, friends, BP and workout history in Postgres (Tiger Cloud). DATABASE_URL comes from the environment
// and is never logged. Without it (local dev) nothing is stored and the /api routes answer 503, so the relay still runs.
import pg from 'pg';
import { AUTO_EQUIP_ON_BUY, COSMETICS, SLOTS, STARTING_BP, WHEEL, battleBp, soloBp, xpForScores } from './game-config.mjs';
import { addDays, buildProgress, pickWedge, settleWeek } from './progress.mjs';
import { personaConfigured } from './persona.mjs';

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

-- Replays. rep_detail = [{ t (s into the set), s (form), d (rep seconds), sub {name: 0-100}, c [cues] }] per side.
-- battle_detail = the HP duel as settled: { hpMax, user: SideOut, opponent: SideOut } (see battle-effects.mjs).
ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS rep_detail          jsonb,
  ADD COLUMN IF NOT EXISTS opponent_rep_scores real[],
  ADD COLUMN IF NOT EXISTS opponent_rep_detail jsonb,
  ADD COLUMN IF NOT EXISTS opponent_avg_form   real,
  ADD COLUMN IF NOT EXISTS battle_detail       jsonb;

-- Pose track per side: a fixed-rate grid of frames, each joints × (x, y) bytes (0-254 across the image, 255 = unseen).
CREATE TABLE IF NOT EXISTS workout_tracks (
  workout_id uuid NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  side       text NOT NULL CHECK (side IN ('user', 'opponent')),
  fps        smallint NOT NULL,
  joints     smallint NOT NULL,
  aspect     real NOT NULL,
  mirrored   boolean NOT NULL,
  frames     bytea NOT NULL,
  PRIMARY KEY (workout_id, side)
);

-- AI coaching, cached. Advice is per viewer, since a battle row is seen from two sides.
CREATE TABLE IF NOT EXISTS workout_insights (
  workout_id uuid NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  advice     jsonb NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workout_id, user_id)
);
-- The "how you've been doing" recap: valid while my latest workout and count are unchanged.
CREATE TABLE IF NOT EXISTS user_recaps (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  latest_workout_id uuid,
  workout_count     integer NOT NULL,
  recap             jsonb NOT NULL,
  model             text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Identity (Persona): verified_at is set once an inquiry for this account passes. One inquiry verifies one account.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verified_at     timestamptz,
  ADD COLUMN IF NOT EXISTS persona_inquiry text;
CREATE UNIQUE INDEX IF NOT EXISTS users_persona_inquiry_key ON users (persona_inquiry);

-- Weekly XP goal (Monday→Sunday in the user's zone tz), banked streak-saver days, and one row per week since the
-- goal was set: its XP, when the goal was met, saver days spent keeping it open past Sunday, closed once it's missed
-- for good, and the wheel reward once spun (a met week with no reward yet owes a spin).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS weekly_goal integer,
  ADD COLUMN IF NOT EXISTS goal_since  timestamptz,
  ADD COLUMN IF NOT EXISTS tz          text,
  ADD COLUMN IF NOT EXISTS saver_days  integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS goal_weeks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  goal       integer NOT NULL,
  xp         integer NOT NULL DEFAULT 0,
  met_at     timestamptz,
  extra_days integer NOT NULL DEFAULT 0,
  closed     boolean NOT NULL DEFAULT false,
  reward     jsonb,
  PRIMARY KEY (user_id, week_start)
);
-- XP each side earned for a set (1 per rep, 2 per perfect rep; 0 when the set earned no BP). Older rows are filled in once.
ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS user_xp     integer,
  ADD COLUMN IF NOT EXISTS opponent_xp integer;
UPDATE workouts SET user_xp = CASE WHEN user_bp > 0
  THEN cardinality(rep_scores) + (SELECT count(*) FROM unnest(rep_scores) s WHERE s >= 80) ELSE 0 END WHERE user_xp IS NULL;
UPDATE workouts SET opponent_xp = CASE WHEN opponent_bp > 0 AND opponent_rep_scores IS NOT NULL
  THEN cardinality(opponent_rep_scores) + (SELECT count(*) FROM unnest(opponent_rep_scores) s WHERE s >= 80) ELSE 0 END WHERE opponent_xp IS NULL;
CREATE INDEX IF NOT EXISTS workouts_user_uid_idx     ON workouts (user_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS workouts_opponent_uid_idx ON workouts (opponent_uid, created_at DESC);
-- The wheel pays BP too.
ALTER TABLE bp_ledger DROP CONSTRAINT IF EXISTS bp_ledger_reason_check;
ALTER TABLE bp_ledger ADD CONSTRAINT bp_ledger_reason_check CHECK (reason IN ('solo', 'battle', 'purchase', 'grant', 'wheel'));
`;

const COLUMNS = [
  'id', 'mode', 'exercise', 'duration_s', 'user_id', 'user_name', 'score', 'reps', 'avg_form', 'rep_scores',
  'challenge_id', 'opponent_id', 'opponent_name', 'opponent_score', 'opponent_reps', 'winner_id', 'forfeit',
  'user_uid', 'opponent_uid', 'winner_uid', 'user_bp', 'opponent_bp',
  'rep_detail', 'opponent_rep_scores', 'opponent_rep_detail', 'opponent_avg_form', 'battle_detail', 'user_xp', 'opponent_xp',
];
/** pg sends JS arrays as Postgres arrays, so jsonb values go over as JSON text. */
const JSONB = new Set(['rep_detail', 'opponent_rep_detail', 'battle_detail']);
const INSERT = `INSERT INTO workouts (${COLUMNS.join(', ')}) VALUES (${
  COLUMNS.map((k, i) => (k === 'id' ? `COALESCE($${i + 1}::uuid, gen_random_uuid())` : `$${i + 1}`)).join(', ')}) RETURNING id`;
const insertParams = (row) => COLUMNS.map((k) => (JSONB.has(k) ? (row[k] == null ? null : JSON.stringify(row[k])) : row[k] ?? null));

/** Store pose tracks for a workout: [{ side, fps, joints, aspect, mirrored, frames: Buffer }] (nulls skipped). */
async function insertTracks(c, workoutId, tracks) {
  for (const t of tracks) {
    if (!t) continue;
    await c.query(
      'INSERT INTO workout_tracks (workout_id, side, fps, joints, aspect, mirrored, frames) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [workoutId, t.side, t.fps, t.joints, t.aspect, t.mirrored, t.frames],
    );
  }
}

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

/** Today's date and this week's Monday, in the user's zone. */
const LOCAL_TODAY = `(now() AT TIME ZONE COALESCE(u.tz, 'UTC'))::date`;
const LOCAL_WEEK = `date_trunc('week', now() AT TIME ZONE COALESCE(u.tz, 'UTC'))::date`;

const PROFILE_SELECT = `
  SELECT u.id, u.username, u.shirt, u.skin, u.bp, u.equipped, u.verified_at, u.weekly_goal, u.saver_days,
    ARRAY(SELECT item_id FROM user_items WHERE user_id = u.id ORDER BY acquired_at) AS owned,
    (SELECT count(*) FROM workouts WHERE winner_uid = u.id)::int AS wins,
    (SELECT count(*) FROM workouts WHERE mode = 'challenge' AND winner_uid IS NOT NULL AND winner_uid <> u.id
       AND (user_uid = u.id OR opponent_uid = u.id))::int AS losses,
    (SELECT count(*) FROM goal_weeks WHERE user_id = u.id AND met_at IS NOT NULL)::int AS weeks_met,
    EXISTS (SELECT 1 FROM goal_weeks WHERE user_id = u.id AND met_at IS NOT NULL AND reward IS NULL) AS pending_reward,
    (SELECT row_to_json(w) FROM (
       SELECT g.xp, g.goal, g.met_at IS NOT NULL AS met FROM goal_weeks g WHERE g.user_id = u.id AND g.week_start = ${LOCAL_WEEK}) w
    ) AS this_week,
    (SELECT row_to_json(w) FROM (
       SELECT g.week_start::text AS "weekStart", g.xp, g.goal, ((g.week_start + 7 + g.extra_days) - ${LOCAL_TODAY})::int AS "daysLeft"
       FROM goal_weeks g WHERE g.user_id = u.id AND NOT g.closed AND g.met_at IS NULL AND g.week_start < ${LOCAL_WEEK}
       ORDER BY g.week_start DESC LIMIT 1) w
    ) AS extension
  FROM users u WHERE u.id = ANY($1::uuid[])`;

const toProfile = (r) => ({
  id: r.id, username: r.username, shirt: r.shirt, skin: r.skin, bp: r.bp, equipped: r.equipped ?? {}, owned: r.owned,
  wins: r.wins, losses: r.losses,
  // Every week the goal was met is a level.
  level: 1 + r.weeks_met,
  weeklyGoal: r.weekly_goal, weekXp: r.this_week?.xp ?? 0, weekMet: r.this_week?.met ?? false,
  saverDays: r.saver_days, pendingReward: r.pending_reward,
  // Last week, while a saver day keeps it open (null otherwise; stale until the next settle, hence the daysLeft check).
  extension: r.extension && r.extension.daysLeft > 0 ? r.extension : null,
  // Verification off (no Persona key) = everyone counts as verified.
  verified: !personaConfigured() || r.verified_at !== null,
});

async function profiles(ids) {
  if (!ids.length) return [];
  const { rows } = await q(PROFILE_SELECT, [ids]);
  return rows.map(toProfile);
}

/** { id, username, shirt, bp, equipped, owned[], wins, losses, level, weeklyGoal, weekXp, … } */
export async function getProfile(uid) {
  const [p] = await profiles([uid]);
  if (!p) throw new HttpError(404, 'no-user');
  return p;
}

/** The profile after settling the user's weeks (a past week may just have closed or spent a saver). */
export async function refreshProfile(uid) {
  await withTx((c) => settleWeeks(c, uid));
  return getProfile(uid);
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

/** Mark `uid` verified by a passed Persona inquiry (checked by the caller). 409 inquiry-used if another account used it. */
export async function markVerified(uid, inquiryId) {
  try {
    await q(
      'UPDATE users SET verified_at = COALESCE(verified_at, now()), persona_inquiry = COALESCE(persona_inquiry, $2) WHERE id = $1',
      [uid, inquiryId],
    );
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'inquiry-used');
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

// --- weekly goal ----------------------------------------------------------------

/**
 * Bring `uid`'s week rows up to date, inside a transaction (locks the user row): add the rows since the goal was set
 * and close unfinished past weeks, spending one banked saver day per day past Sunday first.
 * Resolves { goal, tz, today, week, savers }, or null while no goal is set.
 */
async function settleWeeks(c, uid) {
  const { rows: [u] } = await c.query(
    `SELECT weekly_goal, goal_since, COALESCE(tz, 'UTC') AS tz, saver_days FROM users WHERE id = $1 FOR UPDATE`, [uid]);
  if (!u?.weekly_goal) return null;
  const { rows: [d] } = await c.query(
    `SELECT (now() AT TIME ZONE $1)::date::text AS today, date_trunc('week', now() AT TIME ZONE $1)::date::text AS week,
            greatest(date_trunc('week', $2::timestamptz AT TIME ZONE $1)::date, date_trunc('week', now() AT TIME ZONE $1)::date - 364)::text AS first`,
    [u.tz, u.goal_since]);
  await c.query(
    `INSERT INTO goal_weeks (user_id, week_start, goal)
     SELECT $1, s::date, $4 FROM generate_series($2::date, $3::date, interval '7 days') s ON CONFLICT DO NOTHING`,
    [uid, d.first, d.week, u.weekly_goal]);
  const { rows: open } = await c.query(
    `SELECT week_start::text, extra_days FROM goal_weeks
     WHERE user_id = $1 AND week_start < $2 AND NOT closed AND met_at IS NULL ORDER BY week_start`, [uid, d.week]);
  let savers = u.saver_days;
  for (const w of open) {
    const s = settleWeek({ weekStart: w.week_start, extraDays: w.extra_days, savers, today: d.today });
    savers = s.saversLeft;
    if (s.extraDays !== w.extra_days || s.closed) {
      await c.query('UPDATE goal_weeks SET extra_days = $3, closed = $4 WHERE user_id = $1 AND week_start = $2',
        [uid, w.week_start, s.extraDays, s.closed]);
    }
  }
  if (savers !== u.saver_days) await c.query('UPDATE users SET saver_days = $2 WHERE id = $1', [uid, savers]);
  return { goal: u.weekly_goal, tz: u.tz, today: d.today, week: d.week, savers };
}

/**
 * Credit `xp` to this week and to a past week a saver is keeping open (a set on a bonus day counts for both).
 * Resolves the Mondays of the weeks that just reached their goal, i.e. the level-ups.
 */
async function addWeekXp(c, uid, xp) {
  const s = await settleWeeks(c, uid);
  if (!s || xp <= 0) return [];
  const { rows } = await c.query(
    `UPDATE goal_weeks SET xp = xp + $3, met_at = COALESCE(met_at, CASE WHEN xp + $3 >= goal THEN now() END)
     WHERE user_id = $1 AND NOT closed AND week_start <= $2 AND (week_start = $2 OR met_at IS NULL)
     RETURNING week_start::text, (met_at IS NOT NULL AND xp - $3 < goal) AS just_met`, [uid, s.week, xp]);
  return rows.filter((r) => r.just_met).map((r) => r.week_start);
}

/** Set the weekly XP goal (range-checked by the caller) and the user's IANA zone. 400 bad-tz for a zone Postgres doesn't know. */
export async function setWeeklyGoal(uid, goal, tz) {
  if (tz !== null && !(await q('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz])).rowCount) throw new HttpError(400, 'bad-tz');
  await withTx(async (c) => {
    await c.query(
      'UPDATE users SET weekly_goal = $2, goal_since = COALESCE(goal_since, now()), tz = COALESCE($3, tz) WHERE id = $1', [uid, goal, tz]);
    const s = await settleWeeks(c, uid);
    // The week in progress takes the new goal (a lower one can complete it on the spot).
    await c.query(
      `UPDATE goal_weeks SET goal = $3, met_at = COALESCE(met_at, CASE WHEN xp >= $3 THEN now() END) WHERE user_id = $1 AND week_start = $2`,
      [uid, s.week, goal]);
  });
  return getProfile(uid);
}

/** Recent weeks and their days for the progress calendar; see buildProgress for the shape. */
export async function weeklyProgress(uid, weeksBack = 12) {
  return withTx(async (c) => {
    const s = await settleWeeks(c, uid);
    if (!s) {
      const { rows: [u] } = await c.query(
        `SELECT saver_days, (now() AT TIME ZONE COALESCE(tz, 'UTC'))::date::text AS today,
                date_trunc('week', now() AT TIME ZONE COALESCE(tz, 'UTC'))::date::text AS week FROM users WHERE id = $1`, [uid]);
      if (!u) throw new HttpError(404, 'no-user');
      return buildProgress({ goal: null, today: u.today, thisWeek: u.week, savers: u.saver_days, weeks: [], days: new Map(), all: [] });
    }
    const from = addDays(s.week, -7 * (weeksBack - 1));
    const { rows: weeks } = await c.query(
      `SELECT week_start::text AS start, goal, xp, met_at IS NOT NULL AS met, extra_days AS "extraDays", closed, reward IS NOT NULL AS spun
       FROM goal_weeks WHERE user_id = $1 AND week_start >= $2 ORDER BY week_start`, [uid, from]);
    const { rows: days } = await c.query(
      `SELECT day::text, sum(xp)::int AS xp, count(*)::int AS sets FROM (
         SELECT (created_at AT TIME ZONE $2)::date AS day, user_xp AS xp FROM workouts
           WHERE user_uid = $1 AND user_xp > 0 AND created_at >= ($3::date::timestamp AT TIME ZONE $2)
         UNION ALL
         SELECT (created_at AT TIME ZONE $2)::date, opponent_xp FROM workouts
           WHERE opponent_uid = $1 AND opponent_xp > 0 AND created_at >= ($3::date::timestamp AT TIME ZONE $2)
       ) t GROUP BY day`, [uid, s.tz, from]);
    const { rows: all } = await c.query(
      `SELECT week_start::text AS start, met_at IS NOT NULL AS met, closed, reward IS NOT NULL AS spun
       FROM goal_weeks WHERE user_id = $1 ORDER BY week_start DESC`, [uid]);
    return buildProgress({
      goal: s.goal, today: s.today, thisWeek: s.week, savers: s.savers, weeks, all,
      days: new Map(days.map((r) => [r.day, { xp: r.xp, sets: r.sets }])),
    });
  });
}

/**
 * Spin the reward wheel for the oldest met week that hasn't been spun, and pay out: saver days, BP, or an unowned
 * cosmetic (worn at once; +20 BP when everything is owned). 409 no-reward when nothing is owed.
 * Resolves { reward: { id, kind, days? | bp? | itemId? }, profile }.
 */
export async function spinWheel(uid, rng = Math.random) {
  const reward = await withTx(async (c) => {
    if (!(await settleWeeks(c, uid))) throw new HttpError(409, 'no-goal');
    const { rows: [w] } = await c.query(
      `SELECT week_start::text FROM goal_weeks WHERE user_id = $1 AND met_at IS NOT NULL AND reward IS NULL ORDER BY week_start LIMIT 1`, [uid]);
    if (!w) throw new HttpError(409, 'no-reward');
    const owned = (await c.query('SELECT item_id FROM user_items WHERE user_id = $1', [uid])).rows.map((r) => r.item_id);
    const unowned = Object.keys(COSMETICS).filter((id) => !owned.includes(id));
    let wedge = pickWedge(rng());
    if (wedge.kind === 'item' && !unowned.length) wedge = WHEEL.find((x) => x.id === 'bp20');
    const reward = { id: wedge.id, kind: wedge.kind, week: w.week_start };
    if (wedge.kind === 'saver') {
      reward.days = wedge.days;
      await c.query('UPDATE users SET saver_days = saver_days + $2 WHERE id = $1', [uid, wedge.days]);
    } else if (wedge.kind === 'bp') {
      reward.bp = wedge.bp;
      await award(c, uid, wedge.bp, 'wheel', w.week_start);
    } else {
      reward.itemId = unowned[Math.floor(rng() * unowned.length)];
      await c.query('INSERT INTO user_items (user_id, item_id) VALUES ($1, $2)', [uid, reward.itemId]);
      await c.query('UPDATE users SET equipped = equipped || jsonb_build_object($2::text, $3::text) WHERE id = $1',
        [uid, COSMETICS[reward.itemId].slot, reward.itemId]);
    }
    await c.query('UPDATE goal_weeks SET reward = $3 WHERE user_id = $1 AND week_start = $2', [uid, w.week_start, JSON.stringify(reward)]);
    return reward;
  });
  return { reward, profile: await getProfile(uid) };
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

/**
 * My latest sets, newest first, seen from my side of the row: { id, createdAt, mode, exercise, durationS, score, reps,
 * bp, forfeit, opponent: { name, score } | null, result: 'win' | 'loss' | 'draw' | null (solo) }.
 */
export async function recentWorkouts(uid, limit = 10) {
  const { rows } = await q(
    `SELECT id, created_at, mode, exercise, duration_s, forfeit, winner_uid,
       CASE WHEN user_uid = $1 THEN score          ELSE opponent_score    END AS my_score,
       CASE WHEN user_uid = $1 THEN reps           ELSE opponent_reps     END AS my_reps,
       CASE WHEN user_uid = $1 THEN avg_form       ELSE opponent_avg_form END AS my_avg,
       CASE WHEN user_uid = $1 THEN user_bp        ELSE opponent_bp       END AS my_bp,
       CASE WHEN user_uid = $1 THEN opponent_name  ELSE user_name         END AS their_name,
       CASE WHEN user_uid = $1 THEN opponent_score ELSE score             END AS their_score,
       EXISTS (SELECT 1 FROM workout_tracks t WHERE t.workout_id = w.id
               AND t.side = CASE WHEN w.user_uid = $1 THEN 'user' ELSE 'opponent' END) AS has_replay
     FROM workouts w WHERE user_uid = $1 OR opponent_uid = $1
     ORDER BY created_at DESC LIMIT $2`,
    [uid, limit],
  );
  return rows.map((r) => {
    const battle = r.mode === 'challenge';
    return {
      id: r.id, createdAt: r.created_at, mode: r.mode, exercise: r.exercise, durationS: r.duration_s,
      score: r.my_score, reps: r.my_reps, avgForm: r.my_avg, bp: r.my_bp ?? 0, forfeit: r.forfeit,
      opponent: battle ? { name: r.their_name, score: r.their_score } : null,
      result: resultFor(r, uid),
      hasReplay: r.has_replay,
    };
  });
}

const resultFor = (r, uid) =>
  r.mode !== 'challenge' ? null : r.winner_uid === null ? 'draw' : r.winner_uid === uid ? 'win' : 'loss';

/**
 * One workout, seen from my side: summary, both sides' reps (form scores + detail), the HP duel and my pose track.
 * 404 unless I took part. The opponent's pose track is never sent.
 */
export async function workoutDetail(uid, id) {
  const { rows } = await q('SELECT * FROM workouts WHERE id = $1 AND (user_uid = $2 OR opponent_uid = $2)', [id, uid]);
  const w = rows[0];
  if (!w) throw new HttpError(404, 'no-workout');
  const mine = w.user_uid === uid ? 'user' : 'opponent';
  const theirs = mine === 'user' ? 'opponent' : 'user';
  const sideOf = (s) => (s === 'user'
    ? { name: w.user_name, score: w.score, reps: w.reps, avgForm: w.avg_form, repScores: w.rep_scores ?? [], repDetail: w.rep_detail ?? [], bp: w.user_bp ?? 0 }
    : { name: w.opponent_name, score: w.opponent_score, reps: w.opponent_reps, avgForm: w.opponent_avg_form,
        repScores: w.opponent_rep_scores ?? [], repDetail: w.opponent_rep_detail ?? [], bp: w.opponent_bp ?? 0 });
  const track = (await q('SELECT fps, joints, aspect, mirrored, frames FROM workout_tracks WHERE workout_id = $1 AND side = $2', [id, mine])).rows[0];
  const bd = w.battle_detail;
  return {
    id: w.id, createdAt: w.created_at, mode: w.mode, exercise: w.exercise, durationS: w.duration_s, forfeit: w.forfeit,
    result: resultFor(w, uid),
    me: sideOf(mine),
    opponent: w.mode === 'challenge' ? sideOf(theirs) : null,
    battle: bd ? { hpMax: bd.hpMax, you: bd[mine], opponent: bd[theirs] } : null,
    track: track
      ? { v: 1, fps: track.fps, joints: track.joints, aspect: track.aspect, mirrored: track.mirrored, frames: track.frames.toString('base64') }
      : null,
  };
}

/**
 * My sets, oldest first (the latest `limit`), for trend charts: { id, createdAt, mode, exercise, durationS, score,
 * reps, avgForm, result }. exercise / durationS null = any.
 */
export async function workoutSeries(uid, exercise = null, durationS = null, limit = 30) {
  const { rows } = await q(
    `SELECT * FROM (
       SELECT id, created_at, mode, exercise, duration_s, winner_uid,
         CASE WHEN user_uid = $1 THEN score    ELSE opponent_score    END AS my_score,
         CASE WHEN user_uid = $1 THEN reps     ELSE opponent_reps     END AS my_reps,
         CASE WHEN user_uid = $1 THEN avg_form ELSE opponent_avg_form END AS my_avg
       FROM workouts
       WHERE (user_uid = $1 OR opponent_uid = $1) AND ($2::text IS NULL OR exercise = $2) AND ($3::int IS NULL OR duration_s = $3)
       ORDER BY created_at DESC LIMIT $4
     ) t ORDER BY created_at`,
    [uid, exercise, durationS, limit],
  );
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, mode: r.mode, exercise: r.exercise, durationS: r.duration_s,
    score: r.my_score, reps: r.my_reps, avgForm: r.my_avg, result: resultFor(r, uid),
  }));
}

/** How many workouts I have and the newest one's id (a recap stays valid while these don't change). */
export async function workoutStats(uid) {
  const { rows } = await q(
    `SELECT count(*)::int AS n, (array_agg(id ORDER BY created_at DESC))[1] AS latest
     FROM workouts WHERE user_uid = $1 OR opponent_uid = $1`,
    [uid],
  );
  return { count: rows[0].n, latestId: rows[0].latest ?? null };
}

// --- AI insight caches ----------------------------------------------------------

export async function getInsight(workoutId, uid) {
  const { rows } = await q('SELECT advice FROM workout_insights WHERE workout_id = $1 AND user_id = $2', [workoutId, uid]);
  return rows[0]?.advice ?? null;
}

export async function putInsight(workoutId, uid, advice, model) {
  await q(
    'INSERT INTO workout_insights (workout_id, user_id, advice, model) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [workoutId, uid, JSON.stringify(advice), model],
  );
}

/** { latestId, count, recap, createdAt } or null. */
export async function getRecap(uid) {
  const { rows } = await q('SELECT latest_workout_id, workout_count, recap, created_at FROM user_recaps WHERE user_id = $1', [uid]);
  const r = rows[0];
  return r ? { latestId: r.latest_workout_id, count: r.workout_count, recap: r.recap, createdAt: r.created_at } : null;
}

export async function putRecap(uid, { latestId, count }, recap, model) {
  await q(
    `INSERT INTO user_recaps (user_id, latest_workout_id, workout_count, recap, model) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET latest_workout_id = EXCLUDED.latest_workout_id, workout_count = EXCLUDED.workout_count,
       recap = EXCLUDED.recap, model = EXCLUDED.model, created_at = now()`,
    [uid, latestId, count, JSON.stringify(recap), model],
  );
}

/** Every stored set as (uid, score, reps, exercise, duration_s, created_at), from either side of a battle. */
const ALL_SETS = `
  SELECT user_uid AS uid, score, reps, exercise, duration_s, created_at FROM workouts WHERE user_uid IS NOT NULL
  UNION ALL
  SELECT opponent_uid, opponent_score, opponent_reps, exercise, duration_s, created_at FROM workouts
  WHERE opponent_uid IS NOT NULL AND opponent_score IS NOT NULL`;

/**
 * The best set for one exercise + length, among `uids` (null = everyone; `verifiedOnly` = only verified accounts).
 * { score, reps, username } or null.
 */
async function topSet(exercise, durationS, uids, verifiedOnly = false) {
  const { rows } = await q(
    `SELECT s.score, s.reps, u.username FROM (${ALL_SETS}) s JOIN users u ON u.id = s.uid
     WHERE s.exercise = $1 AND s.duration_s = $2 AND ($3::uuid[] IS NULL OR s.uid = ANY($3::uuid[]))
       AND (NOT $4::boolean OR u.verified_at IS NOT NULL)
     ORDER BY s.score DESC, s.reps DESC, s.created_at LIMIT 1`,
    [exercise, durationS, uids, verifiedOnly],
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
    topSet(exercise, durationS, null, personaConfigured()), // the global best only counts verified accounts
    friendIds(uid).then((ids) => (ids.length ? topSet(exercise, durationS, ids) : null)),
    opponentUsername ? opponentId().then((id) => (id ? topSet(exercise, durationS, [id]) : null)) : null,
  ]);
  const personal = mine.bestScore === null ? null : { score: mine.bestScore, reps: mine.bestReps };
  return { personal, global, friends, opponent };
}

/**
 * The global leaderboard: everyone verified with a username, ranked by their best single set (any exercise or length).
 * People with no sets are included and share the last rank. Resolves { entries (top `limit`), me }, where me is
 * { rank, bestScore, verified: true }, or { rank: null, bestScore: null, verified: false } for an unverified viewer.
 */
export async function globalLeaderboard(uid, limit = 100) {
  const verifiedOnly = personaConfigured();
  const { rows } = await q(
    `WITH best AS (
       SELECT DISTINCT ON (uid) uid, score, reps, exercise, duration_s FROM (${ALL_SETS}) s
       ORDER BY uid, score DESC, created_at
     ), ranked AS (
       SELECT u.id, b.score, b.reps, b.exercise, b.duration_s,
         rank() OVER (ORDER BY b.score DESC NULLS LAST) AS rank,
         row_number() OVER (ORDER BY b.score DESC NULLS LAST, lower(u.username)) AS pos
       FROM users u LEFT JOIN best b ON b.uid = u.id
       WHERE u.username IS NOT NULL AND (NOT $3::boolean OR u.verified_at IS NOT NULL)
     )
     SELECT * FROM ranked WHERE pos <= $2 OR id = $1 ORDER BY pos`,
    [uid, limit, verifiedOnly],
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
  if (mine) return { entries, me: { rank: Number(mine.rank), bestScore: mine.score, verified: true } };
  const unverified = verifiedOnly && !(await q('SELECT 1 FROM users WHERE id = $1 AND verified_at IS NOT NULL', [uid])).rowCount;
  return { entries, me: unverified ? { rank: null, bestScore: null, verified: false } : null };
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
 * Store a solo set (with its rep detail and pose track, when valid) and pay its BP (when `earn`).
 * Resolves { stored, bpAwarded, bp, workoutId }. Without a database the set is only logged.
 */
export async function recordSolo({ uid, secret, name, exercise, durationS, scores, score, avgForm, earn, detail = null, track = null }) {
  const bpAwarded = uid && earn ? soloBp(score) : 0;
  const xpAwarded = uid && earn ? xpForScores(scores) : 0;
  if (!pool) {
    console.log(`[db] skipped solo ${exercise} ${durationS}s score=${score} reps=${scores.length}`);
    return { stored: false, bpAwarded: 0, bp: null, workoutId: null, xpAwarded: 0, goalMet: false };
  }
  return withTx(async (c) => {
    const row = {
      mode: 'solo', exercise, duration_s: durationS, user_id: secret, user_name: name, score, reps: scores.length,
      avg_form: avgForm, rep_scores: scores, forfeit: false, user_uid: uid, user_bp: bpAwarded, rep_detail: detail, user_xp: xpAwarded,
    };
    const { rows } = await c.query(INSERT, insertParams(row));
    const workoutId = rows[0].id;
    await insertTracks(c, workoutId, [track && { ...track, side: 'user' }]);
    let bp = null;
    if (uid && bpAwarded > 0) bp = await award(c, uid, bpAwarded, 'solo', workoutId);
    const goalMet = uid ? (await addWeekXp(c, uid, xpAwarded)).length > 0 : false;
    return { stored: true, bpAwarded, bp, workoutId, xpAwarded, goalMet };
  });
}

/**
 * Store a finished battle (one row, `row.id` chosen by the caller) and pay both sides their BP and weekly XP.
 * `sides` = [{ uid, bpAwarded, xpAwarded }] for the user and opponent; `tracks` = [userTrack, opponentTrack] (either
 * may be null). Resolves true when stored.
 */
export async function recordChallenge(row, sides, tracks = []) {
  if (!pool) {
    console.log(`[db] skipped challenge ${row.exercise} ${row.duration_s}s ${row.score}-${row.opponent_score}`);
    return false;
  }
  await withTx(async (c) => {
    const { rows } = await c.query(INSERT, insertParams(row));
    const [user, opponent] = tracks;
    await insertTracks(c, rows[0].id, [user && { ...user, side: 'user' }, opponent && { ...opponent, side: 'opponent' }]);
    for (const s of sides) {
      if (!s.uid) continue;
      if (s.bpAwarded > 0) await award(c, s.uid, s.bpAwarded, 'battle', row.challenge_id);
      await addWeekXp(c, s.uid, s.xpAwarded ?? 0);
    }
  });
  return true;
}

export { battleBp };

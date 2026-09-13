// Workout history in Postgres (Tiger Cloud). DATABASE_URL comes from the environment and is never logged.
// Without it (local dev) writes are skipped, so the relay still runs.
import pg from 'pg';

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
`;

const COLUMNS = [
  'mode', 'exercise', 'duration_s', 'user_id', 'user_name', 'score', 'reps', 'avg_form', 'rep_scores',
  'challenge_id', 'opponent_id', 'opponent_name', 'opponent_score', 'opponent_reps', 'winner_id', 'forfeit',
];
const INSERT = `INSERT INTO workouts (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`;

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
  ? new pg.Pool({ connectionString: pgUrl(process.env.DATABASE_URL), max: 3, idleTimeoutMillis: 30_000 })
  : null;
pool?.on('error', (e) => console.error('[db] idle client error:', e.message));

let ready = null;
function ensureTable() {
  ready ??= pool.query(DDL).then(
    () => console.log('[db] workouts table ready'),
    (e) => { ready = null; throw e; }, // retry on the next write
  );
  return ready;
}

export function initDb() {
  if (!pool) {
    console.log('[db] DATABASE_URL not set; workouts will not be stored');
    return Promise.resolve();
  }
  return ensureTable();
}

/** Insert one workouts row. Resolves true when stored, false when there is no database. */
export async function saveWorkout(row) {
  if (!pool) {
    console.log(`[db] skipped ${row.mode} ${row.exercise} ${row.duration_s}s score=${row.score} reps=${row.reps}`);
    return false;
  }
  await ensureTable();
  await pool.query(INSERT, COLUMNS.map((c) => row[c] ?? null));
  return true;
}

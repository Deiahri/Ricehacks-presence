# Presence server (live map + battles)

A small WebSocket server for [Ricehacks-mybuild](../Ricehacks-mybuild). It has two jobs:
- **Presence:** each client sends its GPS position and compass heading, and the server broadcasts a snapshot of every connected player to all clients.
- **Battle referee:** it runs 1v1 challenges. It relays requests, resolves split votes with a coin flip, starts both phones' countdowns together, relays live scores, and decides the winner. It stores each finished set, battle or solo, in Postgres.

Live state is kept in memory only, so restarting the server empties the world and ends any running battle. Stored workouts survive restarts. It's a spike, not production code.

## Run locally

```sh
npm install
npm start               # ws://localhost:8787  (PORT env var overrides)
curl localhost:8787/health   # "ok <player count>"
```

The frontend's dev server (`npm run dev` in Ricehacks-mybuild) connects to `ws://<page host>:8787` automatically when `VITE_PRESENCE_URL` isn't set.

## Workout storage (Tiger Cloud / Postgres)

Set `DATABASE_URL` in the server's environment. To run locally, copy `.env.example` to `.env`, fill it in, and start the server with `node --env-file=.env server.mjs`. `.env` is git-ignored. On Render, add it under the Web Service's **Environment** settings. On boot the server creates the `workouts` table if it doesn't exist (see `db.mjs`). Without `DATABASE_URL` the server still runs: it logs `[db] skipped …`, and solo players see "not saved". The URL is never logged.

| Column | Meaning |
|---|---|
| `mode` | `solo` or `challenge` |
| `exercise`, `duration_s` | `squat` / `pushup`; `30` / `60` / `120` / `300` |
| `user_id`, `user_name`, `score`, `reps`, `avg_form`, `rep_scores` | The player (for a battle, the challenger). `score` = round(Σ `rep_scores` ÷ 10) |
| `challenge_id`, `opponent_*` | Battle only: the challenged player's side, in the same row. Null for solo |
| `winner_id` | The winner's `user_id`, or null on a draw or solo |
| `forfeit` | The loser left mid-set |

`user_id` is the random id each device keeps in localStorage. There are no accounts.

```sql
SELECT created_at, mode, exercise, duration_s, user_name, score, opponent_name, opponent_score, winner_id
FROM workouts ORDER BY created_at DESC LIMIT 20;
```

## Fake player

To see someone else move when you only have one phone, run a bot that walks a ~40 m circle around a point:

```sh
node fake-walker.mjs <lat> <lng> [ws-url] [name]
node fake-walker.mjs 29.7174 -95.4018 wss://your-service.onrender.com
```

## Deploy (Render Web Service)

Render deploys from git, so push this folder to a repo first, either its own repo or as a subfolder of an existing one.

- New → **Web Service**, pick the repo.
- **Root directory:** this folder, if it's a subfolder.
- **Runtime:** Node. **Build:** `npm install`. **Start:** `npm start`.
- **Health check path:** `/health`.

Render sets `PORT` itself and terminates TLS, so the public URL is `wss://<service>.onrender.com`. Put that URL in the frontend host's environment as `VITE_PRESENCE_URL`, then redeploy the frontend, because Vite bakes it in at build time.

On the free tier the service sleeps after about 15 minutes without traffic. The first connection after that takes 30–60 s while it wakes, and the client keeps retrying until it gets through.

## Protocol

| Direction | Message |
|---|---|
| client → server | `{"type":"hello","id","userId","name","shirt"}` once per connection. `id` is per tab; `userId` is stable per device |
| client → server | `{"type":"pos","lat","lng","heading"(deg or null),"acc"}`, at most 4×/s, and every 20 s while still |
| client → server | `{"type":"status","busy"}`: in a solo workout, so challenges are refused |
| server → client | `{"type":"you","id"}` after hello |
| server → client | `{"type":"players","players":[{id,name,shirt,lat,lng,heading,acc,ts,busy}]}`, up to 5×/s, only when something changed |

Players disappear from the map after 60 s without a position, and are removed when their socket closes. A ping every 25 s drops dead sockets.

### Battles

Every battle message after the request carries `challengeId`. The server ignores messages that arrive from the wrong player, in the wrong phase, or with values outside the allowed sets.

| Step | client → server | server → client |
|---|---|---|
| Request | `challenge_request {to}` (a player's `id`) | challenger: `challenge_outgoing {challengeId, opponent}`; target: `challenge_incoming {challengeId, from}` |
| Answer (30 s) | `challenge_respond {accept}` · `challenge_cancel` | both: `challenge_accepted {opponent}` or `challenge_update {status}` |
| Vote (90 s) | `challenge_pick {exercise, durationS}` | both, once both voted: `challenge_resolved {exercise, durationS, picks, coinFlips}` |
| Cameras (60 s) | `challenge_ready` when the pose model is running | both, once both ready: `challenge_go {countdownMs: 10000, durationS}` |
| Set | `challenge_rep {reps, score, quality}` per rep | opponent: `challenge_opp {reps, score, quality}` |
| End | `challenge_final {repScores}` | both: `challenge_result {you, opponent, winnerId, forfeit}`, then one row stored |
| Solo | `solo_result {exercise, durationS, repScores}` | `saved {ok, reason?}` (`reason`: `no-db` or `error`) |

- `challenge_update.status` is one of `declined`, `cancelled`, `timeout`, `busy`, `offline` or `left`.
- The final score is recomputed on the server from `repScores`. Live values are clamped to what's plausible for the duration.
- If a player's socket closes, or they send `challenge_cancel` mid-set before their final, they forfeit. The result then uses their last live score.
- If a final never arrives, the server settles 15 s after the set ends.

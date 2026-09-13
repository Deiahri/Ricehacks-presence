# Presence server (live map, battles, accounts)

A small server for [Ricehacks-mybuild](../Ricehacks-mybuild). It has four jobs:
- **Presence:** each client sends its GPS position and compass heading, and the server broadcasts a snapshot of every connected player (name, shirt, gear) to all clients.
- **Battle referee:** it runs 1v1 challenges. It relays requests, resolves split votes with a coin flip, starts both phones' countdowns together, relays live scores, and decides the winner. It stores each finished set, battle or solo, in Postgres.
- **Accounts:** usernames, friends, battle points (BP) and the cosmetics shop, behind a small JSON API on the same port.
- **Voice coach tokens:** it mints one-session ElevenLabs tokens, so the API key never reaches the app.

Live state is kept in memory only, so restarting the server empties the world and ends any running battle. Accounts and workouts survive restarts. It's a spike, not production code.

Game rules live in `game-config.mjs`: set lengths, BP rewards, starting BP, username rules and cosmetic prices.

## Run locally

```sh
npm install
npm start               # ws://localhost:8787  (PORT env var overrides)
curl localhost:8787/health   # "ok <player count>"
```

The frontend's dev server (`npm run dev` in Ricehacks-mybuild) connects to `ws://<page host>:8787` automatically when `VITE_PRESENCE_URL` isn't set.

## Storage (Tiger Cloud / Postgres)

Set `DATABASE_URL` in the server's environment. To run locally, copy `.env.example` to `.env`, fill it in, and start the server with `node --env-file=.env server.mjs`. `.env` is git-ignored. On Render, add it under the Web Service's **Environment** settings. On boot the server creates any missing tables and columns (see `db.mjs`). Without `DATABASE_URL` the server still runs: it logs `[db] skipped …`, solo players see "not saved", and `/api/*` answers 503. The URL is never logged.

| Table | What's in it |
|---|---|
| `users` | One row per device: `device_secret` (the random id the app keeps in localStorage, never broadcast), the unique case-insensitive `username`, `bp`, and `equipped` (`{slot: itemId}`). `id` is the key everything else points at, so a future sign-in provider can map onto the same row |
| `friend_requests`, `friendships` | Pending requests (from → to) and accepted pairs |
| `user_items` | Owned cosmetics |
| `bp_ledger` | Every BP change (`solo`, `battle`, `purchase`). Unique per (user, reason, ref), so an award can't be paid twice |
| `workouts` | One row per finished set, below |

| `workouts` column | Meaning |
|---|---|
| `mode` | `solo` or `challenge` |
| `exercise`, `duration_s` | `squat` / `pushup`; `15` / `30` / `60` / `120` / `300` |
| `user_uid`, `user_name`, `score`, `reps`, `avg_form`, `rep_scores`, `user_bp` | The player (for a battle, the challenger) and the BP they earned. `score` = round(Σ `rep_scores` ÷ 10) |
| `challenge_id`, `opponent_*` | Battle only: the challenged player's side, in the same row. Null for solo |
| `winner_uid` | The winner's account, or null on a draw or solo |
| `forfeit` | The loser left mid-set |
| `user_id`, `opponent_id`, `winner_id` | The device secrets, kept from before accounts existed. A device's old rows are attached to its account when the account is created |

**BP:** a solo set earns its score, but only once per workout and only if the set's full length has passed since the workout began. A battle earns your score plus 50 for a win, 20 for a draw or 0 for a loss. Leaving mid-set earns 0.

```sql
SELECT created_at, mode, exercise, duration_s, user_name, score, user_bp, opponent_name, opponent_score, opponent_bp
FROM workouts ORDER BY created_at DESC LIMIT 20;
```

To check a change end to end, run the server against a throwaway database and `npm run smoke`, which drives two fake players through usernames, friends, BP, the shop and two battles. It creates users and never deletes them, so don't point it at production.

## Voice coach (ElevenLabs)

1. Put `ELEVENLABS_API_KEY` in `.env`.
2. Run `npm run coach:agent` once. It creates an agent named "Ricehacks workout coach" that lets the app override its prompt, first line and voice. It prints the agent id; running it again updates the same agent.
3. Set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` in `.env` and on Render.

The coach's personality and when it speaks up are set in the app's `src/config/coach.ts`, not here.

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
| server → client | `{"type":"profile","profile":{username,shirt,bp,level,wins,losses,equipped,owned}}` after hello, and whenever BP, gear or the username changes |
| server → client | `{"type":"friend_request"}` / `{"type":"friend_update"}`: refetch `/api/friends` |
| server → client | `{"type":"players","players":[{id,name,username,shirt,equipped,lat,lng,heading,acc,ts,busy}]}`, up to 5×/s, only when something changed |

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
| End | `challenge_final {repScores}` | both: `challenge_result {you, opponent, winnerId, forfeit}` (each side has `bpAwarded`), then one row stored |
| Solo | `solo_result {exercise, durationS, repScores}` | `saved {ok, reason?, bpAwarded, bp}` (`reason`: `no-db` or `error`) |

- `challenge_update.status` is one of `declined`, `cancelled`, `timeout`, `busy`, `offline` or `left`.
- The final score is recomputed on the server from `repScores`. Live values are clamped to what's plausible for the duration.
- If a player's socket closes, or they send `challenge_cancel` mid-set before their final, they forfeit. The result then uses their last live score.
- If a final never arrives, the server settles 15 s after the set ends.

## JSON API

Every route takes `Authorization: Bearer <device secret>` (the app's `presence.userId`); the account is created on first use. Errors come back as `{"error": "<reason>"}`. CORS is open unless `ALLOWED_ORIGINS` lists specific origins.

| Route | Does |
|---|---|
| `GET /api/me` | `{username, shirt, bp, level, wins, losses, equipped, owned}` |
| `POST /api/username {username}` | Claim or rename: 3–16 letters, digits or `_`. 409 `taken` |
| `GET /api/friends` | `{friends, incoming, outgoing}`; friends also have `online`, `busy` and `presenceId` (the id to send `challenge_request` to) |
| `POST /api/friends/requests {username}` | `{status: "sent"}`, or `"accepted"` if they had already asked you. 404 `not-found`, 409 `already-friends`, 400 `self` / `no-username` |
| `POST /api/friends/respond {username, accept}` | Accept or decline their request |
| `GET /api/shop` | `[{id, slot, cost}]` |
| `POST /api/shop/buy {itemId}` | Spend BP; the item is equipped. 402 `insufficient-bp`, 409 `owned` |
| `POST /api/equip {slot, itemId}` | Wear an owned item, or `itemId: null` to empty the slot. 403 `not-owned`, 400 `wrong-slot` |
| `GET /api/pr?exercise=&durationS=` | `{bestScore, bestReps}` for that exercise and set length (the coach's "old record") |
| `GET /api/coach/token` | `{token}` for one ElevenLabs WebRTC session. 503 when the coach isn't configured, 429 past 20 an hour |

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
| `users` | One row per account: `auth_sub` (the Clerk user id) or, without Clerk, `device_secret` (the random id the app keeps in localStorage, never broadcast). Also the unique case-insensitive `username`, `shirt`, `skin` (tone id), `bp`, `equipped` (`{slot: itemId}`), the `weekly_goal` in XP with the `tz` it's counted in and `goal_since`, and banked `saver_days`. `id` is the key everything else points at |
| `goal_weeks` | One row per week (Monday `week_start`, in the user's zone) since the goal was set: the `goal` at the time, `xp` so far, `met_at`, `extra_days` a streak saver kept it open past Sunday, `closed` once missed for good, and the wheel `reward` once spun |
| `friend_requests`, `friendships` | Pending requests (from → to) and accepted pairs |
| `notifications` | What became of a request you sent (`friend_accepted` / `friend_declined`, with the `actor`), and when you read it |
| `user_items` | Owned cosmetics |
| `bp_ledger` | Every BP change (`solo`, `battle`, `purchase`, `wheel`). Unique per (user, reason, ref), so an award can't be paid twice |
| `workouts` | One row per finished set, below |

| `workouts` column | Meaning |
|---|---|
| `mode` | `solo` or `challenge` |
| `exercise`, `duration_s` | `squat` / `pushup` / `pullup`; `15` / `30` / `60` / `120` / `300` |
| `user_uid`, `user_name`, `score`, `reps`, `avg_form`, `rep_scores`, `user_bp`, `user_xp` | The player (for a battle, the challenger) and the BP and weekly XP they earned. `score` = round(Σ `rep_scores` ÷ 10) |
| `challenge_id`, `opponent_*` | Battle only: the challenged player's side, in the same row. Null for solo |
| `winner_uid` | The winner's account, or null on a draw or solo |
| `forfeit` | The loser left mid-set |
| `user_id`, `opponent_id`, `winner_id` | The device secrets, kept from before accounts existed. A device's old rows are attached to its account when the account is created |

**BP:** a solo set earns its score, but only once per workout and only if the set's full length has passed since the workout began. A battle earns your score plus 50 for a win, 20 for a draw or 0 for a loss. Leaving mid-set earns 0.

**XP and the weekly goal:** every rep of a set that earned BP is 1 XP, and a rep at 80+ form ("perfect") is 2. Each account sets one goal: the XP to reach between Monday and Sunday in its own zone, however it's spread over the week. Reaching it is a level-up (`level` = 1 + weeks met), the star on the map turns gold and a spin of the reward wheel is owed (`POST /api/reward/spin`): a 1- or 2-day streak saver, +10/+20/+50 BP, or an unowned cosmetic. A saver day keeps an unfinished week open one more day past Sunday (spent as the days pass, whether or not the app is opened); a set on such a day counts for both that week and the new one. Rules and wheel weights live in `game-config.mjs`; the week bookkeeping in `progress.mjs`.

```sql
SELECT created_at, mode, exercise, duration_s, user_name, score, user_bp, opponent_name, opponent_score, opponent_bp
FROM workouts ORDER BY created_at DESC LIMIT 20;
```

To check a change end to end, run the server against a throwaway database, without `CLERK_SECRET_KEY`, and run `npm run smoke`. It drives three fake players through:
- usernames, friends, and the accept/decline notifications
- looks, BP and the shop
- the weekly XP goal, level-up and reward wheel
- two battles
- the leaderboard and score targets

It creates users and never deletes them, so don't point it at production.

## Sign-in (Clerk)

Set `CLERK_SECRET_KEY` (and optionally `CLERK_AUTHORIZED_PARTIES`, the app's origins) to require Google sign-in. With it set:
- every `/api` call must send `Authorization: Bearer <Clerk session token>`
- every socket hello must carry that token as `token`
- the account is the `users` row whose `auth_sub` is the token's user id, created on first sign-in

A missing, bad or expired token gets 401 `bad-token`; a hello without a valid token still shows on the map, but has no account. Without the key (local dev, the smoke test, `fake-walker`), the device secret is the credential, as before. The frontend README covers setting up the Clerk app.

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
| client → server | `{"type":"hello","id","userId","name","shirt","token"?}` once per connection. `id` is per tab; `userId` is stable per device; `token` is the Clerk session token (required for an account when Clerk is on) |
| client → server | `{"type":"pos","lat","lng","heading"(deg or null),"acc"}`, at most 4×/s, and every 20 s while still |
| client → server | `{"type":"status","busy"}`: in a solo workout, so challenges are refused |
| server → client | `{"type":"you","id"}` after hello |
| server → client | `{"type":"profile","profile":{username,shirt,skin,bp,level,wins,losses,equipped,owned}}` after hello, and whenever BP, looks, gear or the username changes |
| server → client | `{"type":"friend_request"}` / `{"type":"friend_update"}`: refetch `/api/friends` |
| server → client | `{"type":"notification","notification":{id,type,createdAt,read,actor}}`: someone accepted or declined your friend request (also in `/api/notifications`) |
| server → client | `{"type":"players","players":[{id,name,username,shirt,skin,equipped,lat,lng,heading,acc,ts,busy}]}`, up to 5×/s, only when something changed |

Players disappear from the map after 60 s without a position, and are removed when their socket closes. A ping every 25 s drops dead sockets.

### Battles

Every battle message after the request carries `challengeId`. The server ignores messages that arrive from the wrong player, in the wrong phase, or with values outside the allowed sets.

| Step | client → server | server → client |
|---|---|---|
| Request | `challenge_request {to}` (a player's `id`) | challenger: `challenge_outgoing {challengeId, opponent}`; target: `challenge_incoming {challengeId, from}` |
| Answer (30 s) | `challenge_respond {accept}` · `challenge_cancel` | both: `challenge_accepted {opponent}` or `challenge_update {status}` |
| Vote (90 s) | `challenge_pick {exercise, durationS}` | both, once both voted: `challenge_resolved {exercise, durationS, picks, coinFlips}` |
| Cameras (60 s) | `challenge_ready` when the pose model is running | both, once both ready: `challenge_go {countdownMs: 10000, durationS, hpMax, loadouts}` (`loadouts` = each player's battle items, keyed by `id`) |
| Set | `challenge_rep {reps, score, quality, formScore}` per rep | opponent: `challenge_opp {reps, score, quality}`; both: `challenge_hp {hpMax, you, opponent, event}` |
| End | `challenge_final {repScores, repDetail?, track?}` | both: `challenge_result {you, opponent, winnerId, forfeit, battle, workoutId}` (each side has `bpAwarded` and `xpAwarded`), then one row stored |
| Solo | `solo_result {exercise, durationS, repScores, repDetail?, track?}` | `saved {ok, reason?, bpAwarded, bp, workoutId, xpAwarded, goalMet}` (`reason`: `no-db` or `error`) |

- `challenge_update.status` is one of `declined`, `cancelled`, `timeout`, `busy`, `offline` or `left`.
- The final score is recomputed on the server from `repScores`. Live values are clamped to what's plausible for the duration.
- If a player's socket closes, or they send `challenge_cancel` mid-set before their final, they forfeit. The result then uses their last live score.
- If a final never arrives, the server settles 15 s after the set ends.
- `repDetail` is one `{t, d, sub, c}` per rep (seconds into the set, rep seconds, sub-scores, cues). `track` is the pose recording, `{v: 1, fps: 5|10, joints: 13, aspect, mirrored, frames: base64}` (see the app's `src/game/poseTrack.ts`). Both are optional, and malformed ones are dropped without losing the set. Messages can be up to 256 KB; anything bigger closes the socket.

### The HP duel and battle items

Each fighter starts with 5 HP per second of set length (75 for 15 s). Every rep hits the other player for its points (form ÷ 10), and the player who deals more damage wins; ties go to points, then reps. HP bars stop at 0 (K.O.), but the set keeps going. Only **equipped** items count, as worn when the set starts. The numbers are in `game-config.mjs` (`ITEM_EFFECTS`), and the maths is in `battle-effects.mjs`, which has its own tests (`npm test`):

| Item | Effect |
|---|---|
| Low tier shield | Blocks 30% of every hit you take |
| Iron gauntlet | Your hits deal 1.5× |
| Warlock hat | Each of your opponent's red reps (form < 50) has a 20% chance to deal −1 instead, which heals you |
| Magic wand | 5 reps in a row at 90+ form pays +50 BP at the end of the battle, once |

Wand and gauntlet share the main-hand slot, so a player picks one. Items only decide who wins: BP is still score + the outcome bonus (plus the wand surge). Curse rolls come from a per-battle secret seed, so the live HP bars and the final result always agree.

`challenge_hp` and `challenge_result.battle` show the duel from your side: `{hpMax, you, opponent}`. Each side has `{dealt, taken, hp, absorbed, gauntletBonus, cursedReps, cursesCast, cursesSuffered, streak, bestStreak, surge, rawScore, reps, loadout}`. `challenge_hp.event` is null, `{kind: "curse", by: "you" | "opponent"}` or `{kind: "surge", who}`.

## AI coaching (Gemini)

Set `GEMINI_API_KEY` (Google AI Studio) to have Gemini write the replay screen's advice and the Progress recap. `GEMINI_MODEL` is optional; the default is `gemini-2.5-flash`. The server computes the stats itself (per-rep form, fade across the set, cues, PRs, sets per week) and Gemini only writes the words. No names or ids are sent.
- Advice is cached per workout and viewer.
- The recap is cached until you record a new workout, or for 3 days at most.
- Each user can trigger 30 generations an hour.

Without a key, or when Gemini fails, both return rule-based text with `source: "fallback"`. That text isn't cached, so real advice replaces it once a key is set.

## JSON API

Every route takes `Authorization: Bearer <credential>`: a Clerk session token, or without Clerk the device secret (the app's `presence.userId`). The account is created on first use. Errors come back as `{"error": "<reason>"}`. CORS is open unless `ALLOWED_ORIGINS` lists specific origins.

| Route | Does |
|---|---|
| `GET /api/me` | `{username, shirt, skin, bp, level, wins, losses, equipped, owned, verified, weeklyGoal, weekXp, weekMet, saverDays, pendingReward, extension}`. `weeklyGoal` is null until set; `extension` is `{weekStart, xp, goal, daysLeft}` while a saver day keeps last week open, else null |
| `POST /api/goal {goal, tz?}` | Set the weekly XP goal (10–1000) and the IANA zone the week is counted in. 400 `bad-goal` / `bad-tz` |
| `GET /api/progress?weeks=` | The last `weeks` weeks (default 12): `{goal, today, thisWeek, streak, saverDays, level, pendingReward, weeks: [{start, goal, xp, status, extraDays, current, days: [{date, xp, sets}]}]}`. `status` is `open`, `met` or `missed` |
| `POST /api/reward/spin` | Spin the wheel owed for a met week: `{reward: {kind: "saver" \| "bp" \| "item", days? \| bp? \| itemId?}, profile}`. 409 `no-reward` |
| `POST /api/username {username}` | Claim or rename: 3–16 letters, digits or `_`. 409 `taken` |
| `POST /api/appearance {skin?, shirt?}` | Free look change: `skin` is a tone id `s1`–`s8`, `shirt` a `#rrggbb` colour. 400 `bad-skin` / `bad-shirt` |
| `GET /api/notifications` | `{items: [{id, type, createdAt, read, actor}], unread}`, the latest 30 |
| `POST /api/notifications/read` | Mark them all read |
| `GET /api/leaderboard` | `{entries, me}`: everyone with a username, ranked by their best single-set score (any exercise or length; people with no sets share the last rank). Top 100, plus your own `{rank, bestScore}` |
| `GET /api/targets?exercise=&durationS=&opponent=` | Scores to beat for that set, for the coach: `{personal, global, friends, opponent}`, each `{score, reps, username?}` or null |
| `GET /api/friends` | `{friends, incoming, outgoing}`; friends also have `online`, `busy` and `presenceId` (the id to send `challenge_request` to) |
| `POST /api/friends/requests {username}` | `{status: "sent"}`, or `"accepted"` if they had already asked you. 404 `not-found`, 409 `already-friends`, 400 `self` / `no-username` |
| `POST /api/friends/respond {username, accept}` | Accept or decline their request |
| `GET /api/shop` | `[{id, slot, cost}]` |
| `POST /api/shop/buy {itemId}` | Spend BP; the item is equipped. 402 `insufficient-bp`, 409 `owned` |
| `POST /api/equip {slot, itemId}` | Wear an owned item, or `itemId: null` to empty the slot. 403 `not-owned`, 400 `wrong-slot` |
| `GET /api/pr?exercise=&durationS=` | `{bestScore, bestReps}` for that exercise and set length (the coach's "old record") |
| `GET /api/workouts` | My last 10 sets, newest first: `{id, createdAt, mode, exercise, durationS, score, reps, avgForm, bp, forfeit, opponent, result, hasReplay}` |
| `GET /api/workout?id=` | One of my sets for the replay screen: `{…, me, opponent, battle, track}`. Each side is `{name, score, reps, avgForm, repScores, repDetail, bp}`; `track` is only your own. 404 `no-workout`, 400 `bad-id` |
| `GET /api/workout/advice?id=` | `{headline, summary, tips, focusCue, source}` from Gemini (cached), or the fallback text |
| `GET /api/workouts/series?exercise=&durationS=` | My last 30 sets of that kind (or all of them, with no query), oldest first: `{id, createdAt, mode, exercise, durationS, score, reps, avgForm, result}` |
| `GET /api/recap` | `{headline, text, trend, source, count}`: how I've been doing lately. `trend` is `improving`, `steady`, `slipping`, `slacking` or `new`; `source` is `none` when I have no workouts |
| `GET /api/coach/token` | `{token}` for one ElevenLabs WebRTC session. 503 when the coach isn't configured, 429 past 20 an hour |

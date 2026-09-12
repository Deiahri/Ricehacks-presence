# Presence server (live map)

A tiny WebSocket relay for the Map tab of [Ricehacks-mybuild](../Ricehacks-mybuild). Each client sends its GPS position and compass heading, and the server broadcasts a snapshot of every connected player to all clients. State is kept in memory only, so restarting the server empties the world. It's a spike, not production code.

## Run locally

```sh
npm install
npm start               # ws://localhost:8787  (PORT env var overrides)
curl localhost:8787/health   # "ok <player count>"
```

The frontend's dev server (`npm run dev` in Ricehacks-mybuild) connects to `ws://<page host>:8787` automatically when `VITE_PRESENCE_URL` isn't set.

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
| client → server | `{"type":"hello","id","name","shirt"}` once per connection |
| client → server | `{"type":"pos","lat","lng","heading"(deg or null),"acc"}`, at most 4×/s, and every 20 s while still |
| server → client | `{"type":"you","id"}` after hello |
| server → client | `{"type":"players","players":[{id,name,shirt,lat,lng,heading,acc,ts}]}`, up to 5×/s, only when something changed |

Players are removed when their socket closes or after 60 s without an update. A ping every 25 s drops dead sockets.

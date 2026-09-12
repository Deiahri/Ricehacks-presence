// Presence relay: every client says hello, streams its position, and receives a snapshot of everyone.
// State is in memory only — restart = empty world. Good enough for a spike.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const BROADCAST_MS = 200; // snapshot at most 5×/s, only when something changed
const STALE_MS = 60_000; // drop players that stop sending
const HEARTBEAT_MS = 25_000; // ping to detect dead sockets + keep proxies from idling us out

/** @type {Map<import('ws').WebSocket, {id:string,name:string,shirt:string,lat:number|null,lng:number|null,heading:number|null,acc:number|null,ts:number}>} */
const players = new Map();
let dirty = false;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${players.size}\n`);
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const HEX = /^#[0-9a-f]{6}$/i;

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
      const prev = players.get(ws);
      players.set(ws, {
        id: msg.id,
        name: name || 'Player',
        shirt: typeof msg.shirt === 'string' && HEX.test(msg.shirt) ? msg.shirt : '#7fb0e0',
        lat: prev?.lat ?? null, lng: prev?.lng ?? null, heading: prev?.heading ?? null, acc: prev?.acc ?? null,
        ts: Date.now(),
      });
      ws.send(JSON.stringify({ type: 'you', id: msg.id }));
      dirty = true;
      return;
    }

    if (msg.type === 'pos') {
      const p = players.get(ws);
      if (!p) return; // must hello first
      const { lat, lng, heading, acc } = msg;
      if (!isNum(lat) || !isNum(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      p.lat = lat;
      p.lng = lng;
      p.heading = isNum(heading) ? ((heading % 360) + 360) % 360 : null;
      p.acc = isNum(acc) && acc >= 0 ? Math.min(acc, 100_000) : null;
      p.ts = Date.now();
      dirty = true;
    }
  });

  ws.on('close', () => {
    if (players.delete(ws)) dirty = true;
  });
});

// Snapshot broadcast (only players that have a position yet).
setInterval(() => {
  const now = Date.now();
  for (const [ws, p] of players) {
    if (now - p.ts > STALE_MS) { players.delete(ws); dirty = true; }
  }
  if (!dirty) return;
  dirty = false;
  const list = [...players.values()].filter((p) => p.lat !== null);
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

server.listen(PORT, () => console.log(`presence server on :${PORT}`));

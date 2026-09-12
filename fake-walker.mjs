// Bot player that walks a ~40 m circle around a point, so a single phone can see someone else move.
// Usage: node fake-walker.mjs <lat> <lng> [ws-url] [name]
//   node fake-walker.mjs 29.7174 -95.4018 ws://localhost:8787
//   node fake-walker.mjs 29.7174 -95.4018 wss://your-service.onrender.com "Walker Bot"
import { WebSocket } from 'ws';

const [latArg, lngArg, url = 'ws://localhost:8787', name = 'Walker Bot'] = process.argv.slice(2);
const lat0 = Number(latArg);
const lng0 = Number(lngArg);
if (!Number.isFinite(lat0) || !Number.isFinite(lng0)) {
  console.error('usage: node fake-walker.mjs <lat> <lng> [ws-url] [name]');
  process.exit(1);
}

const RADIUS_M = 40;
const PERIOD_S = 60; // one lap per minute
const id = `bot-${Math.random().toString(36).slice(2, 10)}`;
const mPerDegLat = 111_320;
const mPerDegLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);

function connect() {
  const ws = new WebSocket(url);
  let timer;
  ws.on('open', () => {
    console.log(`connected to ${url} as ${name} (${id})`);
    ws.send(JSON.stringify({ type: 'hello', id, name, shirt: '#f0a040' }));
    const start = Date.now();
    timer = setInterval(() => {
      const t = ((Date.now() - start) / 1000 / PERIOD_S) * 2 * Math.PI;
      const east = RADIUS_M * Math.sin(t);
      const north = RADIUS_M * Math.cos(t);
      // Walking clockwise around the circle: heading is tangent = bearing-to-point + 90°.
      const heading = ((t * 180) / Math.PI + 90) % 360;
      ws.send(JSON.stringify({
        type: 'pos',
        lat: lat0 + north / mPerDegLat,
        lng: lng0 + east / mPerDegLng,
        heading,
        acc: 5,
      }));
    }, 500);
  });
  ws.on('close', () => {
    clearInterval(timer);
    console.log('disconnected, retrying in 2s');
    setTimeout(connect, 2000);
  });
  ws.on('error', (e) => console.error('ws error:', e.message));
}
connect();

// JSON API for accounts, friends, the shop and the coach, served by the same node:http server as the WebSocket.
// Auth is `Authorization: Bearer <device secret>` (the app's localStorage id); there are no cookies, so CORS can be open.
import { allowToken, coachConfigured, mintConversationToken } from './coach.mjs';
import {
  HttpError, buyItem, claimUsername, ensureUser, equipItem, getProfile, hasDb, listFriends, personalRecord,
  respondFriendRequest, sendFriendRequest,
} from './db.mjs';
import { COSMETICS, DURATIONS, USERNAME_RE } from './game-config.mjs';

const MAX_BODY = 4 * 1024;
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const EXERCISES = new Set(['squat', 'pushup']);

function cors(req) {
  const origin = req.headers.origin;
  const allow = ORIGINS.includes('*') ? '*' : origin && ORIGINS.includes(origin) ? origin : null;
  return allow
    ? {
        'access-control-allow-origin': allow,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
        vary: 'origin',
      }
    : {};
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too-large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString());
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new HttpError(400, 'bad-json'));
      }
    });
    req.on('error', reject);
  });
}

/** Public view of a profile (no internal id), plus live presence for friends. */
const pub = ({ id: _id, ...p }) => p;

/**
 * @param {{ presenceOf: (uid: string) => ({ id: string, busy: boolean } | null),
 *           patchUser: (uid: string, profile: object) => void,
 *           pushToUser: (uid: string, msg: object) => void }} live
 * Returns a request handler that resolves false for paths it doesn't own.
 */
export function createApi(live) {
  const withPresence = (p) => {
    const presence = live.presenceOf(p.id);
    return { ...pub(p), online: presence !== null, busy: presence?.busy ?? false, presenceId: presence?.id ?? null };
  };

  const routes = {
    'GET /api/me': async ({ uid }) => pub(await getProfile(uid)),

    'POST /api/username': async ({ uid, body }) => {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!USERNAME_RE.test(username)) throw new HttpError(400, 'invalid');
      const profile = await claimUsername(uid, username);
      live.patchUser(uid, profile);
      return pub(profile);
    },

    'GET /api/shop': async () => Object.entries(COSMETICS).map(([id, { slot, cost }]) => ({ id, slot, cost })),

    'POST /api/shop/buy': async ({ uid, body }) => {
      const profile = await buyItem(uid, String(body.itemId ?? ''));
      live.patchUser(uid, profile);
      return pub(profile);
    },

    'POST /api/equip': async ({ uid, body }) => {
      const itemId = body.itemId === null || body.itemId === undefined ? null : String(body.itemId);
      const profile = await equipItem(uid, String(body.slot ?? ''), itemId);
      live.patchUser(uid, profile);
      return pub(profile);
    },

    'GET /api/friends': async ({ uid }) => {
      const { friends, incoming, outgoing } = await listFriends(uid);
      return { friends: friends.map(withPresence), incoming: incoming.map(pub), outgoing: outgoing.map(pub) };
    },

    'POST /api/friends/requests': async ({ uid, body }) => {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!USERNAME_RE.test(username)) throw new HttpError(404, 'not-found');
      const { status, to } = await sendFriendRequest(uid, username);
      live.pushToUser(to, { type: status === 'accepted' ? 'friend_update' : 'friend_request' });
      live.pushToUser(uid, { type: 'friend_update' });
      return { status };
    },

    'POST /api/friends/respond': async ({ uid, body }) => {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const from = await respondFriendRequest(uid, username, body.accept === true);
      live.pushToUser(from, { type: 'friend_update' });
      live.pushToUser(uid, { type: 'friend_update' });
      return { ok: true };
    },

    'GET /api/pr': async ({ uid, url }) => {
      const exercise = url.searchParams.get('exercise');
      const durationS = Number(url.searchParams.get('durationS'));
      if (!EXERCISES.has(exercise) || !DURATIONS.has(durationS)) throw new HttpError(400, 'bad-set');
      return personalRecord(uid, exercise, durationS);
    },

    'GET /api/coach/token': async ({ uid }) => {
      if (!coachConfigured()) throw new HttpError(503, 'coach-not-configured');
      if (!allowToken(uid)) throw new HttpError(429, 'rate-limited');
      return { token: await mintConversationToken() };
    },
  };

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/api/')) return false;
    const headers = { ...cors(req), 'content-type': 'application/json', 'cache-control': 'no-store' };
    const reply = (status, body) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return true;
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      reply(404, { error: 'no-route' });
      return true;
    }
    try {
      if (!hasDb()) throw new HttpError(503, 'no-db');
      const auth = /^Bearer (.{4,64})$/.exec(req.headers.authorization ?? '');
      if (!auth) throw new HttpError(401, 'no-auth');
      const uid = await ensureUser(auth[1]);
      const body = req.method === 'POST' ? await readJson(req) : {};
      reply(200, await route({ uid, body, url }));
    } catch (e) {
      if (e instanceof HttpError) reply(e.status, { error: e.code });
      else {
        console.error(`[api] ${req.method} ${url.pathname} failed:`, e.message);
        reply(500, { error: 'server' });
      }
    }
    return true;
  };
}

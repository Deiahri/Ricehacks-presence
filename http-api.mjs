// JSON API for accounts, friends, the shop, leaderboards and the coach, served by the same node:http server as the WebSocket.
// Auth is `Authorization: Bearer <credential>`: a Clerk session token when CLERK_SECRET_KEY is set, else the device
// secret (see auth.mjs). There are no cookies, so CORS can be open.
import { accountFor } from './auth.mjs';
import { allowToken, coachConfigured, mintConversationToken } from './coach.mjs';
import {
  HttpError, buyItem, claimUsername, equipItem, getProfile, globalLeaderboard, hasDb, listFriends, listNotifications,
  markNotificationsRead, markVerified, personalRecord, recentWorkouts, respondFriendRequest, scoreTargets,
  sendFriendRequest, setAppearance, workoutDetail, workoutSeries,
} from './db.mjs';
import { COSMETICS, DURATIONS, SKIN_TONES, USERNAME_RE } from './game-config.mjs';
import { userRecap, workoutAdvice } from './insights.mjs';
import { INQUIRY_ID, fetchInquiry, inquiryVerdict, personaConfigured } from './persona.mjs';

const MAX_BODY = 4 * 1024;
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const EXERCISES = new Set(['squat', 'pushup']);
const HEX = /^#[0-9a-f]{6}$/i;

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
const pubNotification = (n) => ({ ...n, actor: n.actor && pub(n.actor) });

/** A set query's exercise + durationS, or 400 bad-set. */
function setOf(url) {
  const exercise = url.searchParams.get('exercise');
  const durationS = Number(url.searchParams.get('durationS'));
  if (!EXERCISES.has(exercise) || !DURATIONS.has(durationS)) throw new HttpError(400, 'bad-set');
  return { exercise, durationS };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A workout id query (?id=), or 400 bad-id. */
function idOf(url) {
  const id = url.searchParams.get('id') ?? '';
  if (!UUID.test(id)) throw new HttpError(400, 'bad-id');
  return id;
}

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

  /** Push a stored notification to its owner's open tabs. */
  const pushNotification = async (uid, id) => {
    const [n] = await listNotifications(uid, id);
    if (n) live.pushToUser(uid, { type: 'notification', notification: pubNotification(n) });
  };

  const routes = {
    'GET /api/me': async ({ uid }) => pub(await getProfile(uid)),

    'POST /api/appearance': async ({ uid, body }) => {
      const skin = body.skin === undefined || body.skin === null ? null : String(body.skin);
      const shirt = body.shirt === undefined || body.shirt === null ? null : String(body.shirt);
      if (skin !== null && !SKIN_TONES.has(skin)) throw new HttpError(400, 'bad-skin');
      if (shirt !== null && !HEX.test(shirt)) throw new HttpError(400, 'bad-shirt');
      const profile = await setAppearance(uid, { skin, shirt: shirt?.toLowerCase() ?? null });
      live.patchUser(uid, profile);
      return pub(profile);
    },

    'POST /api/username': async ({ uid, body }) => {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!USERNAME_RE.test(username)) throw new HttpError(400, 'invalid');
      const profile = await claimUsername(uid, username);
      live.patchUser(uid, profile);
      return pub(profile);
    },

    // Identity verification: the app starts Persona's flow with this reference id, then hands back the inquiry id,
    // which is checked with Persona before the account counts as verified.
    'GET /api/verify/start': async ({ uid }) => {
      if (!personaConfigured()) throw new HttpError(503, 'persona-not-configured');
      return { referenceId: uid };
    },

    'POST /api/verify': async ({ uid, body }) => {
      if (!personaConfigured()) throw new HttpError(503, 'persona-not-configured');
      const inquiryId = typeof body.inquiryId === 'string' ? body.inquiryId.trim() : '';
      if (!INQUIRY_ID.test(inquiryId)) throw new HttpError(400, 'bad-inquiry');
      let inquiry;
      try {
        inquiry = await fetchInquiry(inquiryId);
      } catch (e) {
        console.error('[persona] inquiry lookup failed:', e.message);
        throw new HttpError(502, 'persona-unavailable');
      }
      if (!inquiry) throw new HttpError(404, 'no-inquiry');
      const verdict = inquiryVerdict(inquiry, uid);
      if (!verdict.ok) throw new HttpError(verdict.reason === 'not-yours' ? 403 : 409, verdict.reason);
      const profile = await markVerified(uid, inquiryId);
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
      const { status, to, notification } = await sendFriendRequest(uid, username);
      live.pushToUser(to, { type: status === 'accepted' ? 'friend_update' : 'friend_request' });
      live.pushToUser(uid, { type: 'friend_update' });
      if (notification) await pushNotification(to, notification);
      return { status };
    },

    'POST /api/friends/respond': async ({ uid, body }) => {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const { from, notification } = await respondFriendRequest(uid, username, body.accept === true);
      live.pushToUser(from, { type: 'friend_update' });
      live.pushToUser(uid, { type: 'friend_update' });
      await pushNotification(from, notification);
      return { ok: true };
    },

    'GET /api/notifications': async ({ uid }) => {
      const items = (await listNotifications(uid)).map(pubNotification);
      return { items, unread: items.filter((n) => !n.read).length };
    },

    'POST /api/notifications/read': async ({ uid }) => {
      await markNotificationsRead(uid);
      return { ok: true };
    },

    'GET /api/leaderboard': async ({ uid }) => globalLeaderboard(uid),

    'GET /api/workouts': async ({ uid }) => recentWorkouts(uid),

    // One workout for the replay screen (fast, no AI), its coaching advice (AI, cached), and trend data.
    'GET /api/workout': async ({ uid, url }) => workoutDetail(uid, idOf(url)),

    'GET /api/workout/advice': async ({ uid, url }) => workoutAdvice(uid, idOf(url)),

    'GET /api/workouts/series': async ({ uid, url }) => {
      const { exercise, durationS } = url.searchParams.has('exercise') ? setOf(url) : { exercise: null, durationS: null };
      return workoutSeries(uid, exercise, durationS);
    },

    'GET /api/recap': async ({ uid }) => userRecap(uid),

    'GET /api/pr': async ({ uid, url }) => {
      const { exercise, durationS } = setOf(url);
      return personalRecord(uid, exercise, durationS);
    },

    'GET /api/targets': async ({ uid, url }) => {
      const { exercise, durationS } = setOf(url);
      const opponent = url.searchParams.get('opponent');
      return scoreTargets(uid, exercise, durationS, opponent && USERNAME_RE.test(opponent) ? opponent : null);
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
      const auth = /^Bearer (\S{4,4096})$/.exec(req.headers.authorization ?? '');
      if (!auth) throw new HttpError(401, 'no-auth');
      const { uid } = await accountFor(auth[1]);
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

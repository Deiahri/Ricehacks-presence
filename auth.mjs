// Who is calling. With CLERK_SECRET_KEY set, a credential is a Clerk session token (Google sign-in) and the account is
// keyed by its user id ("sub"). Without it (local dev, `npm run smoke`) a credential is the app's device secret, as before.
import { verifyToken } from '@clerk/backend';
import { HttpError, ensureAuthUser, ensureUser } from './db.mjs';

const SECRET = process.env.CLERK_SECRET_KEY || null;
// Optional: the app's origins (e.g. https://nextrep.vercel.app), so a token minted for another site is refused.
const PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export const clerkEnabled = () => SECRET !== null;

/** The Clerk user id inside a session token. Throws 401 bad-token for anything invalid or expired. */
async function subjectOf(token) {
  let payload;
  try {
    payload = await verifyToken(token, { secretKey: SECRET, ...(PARTIES.length ? { authorizedParties: PARTIES } : {}) });
  } catch {
    throw new HttpError(401, 'bad-token');
  }
  if (typeof payload?.sub !== 'string' || !payload.sub) throw new HttpError(401, 'bad-token');
  return payload.sub;
}

/**
 * The account behind a credential, created on first sight (`shirt` seeds a new account's colour).
 * Resolves { uid, key }: key is the stable id stored in workouts.user_id (the Clerk user id, or the device secret).
 */
export async function accountFor(credential, shirt = null) {
  if (!clerkEnabled()) return { uid: await ensureUser(credential, shirt), key: credential };
  const sub = await subjectOf(credential);
  return { uid: await ensureAuthUser(sub, shirt), key: sub };
}

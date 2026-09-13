// ElevenLabs voice coach: mints a short-lived WebRTC conversation token for the app, so the API key stays here.
// Needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID (create the agent with `npm run coach:agent`). Neither is logged.
const API = 'https://api.elevenlabs.io';
const PER_HOUR = 20; // tokens per user per hour; each coached set uses one

export const coachConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID);

const recent = new Map(); // uid → timestamps of tokens minted in the last hour

/** False when `uid` has used up this hour's tokens. */
export function allowToken(uid) {
  const now = Date.now();
  const times = (recent.get(uid) ?? []).filter((t) => now - t < 3_600_000);
  if (times.length >= PER_HOUR) return false;
  times.push(now);
  recent.set(uid, times);
  return true;
}

export async function mintConversationToken() {
  const url = `${API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(process.env.ELEVENLABS_AGENT_ID)}`;
  const res = await fetch(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ElevenLabs token request failed (${res.status})`);
  const { token } = await res.json();
  if (typeof token !== 'string') throw new Error('ElevenLabs token response had no token');
  return token;
}

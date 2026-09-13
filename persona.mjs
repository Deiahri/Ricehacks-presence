// Identity verification (Persona). The app runs Persona's embedded flow with referenceId = the account id; when it
// completes, the server fetches that inquiry and checks it before marking the account verified. Needs PERSONA_API_KEY,
// which is sent as a header and never logged. Without it verification is off and everyone counts as verified.
const API = 'https://api.withpersona.com/api/v1/inquiries';
// Sandbox templates often stop at "completed" (no review step); "approved" is the reviewed pass.
const PASSING = new Set(['completed', 'approved']);

export const personaConfigured = () => Boolean(process.env.PERSONA_API_KEY);

/** Persona inquiry ids look like inq_ABC123… */
export const INQUIRY_ID = /^inq_[A-Za-z0-9]{6,64}$/;

/**
 * Whether a retrieved inquiry verifies account `uid`: it must have been started for this account and have passed.
 * Resolves { ok: true, status } or { ok: false, reason: 'bad-inquiry' | 'not-yours' | 'not-passed', status? }.
 */
export function inquiryVerdict(json, uid) {
  const a = json?.data?.attributes;
  if (!a || typeof a.status !== 'string') return { ok: false, reason: 'bad-inquiry' };
  if (!uid || a['reference-id'] !== uid) return { ok: false, reason: 'not-yours', status: a.status };
  if (!PASSING.has(a.status)) return { ok: false, reason: 'not-passed', status: a.status };
  return { ok: true, status: a.status };
}

/** The inquiry as Persona reports it (kebab-case keys), or null when Persona doesn't know it. Throws on other failures. */
export async function fetchInquiry(id, timeoutMs = 10_000) {
  const res = await fetch(`${API}/${encodeURIComponent(id)}`, {
    headers: {
      authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
      'persona-version': '2023-01-05',
      'key-inflection': 'kebab',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Persona request failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  return res.json();
}

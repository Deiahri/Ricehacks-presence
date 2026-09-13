// Gemini (Google AI Studio) writes the workout advice and the progress recap (insights.mjs). Needs GEMINI_API_KEY,
// which is sent as a header and never logged; GEMINI_MODEL picks the model. Without a key, insights.mjs falls back to
// rule-based text.
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const PER_HOUR = 30; // generations per user per hour (results are cached, so this only bites on spam)

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);
export const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const recent = new Map(); // uid → timestamps of generations in the last hour

/** False when `uid` has used up this hour's generations. */
export function allowGeneration(uid) {
  const now = Date.now();
  const times = (recent.get(uid) ?? []).filter((t) => now - t < 3_600_000);
  if (times.length >= PER_HOUR) return false;
  times.push(now);
  recent.set(uid, times);
  return true;
}

/**
 * One JSON answer shaped by `schema` (Gemini's OpenAPI-style responseSchema). Throws on HTTP errors, a blocked
 * prompt, an empty answer or unparseable JSON. maxTokens leaves room for the model's own thinking.
 */
export async function generateJson({ system, prompt, schema, maxTokens = 2048, timeoutMs = 15_000 }) {
  const res = await fetch(`${API}/${encodeURIComponent(geminiModel())}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.7, maxOutputTokens: maxTokens },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini request failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt (${data.promptFeedback.blockReason})`);
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason ?? 'unknown'})`);
  return JSON.parse(text);
}

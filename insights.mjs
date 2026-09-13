// AI coaching text: advice on one workout, and a short recap of how someone's been doing lately.
// The numbers are worked out here and Gemini only puts them into words, so it can't invent stats. No names or ids
// are sent. Results are cached in Postgres; with no key, a failure or the hourly limit, a rule-based fallback is
// returned instead and NOT cached, so real text replaces it once Gemini is available.
import {
  getInsight, getRecap, personalRecord, putInsight, putRecap, workoutDetail, workoutSeries, workoutStats,
} from './db.mjs';
import { allowGeneration, geminiConfigured, geminiModel, generateJson } from './gemini.mjs';

/** A recap is rewritten after a new workout, or when it gets this old (so "you've been slacking" can show up). */
const RECAP_MAX_AGE_MS = 3 * 86_400_000;
const DAY_MS = 86_400_000;
const EXERCISE = { squat: 'squats', pushup: 'push-ups' };

const SYSTEM = `You are the NextRep workout coach: upbeat, direct, specific and a little playful.
You receive JSON stats about bodyweight sets scored by a phone camera. Each rep gets a form score 0-100
(green >= 80, yellow 50-79, red < 50) and is worth form/10 points. Base everything on the numbers given and never
invent any. No medical claims. Speak to the athlete as "you". Plain text only: no markdown, no emoji.`;

const inflight = new Map(); // one generation per cache key at a time
function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

// --- one workout ------------------------------------------------------------------

function adviceFacts(d, pr, previous) {
  const me = d.me;
  const detail = me.repDetail.length === me.repScores.length ? me.repDetail : [];
  const scores = me.repScores;
  const half = Math.floor(scores.length / 2);
  const cueCounts = {};
  const subs = {};
  for (const r of detail) {
    for (const c of r.c ?? []) if (c !== 'Good rep') cueCounts[c] = (cueCounts[c] ?? 0) + 1;
    for (const [k, v] of Object.entries(r.sub ?? {})) (subs[k] ??= []).push(v);
  }
  const durations = detail.map((r) => r.d).filter((v) => typeof v === 'number');
  return {
    exercise: EXERCISE[d.exercise] ?? d.exercise,
    setLengthSeconds: d.durationS,
    mode: d.mode === 'challenge' ? 'battle' : 'solo',
    reps: me.reps,
    points: me.score,
    avgForm: r1(me.avgForm ?? mean(scores)),
    grades: {
      green: scores.filter((s) => s >= 80).length,
      yellow: scores.filter((s) => s >= 50 && s < 80).length,
      red: scores.filter((s) => s < 50).length,
    },
    formFirstHalf: r1(mean(scores.slice(0, half))),
    formSecondHalf: r1(mean(scores.slice(half))),
    repForms: scores,
    repTimesSeconds: detail.length ? detail.map((r) => r.t) : undefined,
    avgRepSeconds: r1(mean(durations)),
    subscoreAverages: Object.fromEntries(Object.entries(subs).map(([k, v]) => [k, r1(mean(v))])),
    commonCues: Object.entries(cueCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([cue, times]) => ({ cue, times })),
    personalBestPoints: pr.bestScore,
    isPersonalBest: pr.bestScore !== null && me.score !== null && me.score >= pr.bestScore,
    previousSetsSameType: previous.map((s) => ({ points: s.score, reps: s.reps, avgForm: r1(s.avgForm) })),
    battle: d.opponent
      ? {
          result: d.forfeit ? `${d.result} (forfeit)` : d.result,
          opponentPoints: d.opponent.score,
          opponentReps: d.opponent.reps,
          damageDealt: d.battle?.you.dealt,
          damageTaken: d.battle?.you.taken,
          hpLeft: d.battle ? `${d.battle.you.hp}/${d.battle.hpMax}` : undefined,
        }
      : undefined,
  };
}

const ADVICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'At most 8 words.' },
    summary: { type: 'STRING', description: '1-2 sentences on how the set went, citing a number.' },
    tips: { type: 'ARRAY', items: { type: 'STRING' }, description: '2-3 concrete tips for the next set, at most 20 words each.' },
    focusCue: { type: 'STRING', description: 'A 2-5 word cue to remember next set.' },
  },
  required: ['headline', 'summary', 'tips', 'focusCue'],
};

function normalizeAdvice(a) {
  const tips = Array.isArray(a?.tips) ? a.tips.map((t) => clip(t, 160)).filter(Boolean).slice(0, 3) : [];
  const out = { headline: clip(a?.headline, 80), summary: clip(a?.summary, 360), tips, focusCue: clip(a?.focusCue, 48) };
  if (!out.headline || !out.summary || !tips.length) throw new Error('Gemini advice was missing fields');
  return out;
}

const SUB_TIPS = {
  depth: 'Sink deeper on every rep: hips below knees on squats, chest close to the floor on push-ups.',
  torso: 'Keep your chest up and your back tall through the whole squat.',
  symmetry: 'Drive evenly through both sides; film yourself side-on to spot the lean.',
  body_line: 'Brace your core and squeeze your glutes so your body stays one straight line.',
  lockout: 'Straighten your arms fully at the top of every push-up.',
};

function fallbackAdvice(f) {
  if (!f.reps) {
    return {
      headline: 'No reps counted',
      summary: `The camera didn't count any ${f.exercise} in this ${f.setLengthSeconds} s set.`,
      tips: ['Stand side-on with your whole body in frame.', 'Go all the way down and back up so each rep registers.'],
      focusCue: 'Full range, full frame',
    };
  }
  const tips = [];
  const weakest = Object.entries(f.subscoreAverages).sort((a, b) => a[1] - b[1])[0];
  if (weakest && weakest[1] < 80 && SUB_TIPS[weakest[0]]) tips.push(SUB_TIPS[weakest[0]]);
  if (f.formFirstHalf !== null && f.formSecondHalf !== null && f.formSecondHalf < f.formFirstHalf - 5) {
    tips.push(`Your form dropped from ${f.formFirstHalf}% to ${f.formSecondHalf}% late in the set; ease the pace to keep quality.`);
  }
  if (f.commonCues[0]) tips.push(`Most common note: "${f.commonCues[0].cue}". Fix that first.`);
  if (tips.length < 2) tips.push('Keep the same tempo and aim for one more clean rep next time.');
  const form = f.avgForm ?? 0;
  return {
    headline: form >= 80 ? 'Clean set!' : form >= 50 ? 'Solid set, room to sharpen' : 'Form needs work',
    summary: `${f.reps} ${f.exercise} in ${f.setLengthSeconds} s for ${f.points} points at ${f.avgForm}% average form${f.isPersonalBest ? ', a new personal best!' : '.'}`,
    tips: tips.slice(0, 3),
    focusCue: weakest ? `Own the ${weakest[0].replace('_', ' ')}` : 'Quality over quantity',
  };
}

/** Advice on one of my workouts: { headline, summary, tips[], focusCue, source: 'gemini' | 'fallback' }. 404 if not mine. */
export async function workoutAdvice(uid, id) {
  const cached = await getInsight(id, uid);
  if (cached) return { ...cached, source: 'gemini' };
  const d = await workoutDetail(uid, id);
  const [pr, series] = await Promise.all([personalRecord(uid, d.exercise, d.durationS), workoutSeries(uid, d.exercise, d.durationS, 6)]);
  const facts = adviceFacts(d, pr, series.filter((s) => s.id !== id).slice(-5));
  const fallback = () => ({ ...fallbackAdvice(facts), source: 'fallback' });
  if (!geminiConfigured()) return fallback();
  return once(`advice:${uid}:${id}`, async () => {
    if (!allowGeneration(uid)) return fallback();
    try {
      const advice = normalizeAdvice(await generateJson({
        system: SYSTEM,
        prompt: `Give feedback on this set and how to improve next time.\nStats:\n${JSON.stringify(facts)}`,
        schema: ADVICE_SCHEMA,
      }));
      await putInsight(id, uid, advice, geminiModel());
      return { ...advice, source: 'gemini' };
    } catch (e) {
      console.error('[ai] workout advice failed:', e.message);
      return fallback();
    }
  });
}

// --- the recap ------------------------------------------------------------------

function recapFacts(sets, totalSets, now = Date.now()) {
  const daysAgo = (s) => (now - new Date(s.createdAt).getTime()) / DAY_MS;
  const perWeek = [0, 0, 0, 0];
  for (const s of sets) {
    const w = Math.floor(daysAgo(s) / 7);
    if (w < 4) perWeek[w]++;
  }
  const formIn = (from, to) => r1(mean(sets.filter((s) => daysAgo(s) >= from && daysAgo(s) < to && s.avgForm !== null).map((s) => s.avgForm)));
  const byExercise = {};
  for (const ex of new Set(sets.map((s) => s.exercise))) {
    const xs = sets.filter((s) => s.exercise === ex && s.avgForm !== null);
    if (!xs.length) continue;
    byExercise[EXERCISE[ex] ?? ex] = {
      sets: xs.length,
      formEarliest3: r1(mean(xs.slice(0, 3).map((s) => s.avgForm))),
      formLatest3: r1(mean(xs.slice(-3).map((s) => s.avgForm))),
    };
  }
  const battles = sets.filter((s) => s.mode === 'challenge');
  return {
    totalSetsAllTime: totalSets,
    daysSinceLastSet: r1(daysAgo(sets.at(-1))),
    setsPerWeekNewestFirst: perWeek,
    avgFormLast7Days: formIn(0, 7),
    avgFormPrevious7Days: formIn(7, 14),
    byExercise,
    battles: {
      wins: battles.filter((s) => s.result === 'win').length,
      losses: battles.filter((s) => s.result === 'loss').length,
      draws: battles.filter((s) => s.result === 'draw').length,
    },
    recentSets: sets.slice(-10).map((s) => ({
      daysAgo: r1(daysAgo(s)), exercise: EXERCISE[s.exercise] ?? s.exercise, lengthSeconds: s.durationS,
      points: s.score, reps: s.reps, avgForm: r1(s.avgForm), result: s.result ?? undefined,
    })),
  };
}

const TRENDS = ['improving', 'steady', 'slipping', 'slacking', 'new'];
const RECAP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'At most 6 words.' },
    text: { type: 'STRING', description: 'At most 2 short sentences (under 240 characters): one concrete number and one nudge.' },
    trend: {
      type: 'STRING',
      enum: TRENDS,
      description: 'improving / steady / slipping (form or output down) / slacking (4+ days idle or far fewer sets) / new (under 3 sets in total).',
    },
  },
  required: ['headline', 'text', 'trend'],
};

function normalizeRecap(r) {
  const out = { headline: clip(r?.headline, 60), text: clip(r?.text, 280), trend: TRENDS.includes(r?.trend) ? r.trend : 'steady' };
  if (!out.headline || !out.text) throw new Error('Gemini recap was missing fields');
  return out;
}

function fallbackRecap(f) {
  const n = f.totalSetsAllTime;
  if (n < 3) {
    return { headline: 'Just getting started', text: `You've logged ${n} set${n === 1 ? '' : 's'}. A few more and trends will show up here.`, trend: 'new' };
  }
  const idle = Math.floor(f.daysSinceLastSet);
  if (idle >= 4) {
    return { headline: 'Time to get moving', text: `It's been ${idle} days since your last set. One quick 15 s set gets you rolling again.`, trend: 'slacking' };
  }
  const [now, before] = [f.avgFormLast7Days, f.avgFormPrevious7Days];
  if (now !== null && before !== null && now - before >= 3) {
    return { headline: 'Form is climbing', text: `Your average form is ${now}% this week, up from ${before}%. Keep stacking clean reps.`, trend: 'improving' };
  }
  if (now !== null && before !== null && before - now >= 3) {
    return { headline: 'Form slipped a bit', text: `Average form fell to ${now}% from ${before}% last week. Slow down and own every rep.`, trend: 'slipping' };
  }
  const week = f.setsPerWeekNewestFirst[0];
  return {
    headline: 'Steady work',
    text: `${week} set${week === 1 ? '' : 's'} this week${now !== null ? ` at ${now}% average form` : ''}. Try adding one rep next time.`,
    trend: 'steady',
  };
}

/** How I've been doing lately: { headline, text, trend, source: 'gemini' | 'fallback' | 'none', count }. */
export async function userRecap(uid) {
  const stats = await workoutStats(uid);
  if (stats.count === 0) return { headline: '', text: '', trend: 'new', source: 'none', count: 0 };
  const cached = await getRecap(uid);
  if (cached && cached.latestId === stats.latestId && cached.count === stats.count
      && Date.now() - new Date(cached.createdAt).getTime() < RECAP_MAX_AGE_MS) {
    return { ...cached.recap, source: 'gemini', count: stats.count };
  }
  const facts = recapFacts(await workoutSeries(uid, null, null, 30), stats.count);
  const fallback = () => ({ ...fallbackRecap(facts), source: 'fallback', count: stats.count });
  if (!geminiConfigured()) return fallback();
  return once(`recap:${uid}:${stats.latestId}:${stats.count}`, async () => {
    if (!allowGeneration(uid)) return fallback();
    try {
      const recap = normalizeRecap(await generateJson({
        system: SYSTEM,
        prompt: `Write a quick recap of how this athlete has been doing lately: improving, steady, slipping or slacking.\nStats:\n${JSON.stringify(facts)}`,
        schema: RECAP_SCHEMA,
      }));
      await putRecap(uid, stats, recap, geminiModel());
      return { ...recap, source: 'gemini', count: stats.count };
    } catch (e) {
      console.error('[ai] recap failed:', e.message);
      return fallback();
    }
  });
}

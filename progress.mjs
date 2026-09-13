// Weekly goal bookkeeping, pure: week deadlines, streaks and the reward wheel. The database glue is in db.mjs.
// Dates are ISO strings (YYYY-MM-DD) already in the user's zone; Mondays start weeks.
import { WHEEL } from './game-config.mjs';

const DAY_MS = 86_400_000;
/** Date arithmetic in UTC, so a DST change never shifts a day. */
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Settle an unfinished week against `today`: it stays open through its Sunday plus one day per streak saver spent,
 * savers being spent as the days pass (whether or not the user opens the app). Returns { extraDays, saversLeft,
 * closed }; closed = today is past the (extended) deadline with the goal still unmet.
 */
export function settleWeek({ weekStart, extraDays, savers, today }) {
  const deadline = addDays(weekStart, 7 + extraDays); // the first day the week is over
  let late = daysBetween(deadline, today) + 1; // days the week needs to stay open past its deadline, today included
  if (late <= 0) return { extraDays, saversLeft: savers, closed: false };
  const spend = Math.min(late, savers);
  return { extraDays: extraDays + spend, saversLeft: savers - spend, closed: late - spend > 0 };
}

/** 'met' | 'missed' | 'open' for a week row. */
export const weekStatus = (w) => (w.met ? 'met' : w.closed ? 'missed' : 'open');

/**
 * Consecutive met weeks, newest first, over `weeks` = [{ start, met, closed }] sorted by start descending and
 * covering every week since the goal was set. A week still in progress doesn't break the run.
 */
export function streakOf(weeks) {
  let n = 0;
  for (const w of weeks) {
    if (w.met) n++;
    else if (w.closed) break;
  }
  return n;
}

/** The wedge `r` (0 ≤ r < 1) lands on, by weight. */
export function pickWedge(r, wheel = WHEEL) {
  const total = wheel.reduce((n, w) => n + w.weight, 0);
  let x = r * total;
  for (const w of wheel) {
    x -= w.weight;
    if (x < 0) return w;
  }
  return wheel[wheel.length - 1];
}

/**
 * Shape GET /api/progress from settled rows: `weeks` = the recent rows ({ start, goal, xp, met, extraDays, closed,
 * spun }) oldest first, `days` = Map(date → { xp, sets }) for the same span, `all` = every row newest first (for the
 * streak).
 */
export function buildProgress({ goal, today, thisWeek, savers, weeks, days, all }) {
  return {
    goal,
    today,
    thisWeek,
    streak: streakOf(all),
    saverDays: savers,
    level: 1 + all.filter((w) => w.met).length,
    pendingReward: all.some((w) => w.met && !w.spun),
    weeks: weeks.map((w) => ({
      start: w.start,
      goal: w.goal,
      xp: w.xp,
      status: weekStatus(w),
      extraDays: w.extraDays,
      current: w.start === thisWeek,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(w.start, i);
        const d = days.get(date);
        return { date, xp: d?.xp ?? 0, sets: d?.sets ?? 0 };
      }),
    })),
  };
}

// Weekly goal rules. Run with `npm test` (node --test, no dependencies).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WHEEL } from '../game-config.mjs';
import { addDays, buildProgress, daysBetween, pickWedge, settleWeek, streakOf } from '../progress.mjs';

const MON = '2026-09-07'; // a Monday

test('date helpers work across month ends', () => {
  assert.equal(addDays('2026-08-31', 7), '2026-09-07');
  assert.equal(addDays(MON, -1), '2026-09-06');
  assert.equal(daysBetween('2026-09-07', '2026-09-14'), 7);
});

test('an unfinished week stays open through Sunday', () => {
  for (const today of [MON, '2026-09-10', '2026-09-13']) {
    assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 0, savers: 2, today }), { extraDays: 0, saversLeft: 2, closed: false });
  }
});

test('past Sunday with no saver the week is missed', () => {
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 0, savers: 0, today: '2026-09-14' }), { extraDays: 0, saversLeft: 0, closed: true });
});

test('a saver keeps the week open one more day, and is spent', () => {
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 0, savers: 1, today: '2026-09-14' }), { extraDays: 1, saversLeft: 0, closed: false });
  // Already extended: still open on the same day without spending again
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 1, savers: 0, today: '2026-09-14' }), { extraDays: 1, saversLeft: 0, closed: false });
  // The next day it's over
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 1, savers: 0, today: '2026-09-15' }), { extraDays: 1, saversLeft: 0, closed: true });
});

test('savers burn one per day away, then the week closes', () => {
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 0, savers: 2, today: '2026-09-15' }), { extraDays: 2, saversLeft: 0, closed: false });
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 0, savers: 1, today: '2026-09-16' }), { extraDays: 1, saversLeft: 0, closed: true });
  assert.deepEqual(settleWeek({ weekStart: MON, extraDays: 0, savers: 5, today: '2026-09-16' }), { extraDays: 3, saversLeft: 2, closed: false });
});

test('streak counts met weeks back from now; an open week does not break it', () => {
  const w = (start, met, closed = false) => ({ start, met, closed });
  assert.equal(streakOf([]), 0);
  assert.equal(streakOf([w('2026-09-07', false), w('2026-08-31', true), w('2026-08-24', true), w('2026-08-17', false, true), w('2026-08-10', true)]), 2);
  assert.equal(streakOf([w('2026-09-07', true), w('2026-08-31', true)]), 2);
  assert.equal(streakOf([w('2026-09-07', false, true)]), 0);
});

test('the wheel honours weights and covers every wedge', () => {
  const total = WHEEL.reduce((n, w) => n + w.weight, 0);
  assert.equal(total, 100);
  assert.equal(pickWedge(0).id, 'saver1');
  assert.equal(pickWedge(0.299).id, 'saver1');
  assert.equal(pickWedge(0.3).id, 'bp10');
  assert.equal(pickWedge(0.999).id, 'bp50');
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(pickWedge(i / 1000).id);
  assert.equal(seen.size, WHEEL.length);
});

test('progress: 7 days per week, level and pending reward from the rows', () => {
  const weeks = [
    { start: '2026-08-31', goal: 40, xp: 41, met: true, extraDays: 1, closed: false, spun: true },
    { start: MON, goal: 40, xp: 12, met: false, extraDays: 0, closed: false, spun: false },
  ];
  const all = [...weeks].reverse();
  const days = new Map([['2026-09-01', { xp: 41, sets: 2 }], ['2026-09-08', { xp: 12, sets: 1 }]]);
  const p = buildProgress({ goal: 40, today: '2026-09-09', thisWeek: MON, savers: 1, weeks, days, all });
  assert.equal(p.level, 2);
  assert.equal(p.streak, 1);
  assert.equal(p.pendingReward, false);
  assert.equal(p.weeks.length, 2);
  assert.equal(p.weeks[0].status, 'met');
  assert.equal(p.weeks[0].extraDays, 1);
  assert.equal(p.weeks[1].status, 'open');
  assert.equal(p.weeks[1].current, true);
  assert.equal(p.weeks[1].days.length, 7);
  assert.equal(p.weeks[1].days[1].xp, 12);
  assert.equal(p.weeks[1].days[6].date, '2026-09-13');
});

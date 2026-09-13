// Battle item rules. Run with `npm test` (node --test, no dependencies).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curseRoll, diffEvent, hpMaxFor, loadoutOf, orient, resolveBattle } from '../battle-effects.mjs';

const SEED = 'test-seed';
const NONE = {};
const SHIELD = { offhand: 'low_tier_shield' };
const GAUNTLET = { mainhand: 'gauntlet' };
const HAT = { head: 'warlock_hat' };
const WAND = { mainhand: 'magic_wand' };

const duel = (a, b, durationS = 15, seed = SEED) =>
  resolveBattle({ seed, durationS, a: { equipped: a[0], scores: a[1] }, b: { equipped: b[0], scores: b[1] } });

test('loadout reads the worn slots', () => {
  assert.deepEqual(loadoutOf({ ...SHIELD, ...HAT, ...GAUNTLET }), { shield: true, gauntlet: true, hat: true, wand: false });
  assert.deepEqual(loadoutOf(undefined), { shield: false, gauntlet: false, hat: false, wand: false });
});

test('no items: damage = points (form / 10), HP from set length', () => {
  const r = duel([NONE, [100, 80, 50]], [NONE, [40]]);
  assert.equal(r.hpMax, hpMaxFor(15));
  assert.equal(r.hpMax, 75);
  assert.equal(r.a.dealt, 23);
  assert.equal(r.b.dealt, 4);
  assert.equal(r.a.hp, 71);
  assert.equal(r.b.hp, 52);
  assert.equal(r.a.rawScore, 23);
  assert.equal(r.winner, 'a');
});

test('shield absorbs 30% of incoming damage', () => {
  const r = duel([SHIELD, []], [NONE, [100, 100]]);
  assert.equal(r.b.dealt, 14);
  assert.equal(r.a.absorbed, 6);
  assert.equal(r.a.taken, 14);
});

test('gauntlet hits 1.5×, and against a shield 1.05×', () => {
  assert.equal(duel([GAUNTLET, [100, 100]], [NONE, []]).a.dealt, 30);
  assert.equal(duel([GAUNTLET, [100, 100]], [NONE, []]).a.gauntletBonus, 10);
  assert.equal(duel([GAUNTLET, [100, 100]], [SHIELD, []]).a.dealt, 21);
});

test('curse rolls are deterministic and ~20%', () => {
  assert.equal(curseRoll(SEED, 'a', 3), curseRoll(SEED, 'a', 3));
  assert.notEqual(curseRoll(SEED, 'a', 3), curseRoll(SEED, 'b', 3));
  let hits = 0;
  for (let i = 0; i < 10_000; i++) if (curseRoll(SEED, 'a', i) < 0.2) hits++;
  assert.ok(Math.abs(hits / 10_000 - 0.2) < 0.02, `rate ${hits / 10_000}`);
});

test('curse: only red reps, only against a hat, deals −1', () => {
  const red = Array(200).fill(30);
  const cursed = duel([NONE, red], [HAT, []]);
  const n = cursed.a.cursedReps.length;
  assert.ok(n > 0 && n < 200);
  assert.equal(cursed.b.cursesCast, n);
  assert.equal(cursed.a.cursesSuffered, n);
  assert.equal(cursed.a.dealt, Math.round(((200 - n) * 3 - n) * 10) / 10);
  assert.deepEqual(duel([NONE, red], [NONE, []]).a.cursedReps, []);
  assert.deepEqual(duel([NONE, Array(200).fill(50)], [HAT, []]).a.cursedReps, []); // 50 is yellow
  assert.deepEqual(duel([NONE, red], [HAT, []]).a.cursedReps, cursed.a.cursedReps); // same seed, same curses
});

test('a curse is not multiplied by the gauntlet', () => {
  const r = duel([GAUNTLET, Array(50).fill(0)], [HAT, []]);
  assert.equal(r.a.dealt, -r.a.cursedReps.length);
  assert.equal(r.b.hp, 75); // heals are capped at max HP
});

test('wand: 5 perfect reps in a row, once', () => {
  assert.equal(duel([WAND, [95, 95, 95, 95, 95]], [NONE, []]).a.surge, true);
  assert.equal(duel([WAND, [95, 95, 95, 95]], [NONE, []]).a.surge, false);
  assert.equal(duel([WAND, [95, 95, 95, 89, 95, 95]], [NONE, []]).a.surge, false);
  assert.equal(duel([WAND, [90, 90, 90, 90, 90]], [NONE, []]).a.surge, true); // 90 counts as perfect
  assert.equal(duel([NONE, Array(5).fill(100)], [NONE, []]).a.surge, false); // needs the wand
  const r = duel([WAND, Array(12).fill(100)], [NONE, []]);
  assert.equal(r.a.bestStreak, 12);
  assert.equal(r.a.surge, true);
});

test('winner: damage, then raw score, then reps, else draw', () => {
  assert.equal(duel([NONE, [100]], [GAUNTLET, [80]]).winner, 'b'); // 10 vs 12 damage
  assert.equal(duel([SHIELD, [60]], [NONE, [60]]).winner, 'a'); // 6 vs 4.2 damage
  assert.equal(duel([NONE, [50, 50]], [NONE, [100]]).winner, 'a'); // same damage and score, more reps
  assert.equal(duel([NONE, [100]], [NONE, [100]]).winner, null);
});

test('HP clamps at 0 (K.O.) but damage keeps counting', () => {
  const r = duel([NONE, Array(22).fill(100)], [NONE, []]);
  assert.equal(r.a.dealt, 220);
  assert.equal(r.b.hp, 0);
});

test('orient and live events', () => {
  const before = duel([NONE, [30]], [HAT, []], 15, 'x');
  const o = orient(before, 'b');
  assert.equal(o.you, before.b);
  assert.equal(o.opponent, before.a);
  // Find a seed whose first rep is cursed, so the event fires.
  let seed = 0;
  while (curseRoll(`s${seed}`, 'a', 0) >= 0.2) seed++;
  const next = duel([NONE, [30]], [HAT, []], 15, `s${seed}`);
  assert.deepEqual(diffEvent(null, next, 'b'), { kind: 'curse', by: 'you' });
  assert.deepEqual(diffEvent(null, next, 'a'), { kind: 'curse', by: 'opponent' });
  assert.equal(diffEvent(next, next, 'a'), null);
  const surge = duel([WAND, Array(5).fill(100)], [NONE, []]);
  assert.deepEqual(diffEvent(null, surge, 'a'), { kind: 'surge', who: 'you' });
});

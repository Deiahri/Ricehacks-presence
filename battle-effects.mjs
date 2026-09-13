// The HP duel: how two fighters' rep scores and worn items turn into damage, HP and a winner.
// Pure (no I/O) and recomputed from the full rep arrays every time, so the live HP bars and the final result can't
// disagree. Side 'a' is the challenger, 'b' the challenged. The rules and numbers are in game-config.mjs.
import { createHash } from 'node:crypto';
import { HP_PER_SECOND, ITEM_EFFECTS } from './game-config.mjs';

const { low_tier_shield: SHIELD, gauntlet: GAUNTLET, warlock_hat: HAT, magic_wand: WAND } = ITEM_EFFECTS;

const r1 = (v) => Math.round(v * 10) / 10;
const otherSide = (side) => (side === 'a' ? 'b' : 'a');

/** Which battle effects a fighter's worn items give ({ slot: itemId } from users.equipped). */
export function loadoutOf(equipped) {
  const e = equipped ?? {};
  return {
    shield: e.offhand === 'low_tier_shield',
    gauntlet: e.mainhand === 'gauntlet',
    hat: e.head === 'warlock_hat',
    wand: e.mainhand === 'magic_wand',
  };
}

export const hpMaxFor = (durationS) => durationS * HP_PER_SECOND;

/** A uniform [0, 1) roll for rep `i` of `side`, fixed by the challenge's secret seed. */
export function curseRoll(seed, side, i) {
  return createHash('sha256').update(`${seed}:${side}:${i}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** How `attacker`'s reps land on `defender`. */
function attack(seed, side, scores, attacker, defender) {
  let dealt = 0, absorbed = 0, gauntletBonus = 0;
  const cursedReps = [];
  scores.forEach((s, i) => {
    if (defender.hat && s < HAT.curseBelow && curseRoll(seed, side, i) < HAT.curseChance) {
      dealt += HAT.curseDamage; // not multiplied: the curse replaces the hit
      cursedReps.push(i);
      return;
    }
    let dmg = s / 10;
    if (attacker.gauntlet) {
      gauntletBonus += dmg * (GAUNTLET.damageMult - 1);
      dmg *= GAUNTLET.damageMult;
    }
    if (defender.shield) {
      absorbed += dmg * SHIELD.absorb;
      dmg *= 1 - SHIELD.absorb;
    }
    dealt += dmg;
  });
  let streak = 0, bestStreak = 0;
  for (const s of scores) {
    streak = s >= WAND.perfectAt ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
  }
  return { dealt, absorbed, gauntletBonus, cursedReps, streak, bestStreak };
}

/**
 * Settle (or preview, mid-set) a battle. `a` / `b` = { equipped, scores: form scores 0-100 in rep order }.
 * Resolves { hpMax, winner: 'a' | 'b' | null, a: SideOut, b: SideOut } where SideOut =
 * { dealt, taken, hp, absorbed, gauntletBonus, cursedReps, cursesCast, cursesSuffered, streak, bestStreak, surge,
 *   rawScore, reps, loadout }. `absorbed` = what my shield blocked; `cursedReps` = my reps their hat turned into −1.
 */
export function resolveBattle({ seed, durationS, a, b }) {
  const hpMax = hpMaxFor(durationS);
  const load = { a: loadoutOf(a.equipped), b: loadoutOf(b.equipped) };
  const scores = { a: a.scores ?? [], b: b.scores ?? [] };
  const hits = {
    a: attack(seed, 'a', scores.a, load.a, load.b),
    b: attack(seed, 'b', scores.b, load.b, load.a),
  };
  const out = {};
  for (const side of ['a', 'b']) {
    const mine = hits[side], theirs = hits[otherSide(side)];
    out[side] = {
      dealt: r1(mine.dealt),
      taken: r1(theirs.dealt),
      hp: r1(Math.min(hpMax, Math.max(0, hpMax - theirs.dealt))),
      absorbed: r1(theirs.absorbed), // blocked by my shield
      gauntletBonus: r1(mine.gauntletBonus),
      cursedReps: mine.cursedReps,
      cursesCast: theirs.cursedReps.length,
      cursesSuffered: mine.cursedReps.length,
      streak: mine.streak,
      bestStreak: mine.bestStreak,
      surge: load[side].wand && mine.bestStreak >= WAND.streak,
      rawScore: Math.round(scores[side].reduce((s, v) => s + v, 0) / 10),
      reps: scores[side].length,
      loadout: load[side],
    };
  }
  const key = (s) => [out[s].dealt, out[s].rawScore, out[s].reps];
  let winner = null;
  const [ka, kb] = [key('a'), key('b')];
  for (let i = 0; i < ka.length && winner === null; i++) if (ka[i] !== kb[i]) winner = ka[i] > kb[i] ? 'a' : 'b';
  return { hpMax, winner, a: out.a, b: out.b };
}

/** The result as one fighter sees it: { hpMax, you, opponent }. */
export function orient(res, side) {
  return { hpMax: res.hpMax, you: res[side], opponent: res[otherSide(side)] };
}

/**
 * What just happened, for a live toast on `side`'s phone: a curse landed (by: 'you' = your hat cursed their rep) or
 * a wand surge charged. Null when nothing notable changed.
 */
export function diffEvent(prev, next, side) {
  const you = next[side], opp = next[otherSide(side)];
  const was = prev ? { you: prev[side], opp: prev[otherSide(side)] } : null;
  if (opp.cursedReps.length > (was?.opp.cursedReps.length ?? 0)) return { kind: 'curse', by: 'you' };
  if (you.cursedReps.length > (was?.you.cursedReps.length ?? 0)) return { kind: 'curse', by: 'opponent' };
  if (you.surge && !was?.you.surge) return { kind: 'surge', who: 'you' };
  if (opp.surge && !was?.opp.surge) return { kind: 'surge', who: 'opponent' };
  return null;
}

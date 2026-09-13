// Hardcoded game rules. The server is the authority on everything that touches BP;
// the app mirrors DURATIONS and the cosmetic prices in src/game/types.ts and src/config/cosmetics.ts.

/** Set lengths a solo workout or a battle may use, in seconds. */
export const DURATIONS = new Set([15, 30, 60, 120, 300]);

/** Battle points. Solo: score × soloPerScorePoint. Battle: score + the outcome bonus. A forfeiter gets `forfeit`. */
export const REWARDS = { soloPerScorePoint: 1, win: 50, draw: 20, loss: 0, forfeit: 0 };
export const STARTING_BP = 0;

/**
 * Weekly XP goal. Every counted rep is 1 XP; a rep at XP_PERFECT_AT+ form (the app's green "Great!") is 2. The week
 * runs Monday→Sunday in the user's zone, and reaching the goal is a level-up: the star on the map turns gold and a spin
 * of the reward wheel is owed. A streak-saver day keeps an unfinished week open one more day past Sunday.
 * The app mirrors these in src/game/xp.ts.
 */
export const XP_PERFECT_AT = 80;
export const GOAL_MIN = 10;
export const GOAL_MAX = 1000;
export const xpForRep = (form) => (form >= XP_PERFECT_AT ? 2 : 1);
export const xpForScores = (scores) => scores.reduce((n, s) => n + xpForRep(s), 0);
/** Reward wheel wedges in display order; `weight` is the relative chance. The app draws the same wheel. */
export const WHEEL = [
  { id: 'saver1', kind: 'saver', days: 1, weight: 30 },
  { id: 'bp10', kind: 'bp', bp: 10, weight: 25 },
  { id: 'saver2', kind: 'saver', days: 2, weight: 15 },
  { id: 'bp20', kind: 'bp', bp: 20, weight: 20 },
  { id: 'item', kind: 'item', weight: 3 },
  { id: 'bp50', kind: 'bp', bp: 50, weight: 7 },
];

export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export const SLOTS = ['head', 'offhand', 'mainhand'];
/** id → { slot, cost }. Art and on-avatar placement live in the app (src/config/cosmetics.ts). */
export const COSMETICS = {
  low_tier_shield: { slot: 'offhand', cost: 150 },
  magic_wand: { slot: 'mainhand', cost: 300 },
  gauntlet: { slot: 'mainhand', cost: 350 },
  warlock_hat: { slot: 'head', cost: 400 },
};
/** Wear an item as soon as it's bought. */
export const AUTO_EQUIP_ON_BUY = true;

/**
 * Battles are an HP duel: each fighter starts with HP_PER_SECOND × set length, and every rep hits the other for its
 * points (form / 10). Most damage dealt wins. Worn items change the damage (see battle-effects.mjs):
 *   shield   — takes `absorb` off every hit you receive
 *   gauntlet — your hits are × damageMult
 *   hat      — each of the foe's reps under `curseBelow` has `curseChance` to deal `curseDamage` instead (it heals you)
 *   wand     — `streak` reps in a row at `perfectAt`+ form pays `surgeBp` extra BP at the end, once per battle
 * Items only change who wins; BP stays score-based (plus the wand surge).
 */
export const HP_PER_SECOND = 5;
export const ITEM_EFFECTS = {
  low_tier_shield: { absorb: 0.3 },
  gauntlet: { damageMult: 1.5 },
  warlock_hat: { curseChance: 0.2, curseBelow: 50, curseDamage: -1 },
  magic_wand: { perfectAt: 90, streak: 5, surgeBp: 50 },
};

/** Skin tone ids the avatar editor offers (free to change). The colours live in the app's src/config/appearance.ts. */
export const SKIN_TONES = new Set(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);

export const soloBp = (score) => Math.max(0, Math.round(score * REWARDS.soloPerScorePoint));
/** outcome: 'win' | 'loss' | 'draw'. `surge` = the magic wand fired this battle. */
export const battleBp = (score, outcome, forfeited, surge = false) =>
  forfeited ? REWARDS.forfeit : Math.max(0, score) + REWARDS[outcome] + (surge ? ITEM_EFFECTS.magic_wand.surgeBp : 0);

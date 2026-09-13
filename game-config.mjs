// Hardcoded game rules. The server is the authority on everything that touches BP;
// the app mirrors DURATIONS and the cosmetic prices in src/game/types.ts and src/config/cosmetics.ts.

/** Set lengths a solo workout or a battle may use, in seconds. */
export const DURATIONS = new Set([15, 30, 60, 120, 300]);

/** Battle points. Solo: score × soloPerScorePoint. Battle: score + the outcome bonus. A forfeiter gets `forfeit`. */
export const REWARDS = { soloPerScorePoint: 1, win: 50, draw: 20, loss: 0, forfeit: 0 };
export const STARTING_BP = 0;
/** Lifetime BP earned per level (level 1 at 0). */
export const BP_PER_LEVEL = 200;

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
export const levelFor = (earned) => 1 + Math.floor(Math.max(0, earned) / BP_PER_LEVEL);

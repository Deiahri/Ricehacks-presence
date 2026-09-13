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

export const soloBp = (score) => Math.max(0, Math.round(score * REWARDS.soloPerScorePoint));
/** outcome: 'win' | 'loss' | 'draw'. */
export const battleBp = (score, outcome, forfeited) => (forfeited ? REWARDS.forfeit : Math.max(0, score) + REWARDS[outcome]);
export const levelFor = (earned) => 1 + Math.floor(Math.max(0, earned) / BP_PER_LEVEL);

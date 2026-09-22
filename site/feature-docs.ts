/**
 * A one-line description of every key in the feature row, for pages that
 * show a row to a person: what the number means, its units, and the code
 * table for the categorical ones. Slot, direction and terrain-cell prefixes
 * are expanded from the tables here. Keep in step with src/sense/features.ts.
 */
import { CLASSES, ENEMY_KINDS } from "../src/sense/features.ts";

const GROUND_KINDS = ["open", "wall", "step", "drop1", "drop2", "dropMore", "lava", "water", "magma"];
const MOVE_CODES = ["forward", "back", "left", "right"];
const LAST_HIT = ["nothing yet", "zombie", "arrow or skeleton", "creeper", "something else"];

const SLOT_LETTER = (n: number) => String.fromCharCode(65 + n);
const BOT: Record<string, string> = {
  b_health: "Bot health out of 20.",
  b_onGround: "1 if the bot is standing on the ground (a paused window never starts airborne).",
  b_speed: "Bot horizontal speed in blocks per second.",
  b_vy: "Bot vertical velocity in blocks per tick (falling is negative).",
  b_swordReadyIn: "Ticks until the sword's attack cooldown has fully recharged (0 = ready now).",
  b_swordReadyAtEffect: "Ticks the sword still needs at the moment the answer takes effect (after the lead).",
  b_swordReady: "1 if the sword will be ready when the answer takes effect.",
  b_shieldUp: "1 if the shield is currently raised.",
  b_shieldActiveIn: "If the shield is raised: ticks until it actually blocks (a raise needs 5 ticks). NaN if it is down.",
  b_shieldActiveAtEffect: "1 if the shield is raised and will be active when the answer takes effect.",
  b_shieldActiveInAny: "Ticks until the shield can be active: its own countdown if up, else lead plus the 5-tick activation for a raise now.",
  b_shieldServer: "1 if the server has confirmed the shield as blocking (its own status signal).",
  b_hurtAgo: "Ticks since the bot was last hit. NaN if never hit this fight.",
  b_invulnerableAtEffect: "1 if the post-hit invulnerability (10 ticks) still covers the moment the answer takes effect.",
  b_lastHitKind: `What last hit the bot, as a code: ${LAST_HIT.map((s, i) => `${i}=${s}`).join(", ")}.`,
  b_pitDepth: "Depth in blocks of the hole the bot stands in, 0 on open floor.",
  b_cobblestone: "Cobblestone blocks in the inventory, available for cover columns.",
  b_onFire: "1 if the bot is burning (blaze fireballs, magma). NaN in logs before fire was tracked.",
  b_witherTicks: "Ticks of wither effect remaining (from a wither skeleton hit). NaN in older logs.",
  b_facedSlot: "Which enemy slot the bot currently faces (0 = A, the nearest). NaN if none.",
  b_facedKind: `Kind of the faced enemy: ${ENEMY_KINDS.map((k, i) => `${i}=${k}`).join(", ")}.`,
};
const GROUND: Record<string, string> = {
  kind: `The first thing that is not open floor in that direction: ${GROUND_KINDS.map((k, i) => `${i}=${k}`).join(", ")}.`,
  at: "How many blocks out that obstacle or hazard is (4 = open floor for the whole 3-block probe).",
  room: "Blocks of walkable room in that direction before the obstacle (a one-block step down does not end it).",
  hazardWithinWalk: "1 if a real hazard (drop of 2+, lava, water, magma) lies within the distance this window's walk covers.",
};
const GROUND_AGG: Record<string, string> = {
  g_cornered: "1 if room behind is at most one block and there is no room left or right.",
  g_backingBlocked: "1 if there is at most one block of room behind.",
  g_sideRoomDiff: "Room to the left minus room to the right, in blocks.",
  g_maxRoom: "The largest room in any of the four directions.",
};
const AGG: Record<string, string> = {
  n_shots: "Incoming shots: arrows predicted to hit plus bows that release before a lowered shield could be active again.",
  n_shotsInArcNow: "How many of those shots come from inside the current shield arc (90 degrees either side of the facing).",
  n_minShotTicks: "Ticks until the earliest of those shots lands or releases.",
  n_enemies: "Hostiles alive (all of them, not only the six slots).",
  n_melee: "Melee enemies among the slots (not ranged, not creepers).",
  n_archers: "Ranged enemies among the slots (bow skeletons, blazes).",
  n_creepers: "Creepers among the slots.",
  n_meleeInReachThen: "Melee enemies that will be within sword reach (3 blocks) when the answer takes effect.",
  n_otherMeleeInReachThen: "Of those, how many are not the faced enemy.",
  n_meleeConverging: "Melee enemies forecast within 4.5 blocks: the ones about to arrive.",
  n_nearestMeleeDist: "Distance to the nearest melee enemy now, in blocks.",
  n_nearestMeleeFdist: "Distance to the nearest melee enemy when the answer takes effect, forecast from velocities.",
  n_nearestMeleeTicksToReach: "Ticks until the nearest melee enemy reaches sword range at its current closing speed.",
  n_minReleaseIn: "Ticks until the earliest drawn bow releases.",
  n_archerFiresWithinWindow: "1 if a bow releases within this window (lead plus two ticks).",
  n_archerFiresBeforeReguard: "1 if a bow releases before a shield lowered now could be active again.",
  n_creeperLit: "1 if any creeper's fuse is lit. NaN if there are no creepers.",
  n_maxFuse: "The highest creeper fuse counter (explodes at 30).",
  n_creeperFdistMin: "Forecast distance to the nearest creeper.",
  n_creeperInFuseRangeThen: "1 if a creeper will be within fuse range (3 blocks) when the answer takes effect.",
  n_bombImminent: "1 if a lit creeper's fuse is at 20 or more: sprint away now.",
  n_facedInReachThen: "1 if the faced enemy will be in sword reach when the answer takes effect.",
  n_facedOverlapping: "1 if the faced melee enemy is inside one block, sharing the bot's space.",
  n_facedAttackReadyIn: "Ticks until the faced melee enemy can swing again (they swing at most every 20 ticks).",
  n_facedFdist: "Forecast distance to the faced enemy when the answer takes effect.",
  n_facedHasBow: "1 if the faced enemy is ranged.",
  n_facedBelowHole: "1 if the faced enemy is two or more blocks below the bot.",
  n_facedTicksToReach: "Ticks until the faced enemy reaches sword range at its current closing speed.",
  n_swordBeforeFacedAttack: "Faced enemy's attack countdown minus the sword's: positive means the bot can strike first.",
  n_walksInto_forward: "1 if stepping forward walks into a melee enemy other than the faced one.",
  n_walksInto_back: "1 if stepping back walks into a melee enemy other than the faced one.",
  n_walksInto_left: "1 if stepping left walks into a melee enemy other than the faced one.",
  n_walksInto_right: "1 if stepping right walks into a melee enemy other than the faced one.",
  n_arrows: "Arrows in flight.",
  n_arrowsHitting: "Arrows in flight predicted to hit a standing bot.",
  n_minArrowImpact: "Ticks until the earliest predicted arrow impact.",
  n_arrowsHitIfMoving: "Arrows that miss a standing bot but hit one that walks this window's distance sideways into them.",
  n_minArrival: "Ticks until the earliest drawn bow's arrow could arrive (release plus flight at 1.6 blocks a tick).",
  n_shieldInTime: "1 if the shield can be active before the earliest shot (arrow impact or bow arrival) lands.",
  n_shieldMargin: "Ticks of slack between the shield being active and the earliest shot landing; negative means a raise now is too late.",
  n_archersWithLos: "Ranged enemies that currently have a line of sight to the bot.",
};
const ENEMY: Record<string, string> = {
  present: "1 if an enemy occupies this slot.",
  kind: `Enemy kind: ${ENEMY_KINDS.map((k, i) => `${i}=${k}`).join(", ")}.`,
  hp: "Enemy health.",
  dist: "Horizontal distance now, in blocks.",
  dy: "Height difference now (positive = enemy is higher).",
  reachNow: "Straight-line distance now, the one sword reach is judged on.",
  fdist: "Horizontal distance when the answer takes effect, forecast from both velocities.",
  fwalk: "Forecast distance after the bot also walks toward it for this window.",
  freach: "Forecast straight-line distance when the answer takes effect.",
  fdy: "Forecast height difference.",
  angle: "Bearing from the bot's facing, signed degrees (positive = to the right).",
  absAngle: "Unsigned bearing from the facing: 0 is dead ahead, 180 behind.",
  speed: "Enemy horizontal speed, blocks per second.",
  closing: "Closing speed toward the bot, blocks per second (negative = moving away).",
  lookAngle: "How far the enemy's own facing is off the bot, degrees (0 = looking straight at it).",
  hasBow: "1 if ranged (bow or blaze).",
  drawing: "1 if it is drawing its bow right now.",
  releaseIn: "Ticks until its drawn bow releases.",
  hitUsAgo: "Ticks since it last hit the bot.",
  hurtAgo: "Ticks since the bot last hit it.",
  attackReadyIn: "Ticks until a melee enemy can swing again, at the moment the answer takes effect.",
  attackReady: "1 if a melee enemy's swing is ready then.",
  knockback: "1 if it was hit in the last 10 ticks and is flying away from the bot.",
  aggressive: "1 if the server reports it aggressive (arms raised).",
  fuse: "Creeper fuse counter (explodes at 30).",
  lit: "1 if the creeper's fuse is lit.",
  isFaced: "1 if this is the enemy the bot faces.",
  inReachThen: "1 if it will be in sword reach when the answer takes effect.",
  inReachWalking: "1 if it will be in reach after the bot walks toward it this window.",
  overlapping: "1 if a melee enemy is inside one block.",
  belowHole: "1 if it is two or more blocks below the bot.",
  coverIfFaced: "1 if facing this enemy would put every incoming shot inside the shield arc.",
  shotDegIfFaced: "If the bot faced this enemy, the widest angle any incoming shot would be off the facing.",
  nearlyDead: "1 if health is 6 or less.",
  los: "1 if it has a line of sight to the bot.",
  ticksToReach: "Ticks until it reaches sword range at its current closing speed (0 = already there, NaN = not closing).",
};
const ARROW: Record<string, string> = {
  present: "1 if an arrow occupies this slot (slots hold the arrows predicted to hit first, then the nearest).",
  dist: "Horizontal distance to the arrow now.",
  angle: "Bearing of the arrow from the facing, signed degrees.",
  impact: "Ticks until it hits a standing bot (NaN = predicted to miss).",
  impactAfterEffect: "Impact ticks measured from when the answer takes effect.",
  willHit: "1 if predicted to hit a standing bot.",
  inArcNow: "1 if it comes from inside the current shield arc.",
  speed: "Arrow speed, blocks per second.",
  impactMoving: "Ticks until it hits if the bot walks this window's distance sideways into its line.",
  hitsIfMoving: "1 if it misses a standing bot but would hit one that sidesteps into it.",
  dodge: `The move that leaves its line: ${MOVE_CODES.map((m, i) => `${i}=${m}`).join(", ")}.`,
  shieldInTime: "1 if the shield can be active before this arrow lands.",
};
const TERRAIN: Record<string, string> = {
  h: "Floor height of this cell relative to the bot's feet (-4 = a hole deeper than the probe).",
  s: "1 if the cell is standable (floor with two blocks of headroom).",
  z: "Hazard code for the cell (0 = none).",
};
const PREVIOUS: Record<string, string> = {
  p_move: `The move applied last window: ${CLASSES.move.map((m, i) => `${i}=${m}`).join(", ")}.`,
  p_hands: `The hands action applied last window: ${CLASSES.hands.map((m, i) => `${i}=${m}`).join(", ")}.`,
  p_pace: `The pace applied last window: ${CLASSES.pace.map((m, i) => `${i}=${m}`).join(", ")}.`,
  p_jump: "1 if the bot jumped last window.",
  p_swung: "1 if the bot swung the sword last window.",
  p_wasted: "1 if that swing found nothing in reach or the sword was cold.",
};
const DIRS: Record<string, string> = { ahead: "ahead", behind: "behind", left: "to the left", right: "to the right" };
const CELL = (name: string) => {
  const row = name[0] === "f" ? `${name[1]} ahead` : name[0] === "b" ? `${name[1]} behind` : "the bot's row";
  const col = name[2] === "l" ? `${name[3]} left` : name[2] === "r" ? `${name[3]} right` : "the bot's column";
  return `${row}, ${col}`;
};

export function describeFeature(key: string): string {
  let m: RegExpExecArray | null;
  if (BOT[key]) return BOT[key];
  if (GROUND_AGG[key]) return GROUND_AGG[key];
  if (AGG[key]) return AGG[key];
  if (PREVIOUS[key]) return PREVIOUS[key];
  if ((m = /^g_(ahead|behind|left|right)_(\w+)$/.exec(key))) return `Ground ${DIRS[m[1]!]}: ${GROUND[m[2]!] ?? ""}`;
  if ((m = /^e(\d)_(\w+)$/.exec(key))) return `Enemy ${SLOT_LETTER(Number(m[1]))} (slot ${m[1]}, lettered nearest first): ${ENEMY[m[2]!] ?? ""}`;
  if ((m = /^a(\d)_(\w+)$/.exec(key))) return `Arrow slot ${m[1]}: ${ARROW[m[2]!] ?? ""}`;
  if ((m = /^t_([fbc]\d?[lrc]\d?)_(\w)$/.exec(key)) || (m = /^t_(c0c0)_(\w)$/.exec(key))) return `Terrain cell ${CELL(m[1]!)} (5x5 grid rotated to the facing): ${TERRAIN[m[2]!] ?? ""}`;
  if (key === "t_standable") return "Standable cells in the 5x5 grid (of 25).";
  if (key === "t_hazards") return "Hazard cells in the 5x5 grid.";
  if ((m = /^w_(\w+)$/.exec(key))) return m[1] === "nearest" ? "Blocks to the nearest wall in any of eight directions (17 = none within the probe)." : `Blocks to the nearest wall ${m[1]!.replace("_", "-")} (17 = none within the probe).`;
  return "";
}


/** The sections a row is shown in, in order, with the keys each one owns. */
export const FEATURE_GROUPS: [string, RegExp][] = [
  ["Bot and its clocks", /^b_/],
  ["Ground in four directions", /^g_/],
  ["Aggregates over enemies, shots and arrows", /^n_/],
  ["Enemy slot A (e0)", /^e0_/], ["Enemy slot B (e1)", /^e1_/], ["Enemy slot C (e2)", /^e2_/],
  ["Enemy slot D (e3)", /^e3_/], ["Enemy slot E (e4)", /^e4_/], ["Enemy slot F (e5)", /^e5_/],
  ["Arrow slot 0", /^a0_/], ["Arrow slot 1", /^a1_/],
  ["Terrain grid, 5x5 around the bot", /^t_/],
  ["Walls in eight directions", /^w_/],
  ["Previous window", /^p_/],
];

/** The code table for a categorical feature, or undefined for a plain number. */
export function featureCodes(key: string): readonly string[] | undefined {
  if (/^(e\d_kind|b_facedKind)$/.test(key)) return [...ENEMY_KINDS];
  if (/^g_\w+_kind$/.test(key)) return GROUND_KINDS;
  if (key === "b_lastHitKind") return LAST_HIT;
  if (/^a\d_dodge$/.test(key)) return MOVE_CODES;
  if (key === "p_move") return CLASSES.move;
  if (key === "p_hands") return CLASSES.hands;
  if (key === "p_pace") return CLASSES.pace;
  return undefined;
}

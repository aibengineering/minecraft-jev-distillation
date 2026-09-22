/**
 * The decision snapshot as a flat, fixed-width row of numbers, for LightGBM
 * and anything else that wants a table rather than prose.
 *
 * The row describes the situation and nothing about which fight it came
 * from: no tick or turn counters, no absolute positions, no timing regime.
 * Those sit on the sample as fields for analysis but a model that saw them
 * would learn the fixtures' scripts rather than the combat.
 *
 * Everything here is a pure function of the snapshot the loop already logs
 * (plus the previous window's applied answer), so the same rows come out of a
 * live fight and out of a replayed log. Old logs lack a few snapshot fields
 * (forecastReach, heightDifference); every derived quantity is therefore
 * recomputed from positions, velocities and lead rather than read back.
 *
 * Missing values are NaN (null once serialised); LightGBM routes them itself.
 */

import {
  ARROW_SPEED, CREEPER_FUSE_RANGE, CREEPER_FUSE_TICKS, HURT_INVULNERABLE_TICKS, MOB_ATTACK_INTERVAL_TICKS, OVERLAP_BLOCKS, REACH,
  SHIELD_ARC_DEGREES, SHIELD_READY_TICKS, WALK_BLOCKS_PER_TICK,
} from "./constants.ts";

export const MAX_ENEMY_SLOTS = 6;
export const MAX_ARROW_SLOTS = 2;

/** Every categorical answer as the class list LightGBM is trained over, in a fixed order. */
export const CLASSES = {
  /** Enemy slot index, or "keep"; slots are lettered nearest first, so slot 0 is A. */
  face: [...Array.from({ length: MAX_ENEMY_SLOTS }, (_, i) => String(i)), "keep"],
  move: ["forward", "back", "left", "right", "hold"],
  hands: ["strike", "guard", "free", "cover"],
  pace: ["sprint", "walk", "sneak"],
  jump: ["false", "true"],
} as const;
export type Head = keyof typeof CLASSES;
export const HEADS = Object.keys(CLASSES) as Head[];

export const ENEMY_KINDS = ["zombie", "skeleton", "creeper", "other", "wither_skeleton", "blaze"] as const;
const GROUND_KINDS = ["open", "wall", "step", "drop1", "drop2", "dropMore", "lava", "water", "magma"] as const;

interface XYZ {
  x: number;
  y: number;
  z: number;
}
export interface SnapshotEnemy {
  id: number;
  label: string;
  name: string;
  position: XYZ;
  velocity: XYZ;
  yaw: number;
  health: number | null;
  held: string | null;
  distance: number;
  states: string[];
  drawing: boolean;
  releaseIn: number | null;
  hitUsAgo: number | null;
  hurtAgo: number | null;
  /** Line of sight from the bot's eyes; absent in older logs. */
  los?: boolean;
  /** Shoots (a bow, or a blaze's fireballs); absent in older logs, where a bow in hand means the same. */
  ranged?: boolean;
}
export interface SnapshotArrow {
  id: number;
  position: XYZ;
  velocity: XYZ;
  /** Ticks until it lands on a standing bot, or null for a miss. */
  impactTicks: number | null;
  /** The same with the box widened by the window's walk; absent in older logs. */
  impactTicksMoving?: number | null;
  degrees?: number;
  inArc?: boolean;
  /** The move that leaves the arrow's line. */
  dodge?: string;
}
export interface Snapshot {
  tick: number;
  lead: number;
  bot: {
    position: XYZ;
    velocity: XYZ;
    yaw: number;
    health: number;
    food: number;
    onGround: boolean;
    swordReadyIn: number;
    shield: { up: boolean; activeIn: number | null; server: boolean };
    hurtAgo: number | null;
    lastHitBy: string;
    facedId: number;
    /** Added with the sample format; absent in older logs, where the state text carries it. */
    pitDepth?: number;
    /** Blocks carried for cover; absent in older logs. */
    cobblestone?: number;
    onFire?: boolean;
    witherTicks?: number;
  };
  /**
   * How the window relates to game time (see TIMING in src/regime.ts): "latency"
   * when the world ran while the policy thought (lead > 0, hold ≈ lead),
   * "instant" or "frozen" when the answer lands at once and holds for `hold`
   * ticks. Older logs have neither field and are the latency regime.
   */
  regime?: "latency" | "instant" | "frozen";
  hold?: number;
  enemies: SnapshotEnemy[];
  arrows: SnapshotArrow[];
  ground: Record<"ahead" | "behind" | "left" | "right", string>;
  /** Egocentric five-by-five terrain, ahead first then left to right; absent in older logs. */
  terrain?: { h: number | null; s: number; z: number }[];
  /** Blocks to the nearest wall in eight directions from the facing; absent in older logs. */
  walls?: Record<string, number | null>;
}

/** What the previous window applied, the same facts jev reads in "Last answer applied". */
export interface Previous {
  move: string;
  hands: string;
  pace: string;
  jump: boolean;
  swung: boolean;
  /** The swing found nothing in reach or the sword was cold. */
  wasted: boolean;
}

export interface FeatureContext {
  previous: Previous | null;
}

export type FeatureRow = Record<string, number>;

const DIRECTIONS = ["ahead", "behind", "left", "right"] as const;

function facingOf(yaw: number): XYZ {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/** Signed degrees from one horizontal direction to another, positive clockwise seen from above. */
function degreesBetween(from: XYZ, to: XYZ): number {
  return (Math.atan2(from.x * to.z - from.z * to.x, from.x * to.x + from.z * to.z) * 180) / Math.PI;
}

function flat(d: XYZ): number {
  return Math.hypot(d.x, d.z);
}

function minus(a: XYZ, b: XYZ): XYZ {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function plusScaled(a: XYZ, v: XYZ, k: number): XYZ {
  return { x: a.x + v.x * k, y: a.y + v.y * k, z: a.z + v.z * k };
}

function kindOf(name: string): number {
  const index = ENEMY_KINDS.indexOf(name as (typeof ENEMY_KINDS)[number]);
  return index === -1 ? ENEMY_KINDS.length - 1 : index;
}

function parseGround(text: string): { kind: number; at: number; room: number; hazardAt: number } {
  const m = /^(wall|one-block step up|drop of (?:(\d)|more than 3)|lava|water|magma) at (\d)/.exec(text);
  if (!m) return { kind: 0, at: 4, room: 3, hazardAt: NaN };
  const at = Number(m[3]);
  let kind: (typeof GROUND_KINDS)[number];
  if (m[1] === "wall") kind = "wall";
  else if (m[1] === "one-block step up") kind = "step";
  else if (m[1] === "lava") kind = "lava";
  else if (m[1] === "water") kind = "water";
  else if (m[1] === "magma") kind = "magma";
  else if (m[2] === "1") kind = "drop1";
  else if (m[2] !== undefined) kind = "drop2";
  else kind = "dropMore";
  // Room mirrors the control loop: a one-block step down does not end the room, everything else does.
  const room = kind === "drop1" ? 3 : Math.max(0, at - 1);
  const hazardAt = kind === "drop1" || kind === "wall" || kind === "step" ? NaN : at;
  void hazardAt;
  return { kind: GROUND_KINDS.indexOf(kind), at, room, hazardAt };
}

function fuseOf(enemy: SnapshotEnemy): { fuse: number; lit: boolean } | null {
  if (enemy.name !== "creeper") return null;
  const text = enemy.states.find((state) => state.startsWith("fuse")) ?? "";
  const fuse = Number(/fuse (\d+) of/.exec(text)?.[1] ?? 0);
  return { fuse, lit: text.includes("LIT") };
}

function lastHitKind(text: string): number {
  const t = text.toLowerCase();
  if (t.startsWith("nothing")) return 0;
  if (t.includes("creeper")) return 3;
  if (t.includes("arrow") || t.includes("skeleton")) return 2;
  if (t.includes("zombie")) return 1;
  return 4;
}

const codeOf = (classes: readonly string[], value: string | undefined): number => {
  if (value === undefined) return NaN;
  const index = classes.indexOf(value);
  return index === -1 ? NaN : index;
};

const nanMin = (a: number, b: number) => (Number.isNaN(a) ? b : Math.min(a, b));
const nanMax = (a: number, b: number) => (Number.isNaN(a) ? b : Math.max(a, b));

const ENEMY_KEYS = [
  "present", "kind", "hp", "dist", "dy", "reachNow", "fdist", "fwalk", "freach", "fdy", "angle", "absAngle", "speed", "closing", "lookAngle",
  "hasBow", "drawing", "releaseIn", "hitUsAgo", "hurtAgo", "attackReadyIn", "attackReady", "knockback", "aggressive", "fuse", "lit",
  "isFaced", "inReachThen", "inReachWalking", "overlapping", "belowHole", "coverIfFaced", "shotDegIfFaced", "nearlyDead", "los", "ticksToReach",
];
/** Terrain cell names, ahead first then left to right: f2..b2 rows, l2..r2 columns. */
const TERRAIN_CELLS = ["f2", "f1", "c0", "b1", "b2"].flatMap((row) => ["l2", "l1", "c0", "r1", "r2"].map((col) => `${row}${col}`));
const WALL_DIRECTIONS = ["ahead", "ahead-right", "right", "behind-right", "behind", "behind-left", "left", "ahead-left"];
const ARROW_KEYS = ["present", "dist", "angle", "impact", "impactAfterEffect", "willHit", "inArcNow", "speed", "impactMoving", "hitsIfMoving", "dodge", "shieldInTime"];
const MOVE_CODES: Record<string, number> = { forward: 0, back: 1, left: 2, right: 3 };

/** The flat row. Keys are stable; new keys may be appended but never renamed, so old samples stay usable. */
export function featureRow(snapshot: Snapshot, context: FeatureContext): FeatureRow {
  const row: FeatureRow = {};
  const b = snapshot.bot;
  const lead = snapshot.lead;
  const me = b.position;
  const facing = facingOf(b.yaw);
  const meThen = plusScaled(me, b.velocity, lead);
  // Walking and re-guard spans follow the regime, as the text does: over the lead when the world runs
  // while the policy thinks, over the hold when the answer lands at once.
  const regime = snapshot.regime ?? "latency";
  const hold = snapshot.hold ?? lead;
  const walk = WALK_BLOCKS_PER_TICK * (regime === "latency" ? lead : hold);
  const reguard = (regime === "latency" ? 2 * lead : hold) + SHIELD_READY_TICKS;

  // The bot and its clocks, forecast to when the answer lands as the text does.
  row.b_health = b.health;
  row.b_onGround = b.onGround ? 1 : 0;
  row.b_speed = flat(b.velocity) * 20;
  row.b_vy = b.velocity.y;
  row.b_swordReadyIn = b.swordReadyIn;
  row.b_swordReadyAtEffect = Math.max(0, b.swordReadyIn - lead);
  row.b_swordReady = b.swordReadyIn <= lead ? 1 : 0;
  row.b_shieldUp = b.shield.up ? 1 : 0;
  row.b_shieldActiveIn = b.shield.up && b.shield.activeIn !== null ? b.shield.activeIn : NaN;
  row.b_shieldActiveAtEffect = b.shield.up && b.shield.activeIn !== null && b.shield.activeIn <= lead ? 1 : 0;
  /** Ticks from the snapshot until the shield can be active: its own countdown if up, else a raise landing with the answer plus activation. */
  const shieldActiveIn = b.shield.up && b.shield.activeIn !== null ? b.shield.activeIn : lead + SHIELD_READY_TICKS;
  row.b_shieldActiveInAny = shieldActiveIn;
  row.b_shieldServer = b.shield.server ? 1 : 0;
  row.b_hurtAgo = b.hurtAgo ?? NaN;
  row.b_invulnerableAtEffect = b.hurtAgo !== null && b.hurtAgo + lead < HURT_INVULNERABLE_TICKS ? 1 : 0;
  row.b_lastHitKind = lastHitKind(b.lastHitBy);
  row.b_pitDepth = b.pitDepth ?? 0;
  row.b_cobblestone = b.cobblestone ?? NaN;
  row.b_onFire = b.onFire === undefined ? NaN : b.onFire ? 1 : 0;
  row.b_witherTicks = b.witherTicks ?? NaN;

  // Ground in four directions and the room it leaves.
  const room: Record<string, number> = {};
  for (const direction of DIRECTIONS) {
    const g = parseGround(snapshot.ground[direction] ?? "");
    row[`g_${direction}_kind`] = g.kind;
    row[`g_${direction}_at`] = g.at;
    row[`g_${direction}_room`] = g.room;
    row[`g_${direction}_hazardWithinWalk`] = Number.isNaN(g.hazardAt) ? 0 : g.hazardAt <= Math.ceil(walk) + 1 ? 1 : 0;
    room[direction] = g.room;
  }
  row.g_cornered = room.behind! <= 1 && room.left === 0 && room.right === 0 ? 1 : 0;
  row.g_backingBlocked = room.behind! <= 1 ? 1 : 0;
  row.g_sideRoomDiff = room.left! - room.right!;
  row.g_maxRoom = Math.max(room.ahead!, room.behind!, room.left!, room.right!);

  // Incoming shots: arrows predicted to hit, and bows releasing before a lowered shield could be active again.
  const shots: { source: XYZ; ticks: number }[] = [];
  for (const arrow of snapshot.arrows) if (arrow.impactTicks !== null) shots.push({ source: arrow.position, ticks: arrow.impactTicks });
  for (const enemy of snapshot.enemies) {
    if (enemy.releaseIn !== null && enemy.releaseIn <= reguard) shots.push({ source: enemy.position, ticks: enemy.releaseIn });
  }
  row.n_shots = shots.length;
  row.n_shotsInArcNow = shots.filter((shot) => Math.abs(degreesBetween(facing, minus(shot.source, me))) < SHIELD_ARC_DEGREES).length;
  row.n_minShotTicks = shots.length ? Math.min(...shots.map((shot) => shot.ticks)) : NaN;

  // Enemies, one slot each in the lettered (nearest-first) order the face question uses.
  const enemies = snapshot.enemies.slice(0, MAX_ENEMY_SLOTS);
  const facedIndex = snapshot.enemies.findIndex((enemy) => enemy.id === b.facedId);
  row.b_facedSlot = facedIndex === -1 ? NaN : facedIndex;
  const faced = facedIndex === -1 ? undefined : snapshot.enemies[facedIndex];
  row.b_facedKind = faced ? kindOf(faced.name) : NaN;

  const ranged = (enemy: SnapshotEnemy) => enemy.ranged ?? enemy.held === "bow";
  const isMeleeEnemy = (enemy: SnapshotEnemy) => !ranged(enemy) && enemy.name !== "creeper";
  let meleeInReachThen = 0;
  let meleeConverging = 0;
  let otherMeleeInReachThen = 0;
  let nearestMeleeDist = NaN;
  let nearestMeleeFdist = NaN;
  let nearestMeleeTicksToReach = NaN;
  let minReleaseIn = NaN;
  let creeperLit = 0;
  let maxFuse = NaN;
  let creeperFdistMin = NaN;
  let creeperInFuseRangeThen = 0;
  let bombImminent = 0;
  let archers = 0;
  let creepers = 0;
  let meleeCount = 0;

  for (let slot = 0; slot < MAX_ENEMY_SLOTS; slot += 1) {
    const p = `e${slot}_`;
    const enemy = enemies[slot];
    for (const key of ENEMY_KEYS) row[p + key] = NaN;
    row[`${p}present`] = enemy ? 1 : 0;
    if (!enemy) continue;
    const d = minus(enemy.position, me);
    const then = minus(plusScaled(enemy.position, enemy.velocity, lead), meThen);
    const dist = flat(d);
    const fdist = flat(then);
    const fwalk = Math.max(0, fdist - walk);
    const freach = Math.hypot(fdist, then.y);
    const kind = kindOf(enemy.name);
    const isMelee = isMeleeEnemy(enemy);
    const toBot = minus(me, enemy.position);
    const speed = flat(enemy.velocity) * 20;
    const closing = dist > 0 ? ((enemy.velocity.x * toBot.x + enemy.velocity.z * toBot.z) / dist) * 20 : 0;
    const fuse = fuseOf(enemy);
    const hp = enemy.health ?? NaN;
    const attackReadyIn = !isMelee ? NaN : enemy.hitUsAgo === null ? 0 : Math.max(0, MOB_ATTACK_INTERVAL_TICKS - enemy.hitUsAgo - lead);

    row[`${p}kind`] = kind;
    row[`${p}hp`] = hp;
    row[`${p}dist`] = dist;
    row[`${p}dy`] = d.y;
    row[`${p}reachNow`] = Math.hypot(dist, d.y);
    row[`${p}fdist`] = fdist;
    row[`${p}fwalk`] = fwalk;
    row[`${p}freach`] = freach;
    row[`${p}fdy`] = then.y;
    const angle = dist < 0.6 ? 0 : degreesBetween(facing, d);
    row[`${p}angle`] = angle;
    row[`${p}absAngle`] = Math.abs(angle);
    row[`${p}speed`] = speed;
    row[`${p}closing`] = closing;
    row[`${p}lookAngle`] = Math.abs(degreesBetween(facingOf(enemy.yaw), toBot));
    row[`${p}hasBow`] = ranged(enemy) ? 1 : 0;
    row[`${p}drawing`] = enemy.drawing ? 1 : 0;
    row[`${p}releaseIn`] = enemy.releaseIn ?? NaN;
    row[`${p}hitUsAgo`] = enemy.hitUsAgo ?? NaN;
    row[`${p}hurtAgo`] = enemy.hurtAgo ?? NaN;
    row[`${p}attackReadyIn`] = attackReadyIn;
    row[`${p}attackReady`] = isMelee ? (attackReadyIn === 0 ? 1 : 0) : NaN;
    row[`${p}knockback`] = enemy.hurtAgo !== null && enemy.hurtAgo < 10 && closing < -0.5 ? 1 : 0;
    row[`${p}aggressive`] = enemy.states.includes("aggressive") ? 1 : 0;
    row[`${p}fuse`] = fuse ? fuse.fuse : NaN;
    row[`${p}lit`] = fuse ? (fuse.lit ? 1 : 0) : NaN;
    row[`${p}isFaced`] = enemy.id === b.facedId ? 1 : 0;
    row[`${p}inReachThen`] = freach <= REACH ? 1 : 0;
    row[`${p}inReachWalking`] = Math.hypot(fwalk, then.y) <= REACH ? 1 : 0;
    row[`${p}overlapping`] = isMelee && dist < OVERLAP_BLOCKS ? 1 : 0;
    row[`${p}belowHole`] = Math.round(d.y) <= -2 ? 1 : 0;
    row[`${p}nearlyDead`] = Number.isNaN(hp) ? NaN : hp <= 6 ? 1 : 0;
    row[`${p}los`] = enemy.los === undefined ? NaN : enemy.los ? 1 : 0;
    // Ticks until it is in reach at its current closing speed: 0 if already there, NaN if it is not closing.
    const ticksToReach = dist <= REACH ? 0 : closing > 0.1 ? ((dist - REACH) / closing) * 20 : NaN;
    row[`${p}ticksToReach`] = ticksToReach;
    if (shots.length) {
      const degrees = shots.map((shot) => (shot.source === enemy.position ? 0 : Math.abs(degreesBetween(d, minus(shot.source, me)))));
      row[`${p}shotDegIfFaced`] = Math.max(...degrees);
      row[`${p}coverIfFaced`] = degrees.every((deg) => deg < SHIELD_ARC_DEGREES) ? 1 : 0;
    }

    if (isMelee) {
      meleeCount += 1;
      nearestMeleeDist = nanMin(nearestMeleeDist, dist);
      nearestMeleeFdist = nanMin(nearestMeleeFdist, fdist);
      nearestMeleeTicksToReach = nanMin(nearestMeleeTicksToReach, ticksToReach);
      if (freach <= REACH) meleeInReachThen += 1;
      if (freach <= REACH && enemy.id !== b.facedId) otherMeleeInReachThen += 1;
      if (fdist <= REACH + 1.5) meleeConverging += 1;
    }
    if (ranged(enemy)) {
      archers += 1;
      if (enemy.releaseIn !== null) minReleaseIn = nanMin(minReleaseIn, enemy.releaseIn);
    }
    if (fuse) {
      creepers += 1;
      creeperLit = creeperLit || (fuse.lit ? 1 : 0);
      maxFuse = nanMax(maxFuse, fuse.fuse);
      creeperFdistMin = nanMin(creeperFdistMin, fdist);
      if (fdist <= CREEPER_FUSE_RANGE) creeperInFuseRangeThen = 1;
      if (fuse.lit && fuse.fuse >= 20) bombImminent = 1;
    }
  }
  row.n_enemies = snapshot.enemies.length;
  row.n_melee = meleeCount;
  row.n_archers = archers;
  row.n_creepers = creepers;
  row.n_meleeInReachThen = meleeInReachThen;
  row.n_otherMeleeInReachThen = otherMeleeInReachThen;
  row.n_meleeConverging = meleeConverging;
  row.n_nearestMeleeDist = nearestMeleeDist;
  row.n_nearestMeleeFdist = nearestMeleeFdist;
  row.n_nearestMeleeTicksToReach = nearestMeleeTicksToReach;
  row.n_minReleaseIn = minReleaseIn;
  row.n_archerFiresWithinWindow = !Number.isNaN(minReleaseIn) && minReleaseIn <= lead + 2 ? 1 : 0;
  row.n_archerFiresBeforeReguard = !Number.isNaN(minReleaseIn) && minReleaseIn <= reguard ? 1 : 0;
  row.n_creeperLit = creepers ? creeperLit : NaN;
  row.n_maxFuse = maxFuse;
  row.n_creeperFdistMin = creeperFdistMin;
  row.n_creeperInFuseRangeThen = creepers ? creeperInFuseRangeThen : NaN;
  row.n_bombImminent = creepers ? bombImminent : NaN;
  const facedKey = (key: string) => (faced && facedIndex < MAX_ENEMY_SLOTS ? row[`e${facedIndex}_${key}`]! : NaN);
  row.n_facedInReachThen = facedKey("inReachThen");
  row.n_facedOverlapping = facedKey("overlapping");
  row.n_facedAttackReadyIn = facedKey("attackReadyIn");
  row.n_facedFdist = facedKey("fdist");
  row.n_facedHasBow = facedKey("hasBow");
  row.n_facedBelowHole = facedKey("belowHole");
  row.n_facedTicksToReach = facedKey("ticksToReach");
  // Positive when the sword is ready before the faced mob's next swing: the window to strike first.
  row.n_swordBeforeFacedAttack = Number.isNaN(row.n_facedAttackReadyIn!) ? NaN : row.n_facedAttackReadyIn! - row.b_swordReadyAtEffect!;
  // Whether a step in each direction walks into a melee mob other than the faced one, as the "Ground and neighbours" line says.
  const moveVectors: Record<string, XYZ> = {
    forward: facing,
    back: { x: -facing.x, y: 0, z: -facing.z },
    left: { x: facing.z, y: 0, z: -facing.x },
    right: { x: -facing.z, y: 0, z: facing.x },
  };
  for (const [name, dir] of Object.entries(moveVectors)) {
    const walksInto = snapshot.enemies.some((enemy) => {
      if (enemy.id === b.facedId || ranged(enemy)) return false;
      const d = minus(enemy.position, me);
      const f = flat(d);
      return f <= walk + REACH + 1 && f > REACH && Math.abs(degreesBetween(dir, d)) <= 45;
    });
    row[`n_walksInto_${name}`] = walksInto ? 1 : 0;
  }

  // Arrows in flight: the ones predicted to hit first, then the nearest.
  const arrows = [...snapshot.arrows]
    .map((arrow) => ({ arrow, d: minus(arrow.position, me) }))
    .sort((a, b) => (a.arrow.impactTicks ?? 1e9) - (b.arrow.impactTicks ?? 1e9) || flat(a.d) - flat(b.d))
    .slice(0, MAX_ARROW_SLOTS);
  row.n_arrows = snapshot.arrows.length;
  row.n_arrowsHitting = snapshot.arrows.filter((arrow) => arrow.impactTicks !== null).length;
  row.n_minArrowImpact = row.n_arrowsHitting ? Math.min(...snapshot.arrows.map((arrow) => arrow.impactTicks ?? 1e9)) : NaN;
  for (let slot = 0; slot < MAX_ARROW_SLOTS; slot += 1) {
    const p = `a${slot}_`;
    for (const key of ARROW_KEYS) row[p + key] = NaN;
    const entry = arrows[slot];
    row[`${p}present`] = entry ? 1 : 0;
    if (!entry) continue;
    const angle = degreesBetween(facing, entry.d);
    row[`${p}dist`] = flat(entry.d);
    row[`${p}angle`] = angle;
    row[`${p}impact`] = entry.arrow.impactTicks ?? NaN;
    row[`${p}impactAfterEffect`] = entry.arrow.impactTicks === null ? NaN : entry.arrow.impactTicks - lead;
    row[`${p}willHit`] = entry.arrow.impactTicks === null ? 0 : 1;
    row[`${p}inArcNow`] = Math.abs(angle) < SHIELD_ARC_DEGREES ? 1 : 0;
    row[`${p}speed`] = Math.hypot(entry.arrow.velocity.x, entry.arrow.velocity.y, entry.arrow.velocity.z) * 20;
    // Newer snapshots: whether a step could walk into it, the way out, and whether the shield can be up by impact.
    const moving = entry.arrow.impactTicksMoving;
    row[`${p}impactMoving`] = moving === undefined ? NaN : moving ?? NaN;
    row[`${p}hitsIfMoving`] = moving === undefined ? NaN : moving !== null && entry.arrow.impactTicks === null ? 1 : 0;
    row[`${p}dodge`] = entry.arrow.dodge === undefined ? NaN : MOVE_CODES[entry.arrow.dodge] ?? NaN;
    row[`${p}shieldInTime`] = entry.arrow.impactTicks === null ? NaN : shieldActiveIn <= entry.arrow.impactTicks ? 1 : 0;
  }
  row.n_arrowsHitIfMoving = snapshot.arrows.some((arrow) => arrow.impactTicksMoving === undefined) ? NaN : snapshot.arrows.filter((arrow) => arrow.impactTicks === null && arrow.impactTicksMoving !== null).length;

  // Drawn bows: when the earliest shot can land (release plus flight at ARROW_SPEED) and whether the shield can be up by then.
  let minArrival = NaN;
  for (const enemy of snapshot.enemies) {
    if (enemy.releaseIn === null) continue;
    minArrival = nanMin(minArrival, enemy.releaseIn + Math.ceil(enemy.distance / ARROW_SPEED));
  }
  row.n_minArrival = minArrival;
  const earliest = nanMin(minArrival, row.n_minArrowImpact!);
  row.n_shieldInTime = Number.isNaN(earliest) ? NaN : shieldActiveIn <= earliest ? 1 : 0;
  // Ticks of slack between the shield being active and the earliest shot landing; negative means a raise now is too late.
  row.n_shieldMargin = Number.isNaN(earliest) ? NaN : earliest - shieldActiveIn;

  // Egocentric terrain and walls (newer snapshots; NaN in older logs).
  for (let i = 0; i < TERRAIN_CELLS.length; i += 1) {
    const cell = snapshot.terrain?.[i];
    row[`t_${TERRAIN_CELLS[i]}_h`] = cell === undefined ? NaN : cell.h === null ? -4 : cell.h;
    row[`t_${TERRAIN_CELLS[i]}_s`] = cell === undefined ? NaN : cell.s;
    row[`t_${TERRAIN_CELLS[i]}_z`] = cell === undefined ? NaN : cell.z;
  }
  const terrain = snapshot.terrain;
  row.t_standable = terrain === undefined ? NaN : terrain.filter((cell) => cell.s === 1).length;
  row.t_hazards = terrain === undefined ? NaN : terrain.filter((cell) => cell.z !== 0).length;
  for (const direction of WALL_DIRECTIONS) {
    const blocks = snapshot.walls?.[direction];
    row[`w_${direction.replace("-", "_")}`] = blocks === undefined ? NaN : blocks === null ? 17 : blocks;
  }
  row.w_nearest = snapshot.walls === undefined ? NaN : Math.min(...Object.values(snapshot.walls).map((blocks) => (blocks === null ? 17 : blocks)));
  row.n_archersWithLos = snapshot.enemies.some((enemy) => enemy.los === undefined) ? NaN : snapshot.enemies.filter((enemy) => ranged(enemy) && enemy.los).length;

  // The previous window, which the text reports as "Last answer applied".
  const prev = context.previous;
  row.p_move = codeOf(CLASSES.move, prev?.move);
  row.p_hands = codeOf(CLASSES.hands, prev?.hands);
  row.p_pace = codeOf(CLASSES.pace, prev?.pace);
  row.p_jump = prev ? (prev.jump ? 1 : 0) : NaN;
  row.p_swung = prev ? (prev.swung ? 1 : 0) : NaN;
  row.p_wasted = prev ? (prev.wasted ? 1 : 0) : NaN;

  return row;
}

/** The previous-window facts, from what the loop applied. */
export function previousOf(applied: { move: string; hands: string; pace: string; jump: boolean; swung: boolean; note?: string } | undefined): Previous | null {
  if (!applied) return null;
  return {
    move: applied.move,
    hands: applied.hands,
    pace: applied.pace,
    jump: applied.jump,
    swung: applied.swung,
    wasted: (applied.note ?? "").includes("wasted") || (applied.note ?? "").includes("cold"),
  };
}

/** Feature names in row order, from an empty snapshot; the trained model carries its own copy. */
export function featureNames(): string[] {
  const empty: Snapshot = {
    tick: 0,
    lead: 6,
    bot: {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      health: 20,
      food: 20,
      onGround: true,
      swordReadyIn: 0,
      shield: { up: false, activeIn: null, server: false },
      hurtAgo: null,
      lastHitBy: "nothing yet",
      facedId: -1,
    },
    enemies: [],
    arrows: [],
    ground: { ahead: "open floor for 3 blocks", behind: "open floor for 3 blocks", left: "open floor for 3 blocks", right: "open floor for 3 blocks" },
  };
  return Object.keys(featureRow(empty, { previous: null }));
}

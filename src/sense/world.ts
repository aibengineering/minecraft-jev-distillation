/**
 * What the bot reads off the world and the entities around it: who is
 * hostile, their health and states, the bot's own fire and wither, the
 * ground and terrain around it, walls, lines of sight, and everything in
 * flight with a prediction of where it lands. Pure reads; nothing here
 * decides or acts.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";

import { HOSTILES, PROBE_BLOCKS, REACH, SHIELD_ARC_DEGREES, TERRAIN_RADIUS, WALK_BLOCKS_PER_TICK, isProjectile, type MoveName } from "./constants.ts";
import { angleBetween, degreesBetween, distance, eyes, moveVectors } from "./geometry.ts";
import { arrowFlight } from "./perception/arrow-flight.ts";
import { arrowImpact } from "./perception/shield-projectiles.ts";


/** Living-entity health is metadata index 9 in 1.21.4; the entity object never copies it. */
export function health(entity: Entity): number | undefined {
  const value = (entity.metadata as unknown[] | undefined)?.[9];
  return typeof value === "number" ? value : undefined;
}

export function hostiles(bot: Bot): Entity[] {
  return Object.values(bot.entities)
    .filter(
      (entity) =>
        entity.isValid && entity.name !== undefined && HOSTILES.has(entity.name) && entity.id !== bot.entity.id && health(entity) !== 0,
    )
    .sort((a, b) => distance(bot, a) - distance(bot, b));
}

/** Blocks the bot stands below the surrounding ground when walled in on all four sides, or 0 when it is not. */
export function pitDepth(bot: Bot): number {
  const feet = bot.entity.position.floored();
  const blocked = (name: string | undefined) => name !== undefined && name !== "air" && name !== "cave_air";
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  let depth = 0;
  for (const side of sides) {
    let height = 0;
    while (height < 4 && blocked(bot.blockAt(feet.plus(side).offset(0, height, 0))?.name)) height += 1;
    if (height < 2) return 0;
    depth = depth === 0 ? height : Math.min(depth, height);
  }
  return depth;
}

/** Cobblestone the bot carries, for cover. */
export function cobblestone(bot: Bot): number {
  return bot.inventory.items().filter((item) => item.name === "cobblestone").reduce((sum, item) => sum + item.count, 0);
}

/** Whether the bot is burning: bit 0 of the shared entity flags. */
export function onFire(bot: Bot): boolean {
  const flags = (bot.entity.metadata as unknown[] | undefined)?.[0];
  return typeof flags === "number" && (flags & 1) !== 0;
}

/** Ticks of wither left on the bot, 0 when none; the effect is found by name through the registry, whatever its id. */
export function witherTicks(bot: Bot): number {
  const effects = (bot.entity as unknown as { effects?: Record<string, { id?: number; duration?: number }> }).effects ?? {};
  const registry = bot.registry as unknown as { effects?: Record<string, { name?: string; displayName?: string }> };
  for (const [key, effect] of Object.entries(effects)) {
    const id = effect.id ?? Number(key);
    const entry = registry.effects?.[id];
    const name = `${entry?.name ?? ""} ${entry?.displayName ?? ""}`.toLowerCase();
    if (name.includes("wither")) return effect.duration ?? 0;
  }
  return 0;
}

/** A blaze about to shoot: its flags byte (metadata 16) bit 0 is set while it flares up for a burst. */
export function blazeFlaring(enemy: Entity): boolean {
  const flags = (enemy.metadata as unknown[] | undefined)?.[16];
  return enemy.name === "blaze" && typeof flags === "number" && (flags & 1) !== 0;
}

/** Fireball positions by tick, since Mineflayer's velocity for a fireball is stale: the flight is read from successive positions. */
const fireballTrail = new Map<number, { position: Vec3; tick: number; velocity: Vec3 }>();

let physicsTicks = 0;

/** A fireball's velocity from its last two observed positions, when Mineflayer's own value is stale. */
export function fireballVelocity(entity: Entity): Vec3 {
  const known = fireballTrail.get(entity.id);
  if (known && known.velocity.norm() > 0.05) return known.velocity;
  return entity.velocity;
}

/**
 * Ticks until a straight-flying projectile (a blaze fireball) meets the
 * bot's box widened by `allowance`, or null when it misses or hits a block
 * first. Steps the last known position along its velocity for eighty ticks.
 */
export function straightImpact(bot: Bot, projectile: Entity, allowance = 0): number | null {
  const me = bot.entity.position;
  const half = bot.entity.width / 2 + allowance + 0.3;
  const height = bot.entity.height;
  let position = projectile.position.clone();
  const velocity = fireballVelocity(projectile).clone();
  const speed = velocity.norm();
  if (speed < 0.01) return null;
  for (let ticks = 1; ticks <= 80; ticks += 1) {
    if (bot.world.raycast(position, velocity.scaled(1 / speed), speed)) return null;
    position = position.plus(velocity);
    const dx = position.x - me.x, dz = position.z - me.z, dy = position.y - me.y;
    if (Math.abs(dx) <= half && Math.abs(dz) <= half && dy >= -0.3 && dy <= height + 0.3) return ticks;
  }
  return null;
}

/** The first thing that is not walkable floor in a direction, or "open floor" for PROBE_BLOCKS steps. */
export function probe(bot: Bot, yaw: number, direction: "ahead" | "behind" | "left" | "right"): string {
  const forward = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const step = {
    ahead: forward,
    behind: forward.scaled(-1),
    left: new Vec3(forward.z, 0, -forward.x),
    right: new Vec3(-forward.z, 0, forward.x),
  }[direction];
  const feet = bot.entity.position.floored();
  for (let n = 1; n <= PROBE_BLOCKS; n += 1) {
    const cell = feet.plus(step.scaled(n)).floored();
    const at = (dy: number) => bot.blockAt(cell.offset(0, dy, 0))?.name ?? "unknown";
    const below = at(-1);
    if (below === "lava" || at(0) === "lava") return `lava at ${n}`;
    if (below === "water" || at(0) === "water") return `water at ${n}`;
    if (below === "magma_block") return `magma at ${n}`;
    const blocked = (name: string) => name !== "air" && name !== "cave_air";
    if (blocked(at(0)) && !blocked(at(1))) return `one-block step up at ${n}`;
    if (blocked(at(0)) || blocked(at(1))) return `wall at ${n}`;
    if (!blocked(below)) {
      const depth = [1, 2, 3].find((dy) => blocked(at(-1 - dy)));
      return `drop of ${depth === undefined ? "more than 3" : depth} at ${n}`;
    }
  }
  return `open floor for ${PROBE_BLOCKS} blocks`;
}

/**
 * Distance in blocks to the nearest wall in eight directions around the
 * facing, walking cells at body height up to `limit`. "wall" is anything
 * solid two high; a one-block step is not a wall.
 */
/**
 * The terrain around the bot as a grid rotated to its facing, ahead first
 * and left to right, so the same cell means the same thing whichever way
 * the bot looks. Each cell: the floor height relative to the bot's feet
 * (null for a drop deeper than three), whether the bot could stand there
 * (a floor within one up and headroom above it), and a hazard code.
 */
export function terrainGrid(bot: Bot): { df: number; dr: number; h: number | null; standable: boolean; hazard: "none" | "lava" | "water" | "magma" }[] {
  const yaw = bot.entity.yaw;
  const facing = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new Vec3(-facing.z, 0, facing.x);
  const feet = bot.entity.position.floored();
  const name = (x: number, y: number, z: number) => bot.blockAt(new Vec3(x, y, z))?.name ?? "unknown";
  const solid = (n: string) => n !== "air" && n !== "cave_air" && n !== "water" && n !== "lava";
  const cells = [];
  for (let df = TERRAIN_RADIUS; df >= -TERRAIN_RADIUS; df -= 1) {
    for (let dr = -TERRAIN_RADIUS; dr <= TERRAIN_RADIUS; dr += 1) {
      const cell = bot.entity.position.plus(facing.scaled(df)).plus(right.scaled(dr)).floored();
      let h: number | null = null;
      for (let y = feet.y + 2; y >= feet.y - 4; y -= 1) {
        if (solid(name(cell.x, y, cell.z))) {
          h = y + 1 - feet.y;
          break;
        }
      }
      const floorY = h === null ? null : feet.y + h;
      let hazard: "none" | "lava" | "water" | "magma" = "none";
      for (let y = feet.y + 1; y >= feet.y - 4; y -= 1) {
        const n = name(cell.x, y, cell.z);
        if (n === "lava") hazard = "lava";
        else if (n === "water" && hazard === "none") hazard = "water";
        else if (n === "magma_block" && hazard === "none") hazard = "magma";
        if (solid(n)) break;
      }
      const standable = floorY !== null && h! <= 1 && !solid(name(cell.x, floorY, cell.z)) && !solid(name(cell.x, floorY + 1, cell.z)) && hazard === "none";
      cells.push({ df, dr, h, standable, hazard });
    }
  }
  return cells;
}

/** Whether the bot's eyes can see the enemy's: one block ray between them. */
export function lineOfSight(bot: Bot, enemy: Entity): boolean {
  const from = eyes(bot.entity);
  const to = eyes(enemy);
  const d = to.minus(from);
  const dist = d.norm();
  if (dist === 0) return true;
  return bot.world.raycast(from, d.scaled(1 / dist), dist) === null;
}

export function wallDistances(bot: Bot, limit = 16): { direction: string; move: MoveName; blocks: number | null }[] {
  const yaw = bot.entity.yaw;
  const facing = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new Vec3(-facing.z, 0, facing.x);
  const feet = bot.entity.position.floored();
  const solid = (name: string | undefined) => name !== undefined && name !== "air" && name !== "cave_air";
  const rays: [string, MoveName, Vec3][] = [
    ["ahead", "forward", facing],
    ["ahead-right", "forward", facing.plus(right)],
    ["right", "right", right],
    ["behind-right", "back", right.minus(facing)],
    ["behind", "back", facing.scaled(-1)],
    ["behind-left", "back", facing.plus(right).scaled(-1)],
    ["left", "left", right.scaled(-1)],
    ["ahead-left", "forward", facing.minus(right)],
  ];
  return rays.map(([direction, move, dir]) => {
    const unit = dir.scaled(1 / dir.norm());
    for (let n = 1; n <= limit; n += 1) {
      const cell = feet.plus(unit.scaled(n)).floored();
      if (solid(bot.blockAt(cell.offset(0, 1, 0))?.name) && solid(bot.blockAt(cell)?.name)) return { direction, move, blocks: n };
    }
    return { direction, move, blocks: null };
  });
}

export interface ArrowThreat {
  id: number;
  /** "arrow", "spectral_arrow" or "small_fireball". */
  kind: string;
  position: Vec3;
  velocity: Vec3;
  /** Ticks until it lands on the bot standing still, or null for a miss. */
  impactTicks: number | null;
  /** The same with the bot's box widened by this window's walk: null means it misses even if the bot moves. */
  impactTicksMoving: number | null;
  /** Signed degrees from the facing to the arrow, so negative is left. */
  degrees: number;
  inArc: boolean;
  /** The move that carries the bot away from the arrow's line; its opposite walks into it. */
  dodge: MoveName;
}

/**
 * Every arrow in flight with both impact predictions and the way out of its
 * line. The still prediction is what "hits in N ticks" means; the moving one
 * catches the case the still one hides: an arrow that misses a standing bot
 * but not one that sidesteps into it during the window.
 */
export function assessArrows(bot: Bot, walkTicks: number): ArrowThreat[] {
  const me = bot.entity.position;
  const yaw = bot.entity.yaw;
  const allowance = WALK_BLOCKS_PER_TICK * walkTicks;
  const threats: ArrowThreat[] = [];
  for (const arrow of Object.values(bot.entities)) {
    if (!arrow.isValid || !isProjectile(arrow.name)) continue;
    const fireball = arrow.name === "small_fireball";
    const flight = fireball ? { position: arrow.position, velocity: fireballVelocity(arrow) } : arrowFlight(bot, arrow);
    if (flight.velocity.norm() === 0) continue;
    const d = flight.position.minus(me);
    // Which side of the arrow's line the bot is on, seen from above along the arrow's heading; moving further that way clears it.
    const v = flight.velocity;
    const cross = v.x * -d.z - v.z * -d.x;
    const away = new Vec3(-v.z, 0, v.x).scaled(cross >= 0 ? 1 : -1);
    const dodge = moveVectors(yaw).sort((a, b) => b[1].dot(away) - a[1].dot(away))[0]![0];
    threats.push({
      id: arrow.id,
      kind: arrow.name ?? "arrow",
      position: flight.position,
      velocity: flight.velocity,
      impactTicks: fireball ? straightImpact(bot, arrow) : arrowImpact(bot, arrow)?.ticks ?? null,
      impactTicksMoving: fireball ? straightImpact(bot, arrow, allowance) : arrowImpact(bot, arrow, allowance)?.ticks ?? null,
      degrees: Math.round(angleBetween(yaw, d)),
      inArc: Math.abs(angleBetween(yaw, d)) < SHIELD_ARC_DEGREES,
      dodge,
    });
  }
  return threats;
}

/** Installs the per-tick fireball trail; Mineflayer keeps a fireball's spawn velocity, so its flight is read from where it is seen. */
export function trackFireballs(bot: Bot): void {
  bot.on("physicsTick", () => {
    physicsTicks += 1;
    for (const entity of Object.values(bot.entities)) {
      if (!entity.isValid || entity.name !== "small_fireball") continue;
      const known = fireballTrail.get(entity.id);
      if (known && known.position.equals(entity.position)) continue;
      const velocity = known ? entity.position.minus(known.position).scaled(1 / Math.max(1, physicsTicks - known.tick)) : entity.velocity;
      fireballTrail.set(entity.id, { position: entity.position.clone(), tick: physicsTicks, velocity });
    }
    for (const id of fireballTrail.keys()) if (!bot.entities[id]?.isValid) fireballTrail.delete(id);
  });
}

/**
 * Where and when an arrow in flight lands on the bot. Ported from
 * mine-ai-mcp's combat perception, with the ray-versus-box test inlined.
 *
 * Arrows curve under gravity, so the flight is stepped tick by tick with the
 * game's drag and gravity, testing each step against the bot's box expanded
 * by vanilla's projectile hit margin and clipped by terrain. The loop stops
 * once the arrow has passed the box, fallen below it, or hit a block, rather
 * than predicting an arbitrary number of ticks ahead.
 */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { arrowFlight } from "./arrow-flight.ts";
import { PROJECTILE_HIT_MARGIN } from "./constants.ts";

type Entity = Parameters<Bot["attack"]>[0];

export interface EntityBody {
  readonly position: Vec3;
  readonly width: number;
  readonly height: number;
}

interface CollisionBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * Distance along a ray to the nearest entry into any of the boxes placed at
 * `cell`, or null when the ray misses them all: the slab test, one axis at a
 * time, narrowing the interval of the ray that lies inside the box.
 */
function boxEntry(boxes: readonly CollisionBox[], cell: { x: number; y: number; z: number }, from: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): number | null {
  let nearest: number | null = null;
  let entry = 0;
  let exit = 0;
  let missed = false;
  const narrow = (min: number, max: number, origin: number, along: number) => {
    if (along === 0) {
      if (origin < min || origin > max) missed = true;
      return;
    }
    const near = (min - origin) / along;
    const far = (max - origin) / along;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
  };
  for (const box of boxes) {
    entry = Number.NEGATIVE_INFINITY;
    exit = Number.POSITIVE_INFINITY;
    missed = false;
    narrow(cell.x + box.minX, cell.x + box.maxX, from.x, direction.x);
    if (missed) continue;
    narrow(cell.y + box.minY, cell.y + box.maxY, from.y, direction.y);
    if (missed) continue;
    narrow(cell.z + box.minZ, cell.z + box.maxZ, from.z, direction.z);
    if (missed) continue;
    const hit = Math.max(entry, 0);
    if (exit < hit) continue;
    if (nearest === null || hit < nearest) nearest = hit;
  }
  return nearest;
}

/** Exact entry point into vanilla's expanded target box, clipped by terrain. */
function projectileContact(
  world: Bot["world"],
  projectile: { readonly position: Vec3; readonly velocity: Vec3 },
  body: EntityBody,
  maximumDistance = Infinity,
): Vec3 | null {
  const speed = projectile.velocity.norm();
  if (speed === 0) return null;
  const direction = projectile.velocity.scaled(1 / speed);
  const half = body.width / 2 + PROJECTILE_HIT_MARGIN;
  const distance = boxEntry(
    [{ minX: -half, maxX: half, minY: -PROJECTILE_HIT_MARGIN, maxY: body.height + PROJECTILE_HIT_MARGIN, minZ: -half, maxZ: half }],
    body.position,
    projectile.position,
    direction,
  );
  return distance !== null && distance <= maximumDistance && world.raycast(projectile.position, direction, distance) === null
    ? projectile.position.plus(direction.scaled(distance))
    : null;
}

/** Ticks until the arrow hits the body and where, or null when it will miss, is stuck, or pierces. */
export function arrowImpact(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity) {
  if (!arrow.isValid || (arrow.name !== "arrow" && arrow.name !== "spectral_arrow")) return null;
  const keys = bot.registry.entitiesByName[arrow.name]?.metadataKeys ?? [];
  const grounded: unknown = arrow.metadata?.[keys.indexOf("in_ground")];
  const piercing: unknown = arrow.metadata?.[keys.indexOf("pierce_level")];
  if (grounded === true || (typeof piercing === "number" && piercing > 0) || arrow.velocity.norm() === 0) return null;
  const body = { position: target.position, width: target.width + movementAllowance * 2, height: target.height };
  let { position, velocity } = arrowFlight(bot, arrow);
  if (velocity.norm() === 0) return null;
  const half = body.width / 2 + PROJECTILE_HIT_MARGIN;
  // A deflected arrow can still be inside the expanded box; its zero-distance
  // intersection is not a new incoming hit. Keep vertical falls.
  const towardX = body.position.x - position.x, towardZ = body.position.z - position.z;
  if (
    Math.abs(towardX) <= half &&
    Math.abs(towardZ) <= half &&
    position.y >= body.position.y - PROJECTILE_HIT_MARGIN &&
    position.y <= body.position.y + body.height + PROJECTILE_HIT_MARGIN &&
    towardX * velocity.x + towardZ * velocity.z < 0
  ) {
    return null;
  }
  for (let ticks = 0; ; ticks++) {
    const dx = body.position.x - position.x, dz = body.position.z - position.z;
    // Horizontal drag cannot reverse an arrow: stop once it has passed the
    // footprint, fallen below it, or hit terrain.
    if ((Math.abs(dx) > half && dx * velocity.x <= 0) || (Math.abs(dz) > half && dz * velocity.z <= 0) || (position.y < body.position.y - PROJECTILE_HIT_MARGIN && velocity.y <= 0)) {
      return null;
    }
    const speed = velocity.norm();
    const contact = projectileContact(bot.world, { position, velocity }, body, speed);
    if (contact) return { ticks: ticks + 1, position: contact };
    if (speed > 0 && bot.world.raycast(position, velocity.scaled(1 / speed), speed)) return null;
    position = position.plus(velocity);
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
}

/** Vectors, bearings and the small conversions the sensing and the text share. */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";

import { SHIELD_ARC_DEGREES, type MoveName } from "./constants.ts";


export function eyes(entity: Entity): Vec3 {
  return entity.position.offset(0, (entity.height ?? 1.8) * 0.85, 0);
}

export function distance(bot: Bot, entity: Entity): number {
  return bot.entity.position.distanceTo(entity.position);
}

/** Where something will be after `lead` ticks if it keeps its current velocity. */
export function forecast(entity: Entity, lead: number): Vec3 {
  return entity.position.plus(entity.velocity.scaled(lead));
}

export function vec(p: Vec3): { x: number; y: number; z: number } {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 };
}

export function coords(p: Vec3): string {
  return `${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`;
}

export function ticksText(n: number): string {
  return `${n} tick${n === 1 ? "" : "s"}`;
}

/** Signed degrees from one horizontal direction to another, positive clockwise viewed from above. */
export function degreesBetween(from: Vec3, to: Vec3): number {
  return (Math.atan2(from.x * to.z - from.z * to.x, from.x * to.x + from.z * to.z) * 180) / Math.PI;
}

/** Signed degrees from a yaw's facing to a vector: positive is to the right (east when facing north). */
export function angleBetween(yaw: number, d: Vec3): number {
  // Mineflayer yaw: 0 faces north (-z); the forward vector is (-sin yaw, -cos yaw), as bot.lookAt derives it.
  const facing = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
  return (Math.atan2(facing.x * d.z - facing.z * d.x, facing.x * d.x + facing.z * d.z) * 180) / Math.PI;
}

export function relativeBearing(yaw: number, d: Vec3): string {
  const angle = angleBetween(yaw, d);
  const abs = Math.abs(angle);
  if (abs <= 30) return "straight ahead";
  if (abs >= 150) return "directly behind";
  const side = angle < 0 ? "left" : "right";
  return abs < 90 ? `ahead and to the ${side}` : `behind and to the ${side}`;
}

/** The four moves as world directions for the current facing. */
export function moveVectors(yaw: number): [MoveName, Vec3][] {
  const facing = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
  return [["forward", facing], ["back", facing.scaled(-1)], ["left", new Vec3(facing.z, 0, -facing.x)], ["right", new Vec3(-facing.z, 0, facing.x)]];
}

/** Where a shot from `source` reads relative to a facing toward `target`: covered by the shield arc or not. */
export function arcCover(bot: Bot, target: Vec3, source: Vec3): { degrees: number; covered: boolean } {
  const me = bot.entity.position;
  const degrees = Math.round(degreesBetween(target.minus(me), source.minus(me)));
  return { degrees, covered: Math.abs(degrees) < SHIELD_ARC_DEGREES };
}

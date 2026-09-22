/**
 * The decision snapshot: the same facts as the text, as numbers. This is what
 * the log keeps, what the feature row is computed from, and what a replayed
 * fight rebuilds its samples from, so it is the contract between the live
 * loop and everything offline.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

import { currentWindow, walkTicks } from "../regime.ts";
import { SWORD_COOLDOWN_TICKS, SHIELD_READY_TICKS, WALK_BLOCKS_PER_TICK, isRanged } from "./constants.ts";
import { angleBetween, forecast, relativeBearing, vec } from "./geometry.ts";
import type { Clocks } from "./clocks.ts";
import { enemyFacing, enemyMotion, enemyState } from "./describe.ts";
import { bowReleaseInTicks } from "./perception/bow-timing.ts";
import { isDrawingBow } from "./perception/attention.ts";
import { assessArrows, cobblestone, health, lineOfSight, onFire, pitDepth, probe, terrainGrid, wallDistances, witherTicks } from "./world.ts";
import type { Snapshot } from "./features.ts";


/** The same facts as the text, as numbers, for the viewer's replay. */
export type SnapshotData = ReturnType<typeof snapshotData>;

export function snapshotData(bot: Bot, clocks: Clocks, lead: number, labelled: readonly { enemy: Entity; label: string }[], faced: Entity) {
  const me = bot.entity.position;
  const yaw = bot.entity.yaw;
  const sinceSwing = clocks.since(clocks.lastSwing);
  const sinceRaised = clocks.since(clocks.shieldRaised);
  return {
    tick: clocks.tick,
    lead,
    regime: currentWindow().regime,
    hold: currentWindow().hold,
    bot: {
      position: vec(me),
      velocity: vec(bot.entity.velocity),
      yaw: Math.round(yaw * 1000) / 1000,
      health: bot.health,
      food: bot.food,
      onGround: bot.entity.onGround,
      held: bot.heldItem?.name ?? null,
      swordReadyIn: sinceSwing === null ? 0 : Math.max(0, SWORD_COOLDOWN_TICKS - sinceSwing),
      shield: {
        up: bot.usingHeldItem,
        activeIn: !bot.usingHeldItem || sinceRaised === null ? null : Math.max(0, SHIELD_READY_TICKS - sinceRaised),
        server: clocks.serverShieldUp(),
      },
      hurtAgo: clocks.since(clocks.botHurt),
      lastHitBy: clocks.lastHitBy,
      facedId: faced.id,
      pitDepth: pitDepth(bot),
      cobblestone: cobblestone(bot),
      onFire: onFire(bot),
      witherTicks: witherTicks(bot),
    },
    enemies: labelled.map(({ enemy, label }) => {
      const d = enemy.position.minus(me);
      const then = forecast(enemy, lead).minus(forecast(bot.entity, lead));
      return {
        id: enemy.id,
        label,
        name: enemy.name ?? "unknown",
        position: vec(enemy.position),
        velocity: vec(enemy.velocity),
        yaw: Math.round(enemy.yaw * 1000) / 1000,
        health: health(enemy) ?? null,
        /** The held item, or "fireballs" for a blaze, so every reader that keys on a bow keys on a blaze too. */
        held: enemy.name === "blaze" ? "fireballs" : enemy.heldItem?.name ?? null,
        ranged: isRanged(enemy),
        distance: Math.round(Math.hypot(d.x, d.z) * 100) / 100,
        forecastDistance: Math.round(Math.hypot(then.x, then.z) * 100) / 100,
        forecastDistanceWalking: Math.round(Math.max(0, Math.hypot(then.x, then.z) - WALK_BLOCKS_PER_TICK * walkTicks(lead)) * 100) / 100,
        /** Straight-line distance when the answer lands, which is what a sword swing is measured by. */
        forecastReach: Math.round(Math.hypot(then.x, then.y, then.z) * 100) / 100,
        heightDifference: Math.round(d.y * 10) / 10,
        bearing: Math.hypot(d.x, d.z) < 0.6 ? "overlapping" : relativeBearing(yaw, d),
        /** Signed degrees from the facing, negative left; what the shield arc and the bow lines are measured by. */
        degrees: Math.round(angleBetween(yaw, d)),
        facing: enemyFacing(enemy, me),
        motion: enemyMotion(enemy, me, clocks),
        states: enemyState(bot, enemy, clocks),
        drawing: isDrawingBow(bot, enemy),
        releaseIn: isDrawingBow(bot, enemy) ? bowReleaseInTicks(bot, enemy) : null,
        hitUsAgo: clocks.since(clocks.hitUs.get(enemy.id) ?? null),
        hurtAgo: clocks.since(clocks.hurt.get(enemy.id) ?? null),
        /** Whether the bot's eyes see the enemy's; false behind a placed or standing block. */
        los: lineOfSight(bot, enemy),
      };
    }),
    arrows: assessArrows(bot, walkTicks(lead)).map((arrow) => ({
      id: arrow.id,
      kind: arrow.kind,
      position: vec(arrow.position),
      velocity: vec(arrow.velocity),
      impactTicks: arrow.impactTicks,
      impactTicksMoving: arrow.impactTicksMoving,
      degrees: arrow.degrees,
      inArc: arrow.inArc,
      dodge: arrow.dodge as string,
    })),
    ground: Object.fromEntries((["ahead", "behind", "left", "right"] as const).map((direction) => [direction, probe(bot, yaw, direction)])) as Snapshot["ground"],
    /** Egocentric five-by-five terrain, ahead first then left to right: floor height delta, standable, hazard. */
    terrain: terrainGrid(bot).map((cell) => ({ h: cell.h, s: cell.standable ? 1 : 0, z: cell.hazard === "lava" ? 1 : cell.hazard === "water" ? 2 : cell.hazard === "magma" ? 3 : 0 })),
    /** Blocks to the nearest wall in eight directions from the facing, null beyond 16. */
    walls: Object.fromEntries(wallDistances(bot).map((wall) => [wall.direction, wall.blocks])) as Record<string, number | null>,
  };
}

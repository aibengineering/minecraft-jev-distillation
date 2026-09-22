/**
 * The clocks, distances and kinds the sensing, the text and the feature row
 * all agree on. Everything a reviewer should look at first is here.
 */
import type { Entity } from "prismarine-entity";

export { SHIELD_READY_TICKS, PROJECTILE_HIT_MARGIN } from "./perception/constants.ts";


export const REACH = 3;

export const PROBE_BLOCKS = 3;

/** Diamond sword: 1.6 attacks a second at full damage. */
export const SWORD_COOLDOWN_TICKS = 13;

/** Vanilla invulnerability after any hit. */
export const HURT_INVULNERABLE_TICKS = 10;

/** A melee mob that has just hit cannot hit again for this long. */
export const MOB_ATTACK_INTERVAL_TICKS = 20;

/** A raised shield blocks a source within this many degrees either side of where the bot looks. */
export const SHIELD_ARC_DEGREES = 90;

/** Inside this range a melee mob shares the bot's space: a swing barely knocks it back and the shield cannot block it. */
export const OVERLAP_BLOCKS = 1.0;

/** A creeper starts its fuse within this many blocks of the bot. */
export const CREEPER_FUSE_RANGE = 3;

/** The fuse counter climbs one a tick while swelling and falls one a tick otherwise; it explodes at this value. */
export const CREEPER_FUSE_TICKS = 30;

/** Walking speed on flat ground, for the forecast of what "forward" closes. */
export const WALK_BLOCKS_PER_TICK = 0.215;

/** A mob hurt this recently and moving away is flying from knockback, not retreating. */
export const KNOCKBACK_TICKS = 10;

/** A skeleton's arrow leaves the bow at about this many blocks a tick, so at D blocks it lands about D / 1.6 ticks after release. */
export const ARROW_SPEED = 1.6;

/** Half-width of the egocentric terrain grid: two blocks each way, a five-by-five window. */
export const TERRAIN_RADIUS = 2;

export const HOSTILES = new Set(["zombie", "skeleton", "spider", "creeper", "husk", "drowned", "zombie_villager", "stray", "pillager", "wither_skeleton", "blaze"]);

/** Things in flight the bot can be hit by: arrows fall under gravity, a blaze's small fireballs fly straight. */
export const PROJECTILES = new Set(["arrow", "spectral_arrow", "small_fireball"]);

export const isProjectile = (name: string | undefined) => name !== undefined && PROJECTILES.has(name);

/** Ranged enemies: bows, and a blaze, which shoots fireballs in bursts of three. */
export const isRanged = (enemy: Entity) => enemy.heldItem?.name === "bow" || enemy.name === "blaze";

export type MoveName = "forward" | "back" | "left" | "right";

/** Declared above the top-level await that runs the fight: a const below it would still be uninitialised while the loop runs. */
export const OPPOSITE: Record<MoveName, MoveName> = { forward: "back", back: "forward", left: "right", right: "left" };

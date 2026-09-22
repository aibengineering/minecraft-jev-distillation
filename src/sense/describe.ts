/**
 * The fight as prose for jev: the snapshot line by line, the enemies, what is
 * in flight, the ground and terrain, and the "right now" sentence carrying the
 * facts a decision turns on. Every number here has a twin in the snapshot.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";

import { currentWindow, reguardTicks, walkTicks } from "../regime.ts";
import { questions, situation } from "../decide/prompt.ts";
import {
  ARROW_SPEED, CREEPER_FUSE_RANGE, CREEPER_FUSE_TICKS, HURT_INVULNERABLE_TICKS, KNOCKBACK_TICKS, MOB_ATTACK_INTERVAL_TICKS, OPPOSITE, OVERLAP_BLOCKS,
  REACH, SHIELD_ARC_DEGREES, SHIELD_READY_TICKS, SWORD_COOLDOWN_TICKS, WALK_BLOCKS_PER_TICK, isProjectile, isRanged, type MoveName,
} from "./constants.ts";
import { angleBetween, arcCover, coords, degreesBetween, distance, forecast, relativeBearing, ticksText } from "./geometry.ts";
import type { Clocks } from "./clocks.ts";
import type { SnapshotData } from "./snapshot.ts";
import { arrowFlight } from "./perception/arrow-flight.ts";
import { isDrawingBow } from "./perception/attention.ts";
import { bowReleaseInTicks } from "./perception/bow-timing.ts";
import { isSwelling } from "./perception/creepers.ts";
import { arrowImpact } from "./perception/shield-projectiles.ts";
import { assessArrows, blazeFlaring, cobblestone, health, hostiles, lineOfSight, onFire, pitDepth, probe, straightImpact, terrainGrid, wallDistances, witherTicks } from "./world.ts";


/**
 * Whether the shield can be up in time for something landing in `ticks`
 * (counted from the snapshot), as text: active already, active in time, or
 * too late, in which case a raise now blocks nothing and a sidestep is the
 * answer. A raise applied by this answer is active SHIELD_READY_TICKS after
 * it lands.
 */
export function shieldTiming(bot: Bot, clocks: Clocks, lead: number, ticks: number): { inTime: boolean; text: string } {
  const sinceRaised = clocks.since(clocks.shieldRaised);
  const activeIn = bot.usingHeldItem && sinceRaised !== null ? Math.max(0, SHIELD_READY_TICKS - sinceRaised) : lead + SHIELD_READY_TICKS;
  if (bot.usingHeldItem && activeIn === 0) return { inTime: true, text: "the shield is already active" };
  if (activeIn <= ticks) return { inTime: true, text: bot.usingHeldItem ? `the shield is active in ${ticksText(activeIn)}, in time` : `a shield raised now is active in ${ticksText(activeIn)}, in time` };
  return { inTime: false, text: bot.usingHeldItem ? `the shield is active only in ${ticksText(activeIn)}, too late` : `a shield raised now is active only in ${ticksText(activeIn)}, too late to block it` };
}

/** The incoming shots worth covering: arrows predicted to hit, and archers releasing within the re-guard span. */
export function incomingShots(bot: Bot, lead: number): { label: string; source: Vec3; when: string }[] {
  const shots: { label: string; source: Vec3; when: string }[] = [];
  for (const arrow of Object.values(bot.entities)) {
    if (!arrow.isValid || !isProjectile(arrow.name)) continue;
    const ticks = arrow.name === "small_fireball" ? straightImpact(bot, arrow) : arrowImpact(bot, arrow)?.ticks ?? null;
    if (ticks === null) continue;
    shots.push({ label: arrow.name === "small_fireball" ? "a fireball in flight" : "an arrow in flight", source: arrowFlight(bot, arrow).position, when: `hits in ${ticksText(Math.max(0, ticks - lead))}` });
  }
  for (const enemy of hostiles(bot)) {
    if (blazeFlaring(enemy)) {
      shots.push({ label: "the blaze's burst", source: enemy.position, when: "fires within about 10 ticks, three fireballs" });
      continue;
    }
    if (!isDrawingBow(bot, enemy)) continue;
    const release = bowReleaseInTicks(bot, enemy);
    if (release === null || release > reguardTicks(lead)) continue;
    shots.push({ label: `the ${enemy.name}'s shot`, source: enemy.position, when: release === 0 ? "fires any moment" : `fires in about ${ticksText(release)}` });
  }
  return shots;
}

/**
 * Arrows in flight, with the package's own impact prediction: when one lands
 * on the bot if nothing changes, or that it will miss.
 */
export function arrowLines(bot: Bot, clocks: Clocks, yaw: number, lead: number): string[] {
  const me = bot.entity.position;
  const arrows = Object.values(bot.entities).filter((entity) => entity.isValid && isProjectile(entity.name) && arrowFlight(bot, entity).velocity.norm() > 0);
  if (arrows.length === 0) return ["Arrows in flight: none."];
  return [
    "Arrows in flight:",
    ...assessArrows(bot, walkTicks(lead)).map((arrow) => {
      const d = arrow.position.minus(me);
      const noun = arrow.kind === "small_fireball" ? "fireball" : "arrow";
      const where = `${Math.hypot(d.x, d.z).toFixed(1)} blocks ${relativeBearing(yaw, d)}${arrow.kind === "small_fireball" ? " (flies straight, sets the bot on fire)" : ""}`;
      const cover = arrow.inArc ? "inside the shield arc for the current facing" : "outside the shield arc for the current facing, a raised shield would not stop it";
      if (arrow.impactTicks === null) {
        return arrow.impactTicksMoving === null
          ? `- ${noun} ${where}, misses even if the bot moves`
          : `- ${noun} ${where}, misses if the bot holds still but passes within a step on the ${OPPOSITE[arrow.dodge]} side: moving ${OPPOSITE[arrow.dodge]} this window walks into it, ${cover}`;
      }
      const after = arrow.impactTicks - lead;
      const shield = shieldTiming(bot, clocks, lead, arrow.impactTicks);
      const when = after <= 0 ? "predicted to hit the bot before the answer takes effect" : `predicted to hit the bot ${ticksText(after)} after the answer takes effect`;
      return `- ${noun} ${where}, ${when}, ${cover}; ${arrow.inArc ? shield.text : "guarding blocks nothing from it unless the bot turns to it"}; stepping ${arrow.dodge} takes the bot out of its line`;
    }),
  ];
}

/** The terrain cells worth a word, one note per kind: where it lies and how near. */
export function terrainText(cells: ReturnType<typeof terrainGrid>): string {
  const sector = (df: number, dr: number) => {
    const fb = df > 0 ? "ahead" : df < 0 ? "behind" : "";
    const lr = dr < 0 ? "left" : dr > 0 ? "right" : "";
    return fb && lr ? `${fb}-${lr}` : fb || lr;
  };
  const kinds = new Map<string, { sectors: Set<string>; nearest: number }>();
  for (const cell of cells) {
    if (cell.df === 0 && cell.dr === 0) continue;
    let kind: string | null = null;
    if (cell.hazard !== "none") kind = cell.hazard;
    else if (cell.h === null) kind = "drop of more than 3";
    else if (cell.h >= 2 || (cell.h === 1 && !cell.standable)) kind = "wall";
    else if (cell.h === 1) kind = "step up";
    else if (cell.h < 0) kind = `drop of ${-cell.h}`;
    else if (!cell.standable) kind = "blocked";
    if (kind === null) continue;
    const entry = kinds.get(kind) ?? { sectors: new Set<string>(), nearest: Number.POSITIVE_INFINITY };
    entry.sectors.add(sector(cell.df, cell.dr));
    entry.nearest = Math.min(entry.nearest, Math.max(Math.abs(cell.df), Math.abs(cell.dr)));
    kinds.set(kind, entry);
  }
  if (kinds.size === 0) return "flat and open";
  return [...kinds.entries()].map(([kind, entry]) => `${kind} ${[...entry.sectors].join(" and ")}, nearest ${entry.nearest} block${entry.nearest === 1 ? "" : "s"}`).join("; ");
}

/** Which way the enemy is looking, relative to the bot. */
export function enemyFacing(enemy: Entity, me: Vec3): string {
  const toBot = me.minus(enemy.position);
  const angle = Math.abs(angleBetween(enemy.yaw, toBot));
  if (angle <= 45) return "looking at the bot";
  if (angle >= 135) return "looking away";
  return "looking sideways";
}

/** Whether the enemy is closing, retreating, circling or still, from its velocity; a fresh hit moving it away is knockback. */
export function enemyMotion(enemy: Entity, me: Vec3, clocks: Clocks): string {
  const v = enemy.velocity;
  const speed = Math.hypot(v.x, v.z) * 20;
  if (speed < 0.5) return "standing still";
  const toBot = me.minus(enemy.position);
  const flat = Math.hypot(toBot.x, toBot.z) || 1;
  const closing = (v.x * toBot.x + v.z * toBot.z) / flat;
  const pace = speed > 4 ? "fast" : "slowly";
  if (closing * 20 > 0.5) return `closing ${pace}`;
  if (closing * 20 < -0.5) {
    const sinceHurt = clocks.since(clocks.hurt.get(enemy.id) ?? null);
    return sinceHurt !== null && sinceHurt < KNOCKBACK_TICKS ? "flying back from knockback, will return" : `retreating ${pace}`;
  }
  return `moving sideways ${pace}`;
}

/**
 * What the enemy is doing. Bow draws and creeper fuses use the package's own
 * perception helpers; the rest reads 1.21.4 metadata directly: index 8 is the
 * living-entity hand state (bit 1 = using the held item) and 15 the mob flags
 * (bit 4 = aggressive).
 */
export function enemyState(bot: Bot, enemy: Entity, clocks: Clocks): string[] {
  const meta = (index: number): number => {
    const value = (enemy.metadata as unknown[] | undefined)?.[index];
    return typeof value === "number" ? value : 0;
  };
  const states: string[] = [];
  const held = enemy.heldItem?.name;
  if (held) states.push(`holding ${held}`);
  if (enemy.name === "blaze") states.push(blazeFlaring(enemy) ? "flaring: in its shooting phase, bursts of three fireballs" : "hovering, shoots bursts of three fireballs, immune to fire");
  if (enemy.name === "wither_skeleton") states.push("its hits wither: damage over ten seconds the shield cannot stop once applied");
  if (isDrawingBow(bot, enemy)) {
    const release = bowReleaseInTicks(bot, enemy);
    states.push(
      release === null ? "drawing its bow" : release === 0 ? "bow fully drawn, may fire any moment" : `drawing its bow, fires in about ${ticksText(release)}`,
    );
  } else if (meta(8) & 1) states.push("using its held item");
  if (meta(15) & 4) states.push("aggressive");
  if (enemy.name === "creeper") {
    const fuse = clocks.fuse.get(enemy.id) ?? 0;
    const lit = isSwelling(bot, enemy);
    states.push(
      `fuse ${fuse} of ${CREEPER_FUSE_TICKS}${lit ? ", LIT and climbing" : fuse > 0 ? ", out and falling" : ", out"}: it explodes at ${CREEPER_FUSE_TICKS}; the counter climbs one a tick within 3 blocks and falls one a tick outside${distance(bot, enemy) > CREEPER_FUSE_RANGE ? "; it is out of range now, so backing off keeps the counter falling" : "; it is inside range now, so backing off alone will not lower it, a sword hit knocking it out will"}`,
    );
  }
  return states;
}

/** The face option's text: who this is and why it matters right now, so the choice compares threats rather than distances. */
export function faceBlurb(bot: Bot, clocks: Clocks, lead: number, enemy: Entity): string {
  const then = forecast(enemy, lead).minus(forecast(bot.entity, lead));
  const flatThen = Math.hypot(then.x, then.z);
  const flags: string[] = [];
  if (Math.hypot(flatThen, then.y) <= REACH) flags.push("will be in reach");
  if (enemy.name === "creeper") {
    const fuse = clocks.fuse.get(enemy.id) ?? 0;
    if (isSwelling(bot, enemy)) flags.push(`FUSE ${fuse} of ${CREEPER_FUSE_TICKS}, explodes in about ${ticksText(CREEPER_FUSE_TICKS - fuse)} for 15 or more damage at this range: face it and hit it now, an arrow taken meanwhile costs 2`);
    else if (flatThen <= CREEPER_FUSE_RANGE + 1) flags.push("its fuse lights within 3 blocks; a blast in reach costs 15 or more");
  }
  if (enemy.name === "blaze") {
    if (blazeFlaring(enemy)) flags.push("flaring up, fireballs in about 10 ticks");
  } else if (enemy.heldItem?.name === "bow") {
    const release = isDrawingBow(bot, enemy) ? bowReleaseInTicks(bot, enemy) : null;
    if (release !== null) flags.push(release === 0 ? "bow fully drawn" : `fires in about ${ticksText(release)}`);
  } else if (enemy.name !== "creeper") {
    const sinceHitUs = clocks.since(clocks.hitUs.get(enemy.id) ?? null);
    if (sinceHitUs === null || sinceHitUs + lead >= MOB_ATTACK_INTERVAL_TICKS) flags.push("attack ready");
    else flags.push(`cannot swing for ${ticksText(MOB_ATTACK_INTERVAL_TICKS - sinceHitUs - lead)}`);
  }
  if (isSwelling(bot, enemy)) flags.push("fuse lit");
  const hp = health(enemy);
  if (hp !== undefined && hp <= 6) flags.push("nearly dead");
  const shots = incomingShots(bot, lead);
  if (shots.length) {
    const covered = shots.filter((shot) => shot.source === enemy.position || arcCover(bot, enemy.position, shot.source).covered);
    const missed = shots.filter((shot) => !covered.includes(shot));
    flags.unshift(`facing it puts ${covered.length} of ${shots.length} incoming inside the shield arc${missed.length ? `, leaving out ${missed.map((shot) => `${shot.label} (${shot.when})`).join(" and ")}` : ""}`);
    for (const shot of shots) {
      if (shot.source === enemy.position) {
        flags.push(`its own shot (${shot.when}) is blocked by a raised shield facing it`);
        continue;
      }
      const { degrees, covered: inArc } = arcCover(bot, enemy.position, shot.source);
      flags.push(inArc ? `keeps ${shot.label} inside the arc (${Math.abs(degrees)} degrees off)` : `leaves ${shot.label} outside the arc (${Math.abs(degrees)} degrees off), ${shot.when}: guarding this way blocks nothing from it`);
    }
  }
  return `${enemy.name}, about ${flatThen.toFixed(1)} blocks when the answer lands, ${flags.join(", ")}`;
}

export function enemyLine(bot: Bot, clocks: Clocks, lead: number, yaw: number, enemy: Entity): string {
  const me = bot.entity.position;
  const d = enemy.position.minus(me);
  const flat = Math.hypot(d.x, d.z);
  const then = forecast(enemy, lead).minus(forecast(bot.entity, lead));
  const flatThen = Math.hypot(then.x, then.z);
  const height = Math.round(d.y);
  const heightText = height === 0 ? "same height" : `${Math.abs(height)} blocks ${height > 0 ? "higher" : "lower"}`;
  const where = flat < 0.6 ? "overlapping the bot (no bearing; the shield cannot block it, step away)" : `${flat.toFixed(1)} blocks ${relativeBearing(yaw, d)}`;
  const flatWalking = Math.max(0, flatThen - WALK_BLOCKS_PER_TICK * walkTicks(lead));
  // Reach is a straight line, so height counts: a mob three blocks down is not in reach at two blocks across.
  const reachThen = Math.hypot(flatThen, then.y);
  const reachWalking = Math.hypot(flatWalking, then.y);
  const belowOrAbove = Math.abs(then.y) >= 2 ? ` (out of sword reach: it is ${Math.abs(Math.round(then.y))} blocks ${then.y > 0 ? "above" : "below"})` : "";
  // With no lead the snapshot is the moment the answer lands, so there is no "then"; walking covers the hold instead.
  const thenText =
    lead === 0
      ? reachThen <= REACH
        ? "in reach"
        : reachWalking <= REACH
          ? `out of reach, in reach at about ${flatWalking.toFixed(1)} if the bot walks toward it this window`
          : `out of reach, ${flatWalking.toFixed(1)} after walking toward it this window${belowOrAbove}`
      : reachThen <= REACH
        ? `then about ${flatThen.toFixed(1)} blocks (in reach)`
        : reachWalking <= REACH
          ? `then about ${flatThen.toFixed(1)} blocks holding still, in reach at about ${flatWalking.toFixed(1)} if the bot walks toward it`
          : `then about ${flatThen.toFixed(1)} blocks holding still, ${flatWalking.toFixed(1)} walking toward it${belowOrAbove}`;
  const parts = [
    `${enemy.name}, now ${where}, ${thenText}, ${heightText}, at ${coords(enemy.position)}`,
    enemyFacing(enemy, me),
    enemyMotion(enemy, me, clocks),
    ...enemyState(bot, enemy, clocks),
  ];
  const hp = health(enemy);
  if (hp !== undefined) parts.push(`health ${Math.round(hp * 10) / 10}`);
  if (!lineOfSight(bot, enemy)) parts.push("behind cover: no line of sight, it cannot shoot the bot and the bot cannot hit it from here");
  const sinceHitUs = clocks.since(clocks.hitUs.get(enemy.id) ?? null);
  if (!isRanged(enemy)) {
    if (sinceHitUs === null) parts.push("has not hit the bot yet");
    else if (sinceHitUs + lead < MOB_ATTACK_INTERVAL_TICKS) {
      parts.push(`hit the bot ${ticksText(sinceHitUs)} ago, cannot swing again for ${ticksText(MOB_ATTACK_INTERVAL_TICKS - sinceHitUs - lead)}`);
    } else parts.push(`hit the bot ${ticksText(sinceHitUs)} ago, attack ready`);
  }
  const sinceHurt = clocks.since(clocks.hurt.get(enemy.id) ?? null);
  if (sinceHurt !== null) parts.push(`took a hit ${ticksText(sinceHurt)} ago`);
  return parts.join(", ");
}

/**
 * The facts a hands or move decision turns on, as one sentence for this
 * window. The criteria are static text; jev has to find these facts in the
 * state, and on cold-sword windows it kept choosing strike anyway. Putting
 * them in the question itself, every window, is the cheap fix.
 */
export function nowLine(bot: Bot, clocks: Clocks, snapshot: SnapshotData, faced: Entity): string {
  const b = snapshot.bot;
  const parts: string[] = [];
  parts.push(b.swordReadyIn > snapshot.lead ? `the sword is cold for ${ticksText(b.swordReadyIn - snapshot.lead)} more (a swing now does little)` : "the sword is ready");
  parts.push(!b.shield.up ? "the shield is down" : b.shield.activeIn ? `the shield is up but not active for ${ticksText(b.shield.activeIn)}` : "the shield is up and active");
  const target = snapshot.enemies.find((enemy) => enemy.id === faced.id);
  if (target) {
    const walking = Math.max(0, target.forecastDistance - WALK_BLOCKS_PER_TICK * walkTicks(snapshot.lead));
    const dy = target.heightDifference ?? 0;
    const reach =
      target.forecastReach <= REACH
        ? "will be in reach"
        : Math.hypot(walking, dy) <= REACH
          ? `will be about ${target.forecastDistance.toFixed(1)} blocks away holding still, in reach if the bot walks forward`
          : `will be out of reach at about ${target.forecastDistance.toFixed(1)} blocks, ${walking.toFixed(1)} walking forward${Math.abs(dy) >= 2 ? ` (${Math.abs(Math.round(dy))} blocks ${dy > 0 ? "above" : "below"} the bot, which is why)` : ""}`;
    const cooling = !target.ranged && target.hitUsAgo !== null && target.hitUsAgo + snapshot.lead < MOB_ATTACK_INTERVAL_TICKS
      ? ` and cannot swing for ${ticksText(MOB_ATTACK_INTERVAL_TICKS - target.hitUsAgo - snapshot.lead)} (a safe moment to strike)`
      : "";
    parts.push(`the faced ${target.name} ${reach}${cooling}`);
    const below = Math.round(faced.position.y - bot.entity.position.y);
    if (below <= -2) {
      parts.push(
        target.forecastReach <= REACH
          ? `the faced ${target.name} is ${-below} blocks below the bot in a hole and just within sword reach from the edge: strike from here, do not step toward it, stepping in traps the bot with it`
          : `the faced ${target.name} is ${-below} blocks below the bot in a hole and out of sword reach from here; stepping in traps the bot with it, so either face it with the shield up or move away and deal with the others`,
      );
    }
    if (!target.ranged && target.distance < OVERLAP_BLOCKS) {
      parts.push(`the faced ${target.name} is overlapping the bot at ${target.distance.toFixed(1)} blocks: a swing here barely knocks it back and the shield cannot block it; step back first, then strike as it follows from one to two blocks`);
    }
  }
  const incoming: string[] = [];
  for (const arrow of snapshot.arrows) {
    if (arrow.impactTicks !== null) {
      const shield = shieldTiming(bot, clocks, snapshot.lead, arrow.impactTicks);
      incoming.push(
        `an arrow hits in ${ticksText(Math.max(0, arrow.impactTicks - snapshot.lead))} from ${Math.abs(arrow.degrees)} degrees ${arrow.degrees < 0 ? "left" : "right"} of the facing (${arrow.inArc ? `inside the shield arc; ${shield.text}` : "outside the shield arc, the shield cannot block it"}); stepping ${arrow.dodge} takes the bot out of its line`,
      );
    } else if (arrow.impactTicksMoving !== null) incoming.push(`an arrow misses a standing bot but passes within a step on the ${OPPOSITE[arrow.dodge as MoveName]} side: do not move ${OPPOSITE[arrow.dodge as MoveName]}`);
  }
  // Every drawn bow: where its shot comes from relative to the facing, when it can land, and whether the shield can be up by then.
  for (const enemy of snapshot.enemies) {
    if (enemy.releaseIn === null) continue;
    const arrival = enemy.releaseIn + Math.ceil(enemy.distance / ARROW_SPEED);
    const shot = enemy.releaseIn === 0 ? "bow fully drawn, fires any tick" : `bow drawn, fires in about ${ticksText(enemy.releaseIn)}`;
    const arc = Math.abs(enemy.degrees) < SHIELD_ARC_DEGREES;
    const shield = shieldTiming(bot, clocks, snapshot.lead, arrival);
    const flight = arrival - enemy.releaseIn;
    incoming.push(
      `${enemy.label} the ${enemy.name}: ${shot}, its arrow lands about ${ticksText(arrival)} from now, from ${Math.abs(enemy.degrees)} degrees ${enemy.degrees < 0 ? "left" : "right"} of the facing, ${arc ? `inside the shield arc; ${shield.text}` : `outside the shield arc: guarding blocks nothing from it unless the bot faces it${flight <= 2 * currentWindow().hold + 1 ? `, and its flight of ${ticksText(flight)} is too short to dodge once loosed, so face it now or before it fires` : ""}`}`,
    );
  }
  // Cover: a column one block out on an archer's line ends its shots; say so when it would pay, naming the archer.
  const cobble = snapshot.bot.cobblestone ?? 0;
  const shooters = snapshot.enemies.filter((enemy) => enemy.ranged && enemy.los !== false && enemy.distance > REACH);
  if (cobble > 0 && shooters.length > 0) {
    const outside = shooters.filter((enemy) => Math.abs(enemy.degrees) >= SHIELD_ARC_DEGREES);
    const soonest = [...shooters].sort((a, b) => (a.releaseIn ?? 99) - (b.releaseIn ?? 99) || a.distance - b.distance)[0]!;
    if (outside.length > 0 || shooters.length >= 2) {
      const pick = outside[0] ?? soonest;
      incoming.push(
        `Cover: placing a column now (hands cover) toward ${pick.label} the ${pick.name}, ${pick.distance.toFixed(1)} blocks at ${Math.abs(pick.degrees)} degrees ${pick.degrees < 0 ? "left" : "right"}${outside.includes(pick) ? ", outside the shield arc" : ""}, ends its line of fire from where the bot stands; ${cobble} cobblestone in hand${shooters.length >= 2 ? `; ${shooters.length} archers have clear shots and the shield covers one side at a time` : ""}`,
      );
    }
  }
  // Several archers: the arc is 180 degrees wide, so they can all be covered only if they span less than that.
  // A wall at the bot's back puts everything in front; otherwise one of them always has a clear shot.
  const archers = snapshot.enemies.filter((enemy) => enemy.ranged);
  if (archers.length >= 2) {
    const angles = archers.map((enemy) => ((enemy.degrees % 360) + 360) % 360).sort((a, b) => a - b);
    let largestGap = 360 - angles[angles.length - 1]! + angles[0]!;
    for (let i = 1; i < angles.length; i += 1) largestGap = Math.max(largestGap, angles[i]! - angles[i - 1]!);
    const spread = 360 - largestGap;
    const where = archers.map((enemy) => `${enemy.label} ${Math.abs(enemy.degrees)} ${enemy.degrees < 0 ? "left" : "right"}`).join(", ");
    if (spread >= 2 * SHIELD_ARC_DEGREES - 10) {
      const walls = wallDistances(bot).filter((wall) => wall.blocks !== null).sort((a, b) => a.blocks! - b.blocks!);
      const nearest = walls[0];
      const atWall = nearest !== undefined && nearest.blocks! <= 1;
      incoming.push(
        `${archers.length} archers spread over ${Math.round(spread)} degrees (${where}): no facing puts them all inside the shield arc, one always has a clear shot. ` +
          (atWall
            ? `The bot is at a wall (${nearest.direction}): turn so the wall is at its back (face the archer furthest from it) and every archer is in front of the shield`
            : nearest
              ? `The nearest wall is ${nearest.blocks} blocks ${nearest.direction}: moving ${nearest.move} reaches it, and with the wall at the bot's back every archer is in front of the shield. Otherwise close on the nearest archer and kill it fast`
              : "No wall within 16 blocks: close on the nearest archer and kill it fast"),
      );
    } else {
      incoming.push(`${archers.length} archers span ${Math.round(spread)} degrees (${where}): a facing between them keeps all of them inside the shield arc`);
    }
  }
  // A strike drops the shield for this window; the next answer needs another
  // window to arrive and the shield five ticks to activate. A bow releasing
  // inside that span means a strike now is an arrow taken.
  const reguard = reguardTicks(snapshot.lead);
  for (const enemy of snapshot.enemies) {
    if (enemy.releaseIn === null || enemy.releaseIn > reguard || enemy.forecastReach <= REACH) continue;
    incoming.push(`${enemy.label} the ${enemy.name} fires before a shield lowered now could be active again (${ticksText(reguard)}), so a strike at something else now means taking that arrow`);
  }
  for (const enemy of snapshot.enemies) {
    if (enemy.name !== "creeper") continue;
    const fuse = /fuse (\d+) of/.exec(enemy.states.find((state) => state.startsWith("fuse")) ?? "")?.[1];
    if (enemy.states.some((state) => state.includes("LIT"))) {
      const ticksLeft = CREEPER_FUSE_TICKS - Number(fuse ?? 0);
      incoming.push(
        enemy.distance > CREEPER_FUSE_RANGE
          ? `${enemy.label} the creeper's fuse is at ${fuse} of ${CREEPER_FUSE_TICKS}, about ${ticksText(ticksLeft)} from exploding, and it is out of fuse range at ${enemy.distance.toFixed(1)} blocks but the blast reaches about 6: ${Number(fuse ?? 0) >= 20 ? "sprint away now" : "backing off keeps the counter falling"}; walking toward it puts the bot in the blast`
          : `${enemy.label} the creeper's fuse is at ${fuse} of ${CREEPER_FUSE_TICKS}, about ${ticksText(ticksLeft)} from exploding, and it is inside range: only a sword hit knocking it out of range, or killing it, stops the counter`,
      );
    }
    else if (enemy.forecastDistance <= CREEPER_FUSE_RANGE) incoming.push(`${enemy.label} the creeper will be inside fuse range at about ${enemy.forecastDistance.toFixed(1)} blocks, fuse at ${fuse}`);
  }
  const others = snapshot.enemies.filter((enemy) => enemy.id !== faced.id && !enemy.ranged && enemy.name !== "creeper" && enemy.forecastDistance <= REACH);
  if (others.length) incoming.push(`${others.map((enemy) => `${enemy.label} the ${enemy.name}`).join(" and ")} will also be in reach (${others.map((enemy) => enemy.bearing).join(", ")})`);
  parts.push(incoming.length ? `Due to land: ${incoming.join("; ")}` : "nothing else is due to land in the window");
  if (target && target.held !== "bow" && target.name !== "creeper" && target.forecastReach > REACH && b.swordReadyIn <= snapshot.lead && incoming.length === 0) {
    parts.push(`the faced ${target.name} is out of reach, the sword is ready and nothing is due to land: close on it, backing away or circling only kites it`);
  }
  const walk = WALK_BLOCKS_PER_TICK * walkTicks(snapshot.lead);
  const hazards: string[] = [];
  for (const [direction, probe] of Object.entries(snapshot.ground)) {
    const m = /^(drop of [^ ]+( than 3)?|lava|water|magma) at (\d)/.exec(probe);
    if (!m) continue;
    const at = Number(m[3]);
    const move = { ahead: "forward", behind: "back", left: "left", right: "right" }[direction] ?? direction;
    if (at <= Math.ceil(walk) + 1) hazards.push(`moving ${move} reaches a ${m[1]} in ${at} block${at === 1 ? "" : "s"}, inside this window's walk: do not move ${move}`);
  }
  const facing = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const directions: [string, Vec3][] = [["forward", facing], ["back", facing.scaled(-1)], ["left", new Vec3(facing.z, 0, -facing.x)], ["right", new Vec3(-facing.z, 0, facing.x)]];
  for (const enemy of snapshot.enemies) {
    if (enemy.id === faced.id || enemy.ranged) continue;
    const d = new Vec3(enemy.position.x - bot.entity.position.x, 0, enemy.position.z - bot.entity.position.z);
    const flat = Math.hypot(d.x, d.z);
    if (flat > walk + REACH + 1 || flat <= REACH) continue;
    const toward = directions.find(([, dir]) => Math.abs(degreesBetween(dir, d)) <= 45);
    if (toward) hazards.push(`moving ${toward[0]} walks into ${enemy.label} the ${enemy.name} (${flat.toFixed(1)} blocks ${enemy.bearing})`);
  }
  if (hazards.length) parts.push(`Ground and neighbours: ${hazards.join("; ")}`);
  // Room: how far the bot can walk each way before a wall, a step it must jump, or a hazard.
  const roomOf = (probeText: string): number => {
    const m = /^(wall|drop of (?:[2-9]|more)|lava|water|one-block step up) at (\d)/.exec(probeText);
    if (!m) return 3;
    return Math.max(0, Number(m[2]) - 1);
  };
  const room = { ahead: roomOf(snapshot.ground.ahead), behind: roomOf(snapshot.ground.behind), left: roomOf(snapshot.ground.left), right: roomOf(snapshot.ground.right) };
  let roomText = `Room: ${room.ahead} blocks ahead, ${room.behind} behind, ${room.left} left, ${room.right} right`;
  if (room.behind <= 1) {
    const side = room.left > room.right ? "left" : room.right > room.left ? "right" : room.left > 0 ? "either side" : "nowhere";
    roomText += side === "nowhere" ? ". CORNERED: no room behind or to either side; the only way out is forward or through" : `. Backing is blocked: circle ${side} to keep space rather than backing into the wall`;
  }
  const bomb = snapshot.enemies.find((enemy) => enemy.name === "creeper" && enemy.states.some((state) => state.includes("LIT")) && Number(/fuse (\d+) of/.exec(enemy.states.find((state) => state.startsWith("fuse")) ?? "")?.[1] ?? 0) >= 20);
  if (bomb) {
    const away = { ahead: room.ahead, behind: room.behind, left: room.left, right: room.right };
    const best = Object.entries(away).filter(([direction]) => !(bomb.bearing.includes("ahead") && direction === "ahead") && !(bomb.bearing.includes("behind") && direction === "behind")).sort((a, b) => b[1] - a[1])[0];
    roomText += `. A creeper is about to explode: distance is all that matters this window, not circling; sprint ${best?.[0] === "ahead" ? "forward" : best?.[0] === "behind" ? "back" : best?.[0] ?? "away"} (${best?.[1] ?? 0} blocks of room) to get 6 blocks from it`;
  }
  parts.push(roomText);
  const closingMelee = snapshot.enemies.filter((enemy) => !enemy.ranged && enemy.name !== "creeper" && enemy.forecastDistance <= REACH + 1.5);
  if (closingMelee.length >= 2) {
    parts.push(`${closingMelee.length} melee mobs converging (${closingMelee.map((enemy) => `${enemy.label} ${enemy.bearing}`).join(", ")}): circle so they line up behind one another, do not back into the middle of them`);
  }
  const trapped = pitDepth(bot);
  if (trapped > 0) parts.push(`The bot is at the bottom of a pit ${trapped} deep with walls on every side and no blocks to climb with; it cannot get out, and no enemy can reach it except by arrows or by falling in`);
  const shots = incomingShots(bot, snapshot.lead);
  if (shots.length) {
    const facing = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
    const me = bot.entity.position;
    const cover = shots.map((shot) => {
      const degrees = Math.round(degreesBetween(facing, shot.source.minus(me)));
      return `${shot.label} comes from ${Math.abs(degrees)} degrees ${degrees < 0 ? "left" : "right"} of the current facing, ${Math.abs(degrees) < SHIELD_ARC_DEGREES ? "inside" : "outside"} the shield arc`;
    });
    parts.push(`Shield arc: a raised shield blocks only sources within 90 degrees of where the bot looks; ${cover.join("; ")}`);
  }
  return `Right now: ${parts.join("; ")}.`;
}

/** Plain text jev reads: the bot and its clocks, each enemy now and forecast, arrows, and the ground in four directions. */
export function describe(
  bot: Bot,
  clocks: Clocks,
  lead: number,
  labelled: readonly { enemy: Entity; label: string }[],
  faced: Entity,
  turn: number,
  last: string,
): string {
  const me = bot.entity.position;
  const held = bot.heldItem?.name ?? "nothing";
  const under = bot.blockAt(me.offset(0, -1, 0))?.name ?? "unknown";
  const yaw = bot.entity.yaw;
  const armour = bot.inventory.slots.slice(5, 9).filter((slot) => slot).map((slot) => slot!.name).join(", ") || "no armour";

  const sinceSwing = clocks.since(clocks.lastSwing);
  const swordReadyIn = sinceSwing === null ? 0 : Math.max(0, SWORD_COOLDOWN_TICKS - sinceSwing - lead);
  const sword = swordReadyIn === 0 ? "ready" : `ready in ${ticksText(swordReadyIn)}, a swing before then does reduced damage`;

  const sinceRaised = clocks.since(clocks.shieldRaised);
  const serverShield = clocks.serverShieldUp();
  const shield =
    !bot.usingHeldItem || sinceRaised === null
      ? "down"
      : sinceRaised + lead >= SHIELD_READY_TICKS
        ? `up and active, blocking arrows and melee from the front${serverShield ? "" : " (not yet confirmed by the server)"}`
        : `up, active in ${ticksText(SHIELD_READY_TICKS - sinceRaised - lead)}`;

  const sinceHurt = clocks.since(clocks.botHurt);
  const invulnerable =
    sinceHurt !== null && sinceHurt + lead < HURT_INVULNERABLE_TICKS
      ? `hit ${ticksText(sinceHurt)} ago, cannot be hurt again for ${ticksText(HURT_INVULNERABLE_TICKS - sinceHurt - lead)}`
      : sinceHurt === null
        ? "not hit yet"
        : `last hit ${ticksText(sinceHurt)} ago by ${clocks.lastHitBy}, can be hurt`;

  const lines = [
    lead > 0
      ? `Snapshot at tick ${clocks.tick}; your answer takes effect at about tick ${clocks.tick + lead}. Every "in N ticks" below counts from when it takes effect.`
      : `Snapshot at tick ${clocks.tick}; your answer takes effect now and holds for ${ticksText(currentWindow().hold)}. Every "in N ticks" below counts from now.`,
    `Bot: health ${bot.health.toFixed(1)}/20, food ${bot.food}/20, holding ${held}, wearing ${armour}, ` +
      `${bot.entity.onGround ? "on the ground" : "in the air"} on ${under} at ${coords(me)}. Sword reach ${REACH} blocks. ${cobblestone(bot)} cobblestone for cover.`,
    `Bot clocks: sword ${sword}. Shield ${shield}. Body: ${invulnerable}.${onFire(bot) ? " ON FIRE: burning for about 1 damage a second until it goes out; water puts it out at once." : ""}${witherTicks(bot) > 0 ? ` WITHERING for ${ticksText(witherTicks(bot))} more: about 1 damage every two seconds that the shield cannot stop.` : ""}${pitDepth(bot) > 0 ? ` TRAPPED: at the bottom of a pit ${pitDepth(bot)} deep, walls on every side, no blocks to climb with.` : ""}`,
    `Enemies, lettered nearest first. Bearings are relative to where the bot faces now (it faces ${labelled.find((l) => l.enemy === faced)?.label ?? "?"})` +
      (lead > 0 ? `; "then" means when the answer takes effect, if everyone keeps moving as they are:` : ":"),
    ...labelled.map(({ enemy, label }) => `- ${label}: ${enemyLine(bot, clocks, lead, yaw, enemy)}`),
    ...arrowLines(bot, clocks, yaw, lead),
    "Ground from the bot's feet outward, one block per step:",
    ...(["ahead", "behind", "left", "right"] as const).map((direction) => `- ${direction}: ${probe(bot, yaw, direction)}`),
    `Terrain within 2 blocks: ${terrainText(terrainGrid(bot))}. Walls: ${wallDistances(bot).map((wall) => `${wall.blocks === null ? "none within 16" : wall.blocks} ${wall.direction}`).join(", ")}.`,
    `Turn ${turn}. Last answer applied: ${last}.`,
  ];
  return lines.join("\n");
}

/**
 * A version of the prompt as built, hashed from the source of every function
 * that writes text jev reads. The sample's promptHash folds this in, so a
 * change to a template line is a new teacher version even when the fixed
 * question text is unchanged. Bun gives a function's source with toString.
 */
export function promptTemplateHash(): string {
  const source = [situation, questions, describe, nowLine, enemyLine, enemyFacing, enemyMotion, enemyState, faceBlurb, arrowLines, incomingShots, probe]
    .map((fn) => fn.toString())
    .join("\n");
  return Bun.hash(source).toString(16).padStart(16, "0");
}

/**
 * Carrying out a decision: the controls, the hands, cover, and the gear the
 * bot starts with. A poor choice is carried out as chosen so the log shows
 * what it cost, with one exception: a move into lava, water, magma or a drop
 * within the window is refused for every policy.
 */
import type { Bot, ControlState } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";

import type { Answer } from "../decide/jev.ts";
import { REACH, SWORD_COOLDOWN_TICKS, isRanged } from "../sense/constants.ts";
import { angleBetween, distance, eyes } from "../sense/geometry.ts";
import type { Clocks } from "../sense/clocks.ts";
import type { SnapshotData } from "../sense/snapshot.ts";
import { cobblestone, lineOfSight, probe } from "../sense/world.ts";
import { isDrawingBow } from "../sense/perception/attention.ts";
import { bowReleaseInTicks } from "../sense/perception/bow-timing.ts";


/** Mine Labs grants the inventory after arrangement; wait until the sword is actually there. */
export async function inventoryArrived(bot: Bot): Promise<void> {
  for (let waited = 0; waited < 200; waited += 1) {
    if (bot.inventory.items().some((item) => item.name.endsWith("_sword"))) return;
    await bot.waitForTicks(1);
  }
}

export async function gearUp(bot: Bot): Promise<void> {
  const items = bot.inventory.items();
  const sword = items.find((item) => item.name.endsWith("_sword"));
  if (sword) await bot.equip(sword, "hand");
  const shield = items.find((item) => item.name === "shield");
  if (shield) await bot.equip(shield, "off-hand");
  for (const [suffix, slot] of [["_helmet", "head"], ["_chestplate", "torso"], ["_leggings", "legs"], ["_boots", "feet"]] as const) {
    const piece = items.find((item) => item.name.endsWith(suffix));
    if (piece) await bot.equip(piece, slot);
  }
}

/**
 * Places a two-block column one block from the bot toward the archer that
 * fires soonest (else the nearest archer with a line of sight), then puts
 * the sword back. Placement is forced-look and packet-driven, so it works
 * while the world is frozen. Returns a note for the log.
 */
export async function buildCover(bot: Bot, clocks: Clocks, enemies: readonly Entity[], faced: Entity): Promise<string> {
  const archers = enemies.filter((enemy) => isRanged(enemy) && lineOfSight(bot, enemy));
  const releaseOf = (enemy: Entity) => (isDrawingBow(bot, enemy) ? bowReleaseInTicks(bot, enemy) ?? 99 : 99);
  const target = archers.sort((a, b) => releaseOf(a) - releaseOf(b) || distance(bot, a) - distance(bot, b))[0] ?? (isRanged(faced) ? faced : undefined);
  if (!target) return " (no archer with a line of sight to cover from; guarded instead)";
  const cobble = bot.inventory.items().find((item) => item.name === "cobblestone");
  if (!cobble) return " (no cobblestone left; guarded instead)";
  const me = bot.entity.position;
  const d = target.position.minus(me);
  const flat = Math.hypot(d.x, d.z) || 1;
  const cell = me.plus(new Vec3(d.x / flat, 0, d.z / flat)).floored();
  const feet = me.floored();
  if (cell.x === feet.x && cell.z === feet.z) return " (the archer's line runs through the bot's own cell; guarded instead)";
  const air = (position: Vec3) => {
    const name = bot.blockAt(position)?.name;
    return name === "air" || name === "cave_air";
  };
  const below = bot.blockAt(cell.offset(0, -1, 0));
  if (!below || air(below.position) || !air(cell) || !air(cell.offset(0, 1, 0))) return " (no room for cover on that line; guarded instead)";
  const sword = bot.inventory.items().find((item) => item.name.endsWith("_sword"));
  // The typings stop at two arguments; the implementation takes options, and forceLook is what keeps this from waiting on physics ticks.
  const place = (reference: NonNullable<ReturnType<Bot["blockAt"]>>) =>
    (bot.placeBlock as unknown as (ref: typeof reference, face: Vec3, options: { forceLook: boolean; swingArm: string }) => Promise<void>)(reference, new Vec3(0, 1, 0), { forceLook: true, swingArm: "right" });
  let placed = 0;
  try {
    await bot.equip(cobble, "hand");
    clocks.shield(false);
    await place(below);
    placed = 1;
    const lower = bot.blockAt(cell);
    if (lower && !air(lower.position)) {
      await place(lower);
      placed = 2;
    }
  } catch (cause) {
    return ` (cover failed after ${placed} block${placed === 1 ? "" : "s"}: ${cause instanceof Error ? cause.message.slice(0, 60) : String(cause)})`;
  } finally {
    if (sword) await bot.equip(sword, "hand").catch(() => undefined);
    await bot.lookAt(eyes(faced), true).catch(() => undefined);
  }
  return ` (placed ${placed} block${placed === 1 ? "" : "s"} of cover toward ${target.name} at ${cell.x},${cell.y},${cell.z}; ${cobblestone(bot)} cobblestone left)`;
}

/** What a window applied, kept in the log and used as the next window's "last answer applied". */
export interface Applied {
  face: string;
  facedId: number;
  facedName: string;
  move: string;
  chosenMove: string;
  pace: string;
  jump: boolean;
  hands: string;
  swung: boolean;
  guarding: boolean;
  controls: ControlState[];
  note: string;
  drift: string;
  groundThen: string | null;
  groundNow: string | null;
}

const YES = 0.5;
const DIRECTION_OF = { forward: "ahead", back: "behind", left: "left", right: "right" } as const;

/**
 * Carries out the answers: turn to the chosen enemy, set the controls for
 * the move and pace, then strike, guard, build cover or free the hands. A
 * move whose ground would hurt within the window falls through to the
 * policy's next-ranked safe direction.
 */
export async function applyDecision(
  bot: Bot,
  clocks: Clocks,
  answers: Record<string, Answer>,
  snapshot: SnapshotData,
  labelled: readonly { enemy: Entity; label: string }[],
  facedBefore: Entity,
): Promise<{ faced: Entity; applied: Applied }> {
  const faceChoice = answers.face?.type === "choice" ? answers.face.choice : "keep";
  const chosen = labelled.find(({ label }) => label === faceChoice)?.enemy;
  const faced = chosen && chosen.isValid ? chosen : facedBefore;
  await bot.lookAt(eyes(faced), true);

  // The head has tracked the target since the snapshot, so the ground in the chosen direction is probed again now.
  let move = answers.move?.type === "choice" ? answers.move.choice : "hold";
  const probeDirection = DIRECTION_OF[move as keyof typeof DIRECTION_OF];
  const groundNow = probeDirection ? probe(bot, bot.entity.yaw, probeDirection) : null;
  const groundThen = probeDirection ? snapshot.ground[probeDirection] : null;
  const pace = answers.pace?.type === "choice" ? answers.pace.choice : "walk";
  // A one-block step down is a step, not a hazard; a drop of two or more, lava, water or magma within the window's walk is.
  const reachOfWindow = pace === "sprint" ? 2 : 1;
  const hurts = (ground: string | null) => {
    const m = ground === null ? null : /^(drop of ([2-9]|more)|lava|water|magma).* at (\d)$/.exec(ground);
    return m !== null && Number(m[3]) <= reachOfWindow;
  };
  let drift = "";
  if (probeDirection && groundNow !== groundThen) {
    const turned = Math.round(Math.abs(angleBetween(snapshot.bot.yaw, new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw)))));
    drift = `; frame drifted ${turned} degrees, ${probeDirection} was "${groundThen}" and is now "${groundNow}"`;
  }
  if (probeDirection && hurts(groundNow)) {
    const ranked = answers.move?.type === "choice" ? Object.entries(answers.move.probabilities).sort((a, b) => b[1] - a[1]).map(([name]) => name) : [];
    const safe = ranked.find((name) => {
      const dir = DIRECTION_OF[name as keyof typeof DIRECTION_OF];
      return name === "hold" || (dir !== undefined && !hurts(probe(bot, bot.entity.yaw, dir)));
    });
    drift += `; ${move} would walk into it, took the next safe choice ${safe ?? "hold"}`;
    move = safe ?? "hold";
  }

  const jump = answers.jump?.type === "noul" ? answers.jump.noul >= YES : false;
  const controls: ControlState[] = [];
  for (const control of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
    const on = control === move || (control === "jump" && jump) || (control === "sprint" && pace === "sprint") || (control === "sneak" && pace === "sneak");
    bot.setControlState(control, on);
    if (on) controls.push(control);
  }

  // The hands: a strike with nothing in reach is a wasted swing with the shield down; a cold strike does little.
  const hands = answers.hands?.type === "choice" ? answers.hands.choice : "free";
  const raise = () => {
    if (bot.usingHeldItem) return;
    bot.activateItem(true);
    clocks.shield(true);
  };
  const lower = () => {
    if (!bot.usingHeldItem) return;
    bot.deactivateItem();
    clocks.shield(false);
  };
  const sinceSwing = clocks.since(clocks.lastSwing);
  const swordReady = sinceSwing === null || sinceSwing >= SWORD_COOLDOWN_TICKS;
  let swung = false;
  let note = "";
  if (hands === "strike") {
    lower();
    if (distance(bot, faced) <= REACH) {
      bot.attack(faced);
      clocks.swung(faced.id);
      swung = true;
      note = swordReady ? " (swung)" : ` (swung with the sword ${SWORD_COOLDOWN_TICKS - (sinceSwing ?? 0)} ticks cold, reduced damage)`;
    } else note = " (nothing in reach, swing wasted, shield down for the window)";
  } else if (hands === "guard") raise();
  else if (hands === "cover") {
    lower();
    note = await buildCover(bot, clocks, labelled.map(({ enemy }) => enemy), faced);
    raise();
  } else lower();

  const applied: Applied = {
    face: faceChoice,
    facedId: faced.id,
    facedName: faced.name ?? "unknown",
    move,
    chosenMove: answers.move?.type === "choice" ? answers.move.choice : "hold",
    pace,
    jump,
    hands,
    swung,
    guarding: hands === "guard" || hands === "cover",
    controls,
    note,
    drift,
    groundThen,
    groundNow,
  };
  return { faced, applied };
}

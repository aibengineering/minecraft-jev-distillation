/**
 * How a decision window relates to game time, and how the loop advances
 * from one window to the next. The TIMING notes below are the reference
 * for every clock in the text and the feature row.
 */
import type { Bot } from "mineflayer";

import { SHIELD_READY_TICKS } from "./sense/constants.ts";

export type Regime = "latency" | "instant" | "frozen";

/** Bounds what a live jev fight can cost; a frozen fight is bounded by game time instead, and a free policy by game time alone. */
export const MAX_JEV_TURNS = 400;

/** A fight ends after this much game time in every regime: two minutes at twenty ticks a second. */
export const MAX_FIGHT_TICKS = 2400;

/** Ticks an answer holds in the instant and frozen regimes before the next question (JEV_STEP_TICKS). */
export const DEFAULT_HOLD_TICKS = 2;

/** A fixture may spawn replacements a tick after a kill (the gauntlet does), so a fight is over only after this many hostile-free ticks. */
export const CLEAR_TICKS = 40;

/** Until the first answer is measured, assume this much lag. */
export const DEFAULT_LEAD_TICKS = 6;

/*
 * TIMING. Three regimes relate a decision window to game time.
 *
 * latency (jev live): the world runs while jev thinks. The answer lands about
 *   `lead` ticks after the snapshot (measured, clamped to 3..12) and holds
 *   until the next answer, another round trip, so hold ≈ lead. The text is a
 *   forecast to the moment the answer lands, "walking" forecasts cover the
 *   lead, and a shield lowered now is active again after 2 * lead + 5 ticks.
 *
 * instant (a distilled model): the model answers in well under a tick, about
 *   0.2 ms for all five heads, so lead is 0. The loop applies the answer,
 *   lets `hold` ticks run, and asks again.
 *
 * frozen (jev with the world paused): the bot is an operator (op: true in
 *   the fixture) and freezes the server with `/tick freeze` while jev thinks,
 *   then runs exactly `hold` ticks with `/tick step`. Lead is 0 and hold is
 *   the step: the same shape as the instant regime, so jev's answers here are
 *   labels for exactly the regime the model runs in. What the freeze does and
 *   does not stop:
 *   - Mobs, arrows, creeper fuses and block updates stop. Our tick counter
 *     stops too, because Mineflayer skips the physics tick while
 *     bot.physicsEnabled is false, so every clock in the text (sword, shield,
 *     invulnerability, bow draw, arrow impact) is in stepped ticks.
 *   - Players are not frozen by the server. The bot's server-side sword
 *     cooldown, shield activation and hurt invulnerability keep recovering in
 *     real time during the pause: a 300 ms answer is six free ticks. The text
 *     jev reads follows the stepped clock, so its labels are conditioned on
 *     the same clocks the model will see; the bot is simply stronger than the
 *     text claims while collecting. Documented, not corrected.
 *   - The bot's client physics is disabled during the pause so it neither
 *     moves nor advances its clock. Mineflayer keeps draining its physics
 *     timer while disabled, so re-enabling produces no burst of catch-up
 *     ticks. bot.lookAt with force still turns the head and the look packet
 *     still goes out, so facing changes apply before the step.
 *   - Arrow flight estimates advance on a game clock of 50 ms per physics
 *     tick (src/sense/perception/game-clock.ts), not the wall clock, so a frozen arrow stays
 *     put. Bow draw timing already counts physics ticks.
 *   - A pause never starts with the bot in the air: the server counts a
 *     player's airborne ticks while frozen and kicks it for flying at 80,
 *     so a jump is stepped through to landing before the next pause.
 *   - The server steps its ticks as soon as the command arrives and the
 *     client ticks as soon as physics is re-enabled, both at 50 ms a tick, so
 *     the two clocks agree to within a tick per window.
 *   - The freeze outlives the fight on the server, which Mine Labs reuses
 *     across repeats: the loop unfreezes in its cleanup path, and every
 *     non-frozen fight sends an unfreeze at start in case an earlier client
 *     died frozen.
 *   - Wall time per window is jev's latency plus hold ticks, so 2400 game
 *     ticks can take ten minutes of wall time; fixture timeouts allow it.
 */
export interface Window {
  regime: Regime;
  lead: number;
  hold: number;
}

/** The current window, read by the text and snapshot builders; set per turn by the loop. */
let WINDOW: Window = { regime: "latency", lead: DEFAULT_LEAD_TICKS, hold: DEFAULT_LEAD_TICKS };

/** The window in force; the loop sets it at the start of every turn, before any sensing call. */
export function currentWindow(): Window {
  return WINDOW;
}
export function beginWindow(window: Window): void {
  WINDOW = window;
}

/** Ticks the bot can walk within the window: the lead in the latency regime, the hold otherwise. */
export function walkTicks(lead: number): number {
  return WINDOW.regime === "latency" ? lead : WINDOW.hold;
}

/** Ticks before a shield lowered now can be active again: another window, then activation. */
export function reguardTicks(lead: number): number {
  return (WINDOW.regime === "latency" ? 2 * lead : WINDOW.hold) + SHIELD_READY_TICKS;
}

/**
 * Sends a `/tick` command. Mine Labs turns command feedback off, so there is
 * no reply to read; `frozenNow` checks the effect instead.
 */
export function tickCommand(bot: Bot, args: string): void {
  bot.chat(`/tick ${args}`);
}

/**
 * Whether the world is frozen, by watching the world age: the server keeps
 * sending its time packet every twenty ticks even while frozen, but the age
 * in it stops climbing. Compares two packets received after the call, since
 * the first may still count ticks from before the freeze; about two seconds.
 */
export async function frozenNow(bot: Bot): Promise<boolean> {
  const nextAge = () => new Promise<number>((resolve) => bot.once("time", () => resolve(bot.time.age)));
  const first = await nextAge();
  const second = await nextAge();
  return second === first;
}

/**
 * Advances game time to the next window. Frozen: run exactly `hold` ticks
 * on the server and the client together, then pause again, never with the
 * bot in the air (the server kicks a player that floats through 80 of its
 * own ticks while frozen). Instant: let `hold` ticks run. Latency: one tick,
 * then ask again at once.
 */
export async function advance(bot: Bot, window: Window): Promise<void> {
  if (window.regime === "frozen") {
    bot.physicsEnabled = true;
    bot.chat(`/tick step ${window.hold}`);
    await bot.waitForTicks(window.hold);
    for (let extra = 0; !bot.entity.onGround && extra < 20; extra += 1) {
      bot.chat("/tick step 1");
      await bot.waitForTicks(1);
    }
    bot.physicsEnabled = false;
  } else if (window.regime === "instant") await bot.waitForTicks(window.hold);
  else await bot.waitForTicks(1);
}

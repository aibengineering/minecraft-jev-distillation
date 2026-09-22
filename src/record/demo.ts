/** Opt-in recording support. Normal fights never pause or write demo assets. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import type { SnapshotData } from "../sense/snapshot.ts";
import { tickCommand } from "../regime.ts";

export function demoMoment(snapshot: SnapshotData, landedAttacks: number): boolean {
  return landedAttacks >= 2 && snapshot.bot.onGround && snapshot.bot.health > 0
    && snapshot.enemies.some(e => e.name === "creeper" && e.distance <= 8 && e.los)
    && snapshot.enemies.some(e => e.name === "skeleton" && e.los && e.facing === "looking at the bot"
      && e.drawing && e.releaseIn !== null && e.releaseIn > 0 && e.releaseIn <= 6);
}

/** Confirm with two world-age packets; restore physics and ticking even on cancellation. */
export async function withDemoFreeze<T>(bot: Bot, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  const physics = bot.physicsEnabled;
  const stopped = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  const confirmed = new Promise<void>((resolve, reject) => {
    let age: number | undefined;
    const clean = () => { bot.off("time", onTime); stopped.removeEventListener("abort", onAbort); };
    const onAbort = () => { clean(); reject(new Error("Demo freeze interrupted or not confirmed within six seconds")); };
    const onTime = () => {
      if (age === undefined) age = bot.time.age;
      else { clean(); age === bot.time.age ? resolve() : reject(new Error("Demo freeze failed: world age still advancing")); }
    };
    bot.on("time", onTime);
    stopped.addEventListener("abort", onAbort, { once: true });
    if (stopped.aborted) onAbort();
  });
  try {
    bot.physicsEnabled = false;
    tickCommand(bot, "freeze");
    await confirmed;
    signal.throwIfAborted();
    return await action();
  } finally {
    bot.physicsEnabled = physics;
    tickCommand(bot, "unfreeze");
  }
}

export const demoWait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal });

export function saveDemo(run: string, moment: Record<string, unknown>, model: unknown): string {
  const directory = path.resolve(import.meta.dirname, "../../data/demo");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${run}.model.json`), JSON.stringify(model));
  const file = path.join(directory, `${run}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, preview: false, run, ...moment }, null, 2) + "\n");
  return file;
}

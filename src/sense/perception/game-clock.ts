/**
 * Game time in milliseconds: fifty per physics tick, so it stops whenever
 * the bot's physics is disabled, which is how the loop holds the bot still
 * while the server is frozen. Perception that extrapolates between packets
 * (arrow flight) reads this instead of the wall clock, so a frozen arrow
 * stays where the server left it. In the latency regime the two clocks run
 * at the same rate.
 */
import type { Bot } from "mineflayer";

export function gameClock(bot: Bot): () => number {
  let ms = 0;
  bot.on("physicsTick", () => {
    ms += 50;
  });
  return () => ms;
}

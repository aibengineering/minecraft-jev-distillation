import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { bowReleaseInTicks, trackBowDraws } from "./bow-timing.ts";

function fixture(flags?: number) {
  const entity = { id: 1, name: "skeleton", metadata: [] as number[], heldItem: { name: "bow" } };
  if (flags !== undefined) entity.metadata[8] = flags;
  const bot = Object.assign(new EventEmitter(), { entities: { 1: entity }, registry: { entitiesByName: { skeleton: { metadataKeys: [] } } } }) as unknown as Bot;
  return { bot, entity };
}

test("first draw is timed when the server omitted default zero hand flags", () => {
  const { bot, entity } = fixture();
  using tracker = trackBowDraws(bot);
  entity.metadata[8] = 1;
  bot.emit("entityUpdate", entity as never);
  expect(bowReleaseInTicks(bot, entity as never)).toBe(20);
  for (let tick = 0; tick < 14; tick++) bot.emit("physicsTick");
  expect(bowReleaseInTicks(bot, entity as never)).toBe(6);
  entity.metadata[8] = 0;
  bot.emit("entityUpdate", entity as never);
  expect(bowReleaseInTicks(bot, entity as never)).toBeNull();
});

test("joining an already drawn bow keeps its start unknown, including delayed equipment", () => {
  const { bot, entity } = fixture(1);
  using tracker = trackBowDraws(bot);
  expect(bowReleaseInTicks(bot, entity as never)).toBeNull();
  entity.heldItem.name = "air";
  bot.emit("physicsTick");
  entity.heldItem.name = "bow";
  bot.emit("physicsTick");
  expect(bowReleaseInTicks(bot, entity as never)).toBeNull();
});

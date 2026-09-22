import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import type { SnapshotData } from "../sense/snapshot.ts";
import { demoMoment, withDemoFreeze } from "./demo.ts";
import { Clocks } from "../sense/clocks.ts";
import type { RunLog } from "./run-log.ts";

test("landed attacks count distinct targeted sword swings, not misses, projectiles or duplicate events", () => {
  const client = new EventEmitter();
  const bot = Object.assign(new EventEmitter(), { _client: client, health: 20, entity: { id: 10 }, entities: { 20: { name: "zombie" } } }) as unknown as Bot;
  const clocks = new Clocks(bot, () => {}, { record() {} } as unknown as RunLog);
  const packet = { entityId: 20, sourceTypeId: 1, sourceCauseId: 11, sourceDirectId: 11 };
  client.emit("damage_event", packet); // No attack was sent.
  clocks.swung(20);
  client.emit("damage_event", { ...packet, sourceDirectId: 99 }); // Projectile.
  client.emit("damage_event", { ...packet, entityId: 21 }); // A different target / sweep damage.
  expect(clocks.swordHits).toHaveLength(0);
  client.emit("damage_event", packet);
  client.emit("damage_event", packet);
  expect(clocks.swordHits).toHaveLength(1);
  clocks.tick = 14;
  clocks.swung(20);
  expect(clocks.swordHits).toHaveLength(1); // Sending a second swing is not a hit yet.
  client.emit("damage_event", packet);
  expect(clocks.swordHits).toEqual([{ tick: 0, swingTick: 0, targetId: 20 }, { tick: 14, swingTick: 14, targetId: 20 }]);
});

test("capture requires a known imminent bow draw, visible creeper and grounded live bot", () => {
  const snapshot = { bot: { onGround: true, health: 20 }, enemies: [
    { name: "creeper", distance: 5, los: true },
    { name: "skeleton", los: true, facing: "looking at the bot", drawing: true, releaseIn: 5 },
  ] } as unknown as SnapshotData;
  expect(demoMoment(snapshot, 0)).toBe(false);
  expect(demoMoment(snapshot, 1)).toBe(false);
  expect(demoMoment(snapshot, 2)).toBe(true);
  for (const release of [null, 0, 7]) {
    snapshot.enemies[1]!.releaseIn = release;
    expect(demoMoment(snapshot, 2)).toBe(false);
  }
  snapshot.enemies[1]!.releaseIn = 5;
  snapshot.bot.onGround = false;
  expect(demoMoment(snapshot, 2)).toBe(false);
  snapshot.bot.onGround = true;
  snapshot.enemies[0]!.los = false;
  expect(demoMoment(snapshot, 2)).toBe(false);
});

test("freeze restores server and physics, and removes listeners when capture fails", async () => {
  const commands: string[] = [];
  const bot = Object.assign(new EventEmitter(), { physicsEnabled: true, time: { age: 20 }, chat(command: string) {
    commands.push(command);
    if (command === "/tick freeze") queueMicrotask(() => { bot.emit("time"); bot.emit("time"); });
  } }) as unknown as Bot;
  await expect(withDemoFreeze(bot, new AbortController().signal, async () => {
    expect(bot.physicsEnabled).toBe(false);
    throw new Error("disk full");
  })).rejects.toThrow("disk full");
  expect(commands).toEqual(["/tick freeze", "/tick unfreeze"]);
  expect(bot.physicsEnabled).toBe(true);
  expect(bot.listenerCount("time")).toBe(0);
});

test("cancellation before freeze acknowledgement releases the server", async () => {
  const commands: string[] = [];
  const controller = new AbortController();
  const bot = Object.assign(new EventEmitter(), { physicsEnabled: true, time: { age: 20 }, chat(command: string) {
    commands.push(command);
    if (command === "/tick freeze") controller.abort();
  } }) as unknown as Bot;
  await expect(withDemoFreeze(bot, controller.signal, async () => {})).rejects.toThrow("interrupted");
  expect(commands.at(-1)).toBe("/tick unfreeze");
  expect(bot.physicsEnabled).toBe(true);
  expect(bot.listenerCount("time")).toBe(0);
});

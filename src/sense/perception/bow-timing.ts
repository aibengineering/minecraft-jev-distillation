/**
 * When a drawn bow will release. Ported from mine-ai-mcp's combat perception.
 *
 * A skeleton holds its draw for twenty ticks before firing. The draw start is
 * observed from the hand-state metadata transition, so an entity already
 * drawing when the tracker starts has an unknown start and reads as due now.
 * This is release timing, not a promise of a shot.
 */
import type { Bot } from "mineflayer";
import { isDrawingBow } from "./attention.ts";

type Entity = Bot["entity"];
type Draw = { entity: Entity; active: boolean; started: number | null };
const readers = new WeakMap<Bot, (entity: Entity) => number | null>();

const ARCHERS = ["skeleton", "stray", "bogged"];
const DRAW_TICKS = 20;

/** Ticks until the drawn bow releases, or null when the entity is not drawing. Zero means it may fire any tick. */
export function bowReleaseInTicks(bot: Bot, entity: Entity): number | null {
  return readers.get(bot)?.(entity) ?? null;
}

/** Observe draw transitions every tick, independently of how often decisions read them. */
export function trackBowDraws(bot: Bot): Disposable {
  const draws = new Map<number, Draw>();
  let tick = 0;
  const observe = () => {
    for (const entity of Object.values(bot.entities)) {
      if (!ARCHERS.includes(entity.name ?? "")) continue;
      const previous = draws.get(entity.id);
      const keyIndex = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf("living_entity_flags") ?? -1;
      const index = keyIndex < 0 ? 8 : keyIndex;
      // Unchanged zero-valued hand flags can be absent from spawn metadata. Remember that
      // inactive baseline so the first 0 -> 1 packet has a known draw start too.
      const flags: unknown = entity.metadata?.[index] ?? 0;
      if (typeof flags !== "number") continue;
      // Equipment may arrive after metadata. That must not manufacture a new draw start.
      const active = (flags & 1) !== 0;
      draws.set(entity.id, {
        entity,
        active,
        started: !active ? null : previous?.entity !== entity ? null : !previous.active ? tick : previous.started,
      });
    }
  };
  const advance = () => {
    tick++;
    observe();
  };
  const gone = (entity: Entity) => {
    draws.delete(entity.id);
  };
  const clear = () => draws.clear();
  const read = (entity: Entity) => {
    const draw = draws.get(entity.id);
    return draw?.entity === entity && draw.active && isDrawingBow(bot, entity) && draw.started !== null
      ? Math.max(0, DRAW_TICKS - (tick - draw.started))
      : null;
  };
  observe();
  readers.set(bot, read);
  bot.on("physicsTick", advance);
  bot.on("entityUpdate", observe);
  bot.on("entityGone", gone);
  bot.on("respawn", clear);
  return {
    [Symbol.dispose]() {
      bot.off("physicsTick", advance);
      bot.off("entityUpdate", observe);
      bot.off("entityGone", gone);
      bot.off("respawn", clear);
      if (readers.get(bot) === read) readers.delete(bot);
    },
  };
}

/**
 * Whether an archer is drawing. Ported from mine-ai-mcp's combat perception.
 *
 * The server publishes a living entity's hand state in its metadata: bit 1 of
 * `living_entity_flags` is set while the entity uses its held item, which for
 * a bow holder is the draw. Nothing says where it aims; the draw is the cue.
 */
import type { Bot } from "mineflayer";

type Entity = Parameters<Bot["attack"]>[0];

export function isDrawingBow(bot: Bot, entity: Entity): boolean {
  if (entity.heldItem?.name !== "bow") return false;
  const keys = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys;
  const keyIndex = keys?.indexOf("living_entity_flags") ?? -1;
  const index = keyIndex < 0 ? 8 : keyIndex;
  const flags: unknown = entity.metadata?.[index];
  return typeof flags === "number" && (flags & 1) !== 0;
}

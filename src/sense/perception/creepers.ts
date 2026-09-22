/**
 * Whether a creeper's fuse is running. Ported from mine-ai-mcp's combat perception.
 *
 * A creeper's `swell_dir` metadata is 1 while it is swelling toward a blast
 * and -1 while the swell unwinds. The counter behind it climbs one a tick
 * within about three blocks of its target and falls one a tick outside, and
 * the blast comes at thirty; the decision loop keeps that counter itself.
 */
import type { Bot } from "mineflayer";

type Entity = Bot["entity"];

export function isSwelling(bot: Bot, entity: Entity): boolean {
  const index = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf("swell_dir") ?? -1;
  const direction: unknown = index >= 0 ? entity.metadata?.[index] : undefined;
  return direction === 1;
}

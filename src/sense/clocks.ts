/**
 * Tick counters for everything with a cooldown, kept from events rather than
 * guessed: swings, the shield, hits on the bot (attributed by the server's
 * damage packet, with a geometric fallback), hits on enemies, shield blocks,
 * creeper fuses. Also writes the per-tick frame the viewer replays.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

import type { RunLog } from "../record/run-log.ts";
import { CREEPER_FUSE_TICKS, REACH, SHIELD_READY_TICKS, isProjectile, isRanged } from "./constants.ts";
import { distance, relativeBearing, ticksText, vec } from "./geometry.ts";
import { arrowFlight } from "./perception/arrow-flight.ts";
import { isDrawingBow } from "./perception/attention.ts";
import { isSwelling } from "./perception/creepers.ts";
import { health, hostiles, onFire, witherTicks } from "./world.ts";


interface DamagePacket {
  entityId: number;
  sourceTypeId: number;
  /** Entity id plus one of whoever is responsible, or 0. */
  sourceCauseId: number;
  /** Entity id plus one of what actually touched the body (the arrow, or the mob itself), or 0. */
  sourceDirectId: number;
}

/** Tick counters for everything that has a cooldown, kept from events rather than guessed. */
export class Clocks {
  tick = 0;
  lastSwing: number | null = null;
  /** Direct hits acknowledged by the server, at most one per targeted sword swing. */
  readonly swordHits: { tick: number; swingTick: number; targetId: number }[] = [];
  #swingTarget: number | null = null;
  #confirmedSwing: number | null = null;
  shieldRaised: number | null = null;
  botHurt: number | null = null;
  /** What last hurt the bot, from the damage packet, so a hit is attributed by the server rather than inferred. */
  lastHitBy = "nothing yet";
  /** Tick of the last damage packet naming the bot, so a health drop can tell a fresh packet from a stale one. */
  lastHitPacketTick: number | null = null;
  /** Enemy id to the tick it last hit the bot, from the damage packet's cause. */
  readonly hitUs = new Map<number, number>();
  /** Enemy id to the tick it was last hurt. */
  readonly hurt = new Map<number, number>();
  /** Ticks at which the server said the shield blocked something (entity status 29). */
  readonly blocks: number[] = [];
  /** Creeper id to its fuse counter, kept the way the server keeps it: up while swelling, down otherwise. */
  readonly fuse = new Map<number, number>();
  /** Creeper ids seen last tick, so a creeper that vanishes can be told apart from one that walked off. */
  #creepersLastTick = new Map<number, number>();
  /** Tick at which a creeper last vanished, which is a blast unless it was killed. */
  creeperVanishedAt: number | null = null;
  #health: number;

  constructor(
    private readonly bot: Bot,
    private readonly log: (line: string) => void,
    private readonly runLog: RunLog,
  ) {
    this.#health = bot.health;
    bot.on("physicsTick", () => {
      this.tick += 1;
      const seen = new Map<number, number>();
      for (const enemy of hostiles(bot)) {
        if (enemy.name !== "creeper") continue;
        const swelling = isSwelling(bot, enemy);
        const value = Math.max(0, Math.min(CREEPER_FUSE_TICKS, (this.fuse.get(enemy.id) ?? 0) + (swelling ? 1 : -1)));
        this.fuse.set(enemy.id, value);
        seen.set(enemy.id, value);
      }
      for (const [id, value] of this.#creepersLastTick) {
        if (!seen.has(id) && value > 0) this.creeperVanishedAt = this.tick;
      }
      this.#creepersLastTick = seen;
      this.frame();
    });
    // The health packet is the ground truth for the bot's own damage; the
    // damage packet, which arrives just before it, says who did it.
    bot.on("health", () => {
      const lost = this.#health - bot.health;
      this.#health = bot.health;
      if (lost <= 0) return;
      const hitTick = this.tick;
      const shield = this.shieldState();
      const position = vec(bot.entity.position);
      const yaw = Math.round(bot.entity.yaw * 1000) / 1000;
      const arrowsAtHit = this.arrowsNow();
      this.botHurt = hitTick;
      // The damage packet, when it comes, arrives within a tick of the health
      // packet, before or after. Wait for it; if it never comes, attribute by
      // geometry: the melee enemy in reach, else an arrow beside the body.
      const candidates = hostiles(bot).filter((enemy) => distance(bot, enemy) <= REACH + 1 && !isRanged(enemy));
      const arrowNearby = Object.values(bot.entities).some(
        (entity) => entity.isValid && isProjectile(entity.name) && arrowFlight(bot, entity).position.distanceTo(bot.entity.position) <= 2,
      );
      // Through iron armour a zombie does 1.38 here; arrows do 1.9 to 2.5; a deflected arrow much less.
      const zombieSized = lost > 1.2 && lost < 1.6;
      void bot.waitForTicks(2).then(() => {
        const fromPacket = this.lastHitPacketTick !== null && this.lastHitPacketTick >= hitTick - 1;
        let by = this.lastHitBy;
        let how = "damage packet";
        if (!fromPacket) {
          const melee = candidates.sort((a, b) => distance(bot, a) - distance(bot, b))[0];
          if (this.creeperVanishedAt !== null && Math.abs(this.creeperVanishedAt - hitTick) <= 2) {
            by = "creeper explosion (inferred: a creeper with a running fuse vanished on that tick)";
          } else if (arrowNearby && !zombieSized) {
            by = lost < 1 ? "deflected arrow (inferred: an arrow beside the body, small damage, no damage packet)" : "arrow (inferred: an arrow beside the body, arrow-sized damage, no damage packet)";
          } else if (melee) {
            by = `${melee.name} (inferred: in reach, no damage packet)`;
            this.hitUs.set(melee.id, hitTick);
          } else if (arrowNearby) by = "arrow (inferred: an arrow beside the body, no damage packet)";
          else by = "unknown (no damage packet, nothing in reach)";
          how = "inferred";
          this.lastHitBy = by;
        }
        this.log(`  HIT for ${lost.toFixed(1)} by ${by} at tick ${hitTick}; shield ${shield}; ${arrowsAtHit}`);
        this.runLog.record({ kind: "hit", tick: hitTick, amount: Math.round(lost * 100) / 100, by, how, health: bot.health, shield, position, yaw, arrows: arrowsAtHit });
      });
    });
    bot._client.on("entity_status", (packet: { entityId: number; entityStatus: number }) => {
      if (packet.entityId !== bot.entity.id) return;
      if (packet.entityStatus === 29) {
        this.blocks.push(this.tick);
        this.log(`  SHIELD BLOCKED a hit at tick ${this.tick}; ${this.arrowsNow()}`);
      }
      this.runLog.record({ kind: "status", tick: this.tick, status: packet.entityStatus });
    });
    bot._client.on("damage_event", (packet: DamagePacket) => {
      const named = bot.entities[packet.entityId];
      this.log(
        `  damage packet at tick ${this.tick}: entity ${packet.entityId} (${packet.entityId === bot.entity.id ? "the bot" : named?.name ?? "unknown"}) ` +
          `type ${packet.sourceTypeId} cause ${packet.sourceCauseId} direct ${packet.sourceDirectId}`,
      );
      this.runLog.record({ kind: "damage_packet", tick: this.tick, ...packet, isBot: packet.entityId === bot.entity.id, entityName: named?.name ?? null });
      if (packet.entityId !== bot.entity.id) {
        this.hurt.set(packet.entityId, this.tick);
        if (packet.entityId === this.#swingTarget && this.lastSwing !== null && this.lastSwing !== this.#confirmedSwing
          && packet.sourceCauseId === bot.entity.id + 1 && packet.sourceDirectId === bot.entity.id + 1) {
          this.#confirmedSwing = this.lastSwing;
          const hit = { tick: this.tick, swingTick: this.lastSwing, targetId: packet.entityId };
          this.swordHits.push(hit);
          this.runLog.record({ kind: "sword_hit", ...hit });
        }
        return;
      }
      this.lastHitPacketTick = this.tick;
      // Both ids are entity id plus one, zero meaning none; checked against the frames.
      const cause = packet.sourceCauseId > 0 ? bot.entities[packet.sourceCauseId - 1] : undefined;
      const direct = packet.sourceDirectId > 0 ? bot.entities[packet.sourceDirectId - 1] : undefined;
      const causeName = cause?.name ?? (onFire(bot) ? "burning" : witherTicks(bot) > 0 ? "wither" : "the environment");
      this.lastHitBy = direct && cause && direct.id !== cause.id ? `${direct.name ?? "projectile"} from ${causeName}` : causeName;
      this.log(
        `  damage packet: cause ${packet.sourceCauseId} direct ${packet.sourceDirectId} type ${packet.sourceTypeId}; ` +
          `cause-1=${bot.entities[packet.sourceCauseId - 1]?.name ?? "?"} cause=${bot.entities[packet.sourceCauseId]?.name ?? "?"} ` +
          `direct-1=${bot.entities[packet.sourceDirectId - 1]?.name ?? "?"} direct=${bot.entities[packet.sourceDirectId]?.name ?? "?"}`,
      );
      if (cause && (!direct || direct.id === cause.id)) this.hitUs.set(cause.id, this.tick);
    });
  }

  since(at: number | null): number | null {
    return at === null ? null : this.tick - at;
  }

  swung(targetId: number): void {
    this.lastSwing = this.tick;
    this.#swingTarget = targetId;
    this.runLog.record({ kind: "swing", tick: this.tick, targetId });
  }

  shield(up: boolean): void {
    this.shieldRaised = up ? this.tick : null;
    this.runLog.record({ kind: "shield", tick: this.tick, up });
  }

  /** One record per physics tick: everything the replay needs to draw the fight between decisions. */
  frame(): void {
    const bot = this.bot;
    const controls = Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const).map((name) => [name, bot.getControlState(name)]),
    );
    this.runLog.record(
      {
        kind: "frame",
        tick: this.tick,
        bot: {
          position: vec(bot.entity.position),
          yaw: Math.round(bot.entity.yaw * 1000) / 1000,
          health: Math.round(bot.health * 100) / 100,
          onGround: bot.entity.onGround,
          shieldUp: bot.usingHeldItem,
          shieldServer: this.serverShieldUp(),
          controls: Object.entries(controls).filter(([, on]) => on).map(([name]) => name),
        },
        enemies: hostiles(bot).map((enemy) => ({
          id: enemy.id,
          name: enemy.name ?? "unknown",
          position: vec(enemy.position),
          yaw: Math.round(enemy.yaw * 1000) / 1000,
          health: health(enemy) ?? null,
          drawing: isDrawingBow(bot, enemy),
        })),
        arrows: Object.values(bot.entities)
          .filter((entity) => entity.isValid && isProjectile(entity.name))
          .map((arrow) => {
            const flight = arrowFlight(bot, arrow);
            return { id: arrow.id, kind: arrow.name, position: vec(flight.position), velocity: vec(flight.velocity), stopped: flight.velocity.norm() === 0 };
          }),
      },
      true,
    );
  }

  /** Arrows in flight by their flight estimate, as bearing and distance from the bot, for the hit log. */
  arrowsNow(): string {
    const bot = this.bot;
    const arrows = Object.values(bot.entities).filter((entity) => entity.isValid && isProjectile(entity.name) && arrowFlight(bot, entity).velocity.norm() > 0);
    if (arrows.length === 0) return "no arrows in flight";
    return `arrows: ${arrows
      .map((arrow) => {
        const flight = arrowFlight(bot, arrow);
        const d = flight.position.minus(bot.entity.position);
        return `${Math.hypot(d.x, d.z).toFixed(1)} blocks ${relativeBearing(bot.entity.yaw, d)}${flight.velocity.norm() === 0 ? " (stopped)" : ""}`;
      })
      .join(", ")}`;
  }

  /** Whether the server says the bot's off hand is active, from its own living-entity flags (bit 1 active, bit 2 off hand). */
  serverShieldUp(): boolean {
    const flags = (this.bot.entity.metadata as unknown[] | undefined)?.[8];
    return typeof flags === "number" && (flags & 1) !== 0 && (flags & 2) !== 0;
  }

  shieldState(): string {
    const sinceRaised = this.since(this.shieldRaised);
    const server = this.serverShieldUp();
    if (!this.bot.usingHeldItem || sinceRaised === null) return server ? "down here but server says up" : "down";
    const active = sinceRaised >= SHIELD_READY_TICKS;
    return `${active ? "up and active" : `up, active in ${ticksText(SHIELD_READY_TICKS - sinceRaised)}`}${server ? " (server confirms)" : " (server says hands idle)"}`;
  }
}

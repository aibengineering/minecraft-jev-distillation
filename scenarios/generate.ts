/**
 * Writes fixture variants with randomised terrain and spawns, so thirty runs
 * are thirty different fights rather than thirty samples of one opening.
 *
 *   bun scenarios/generate.ts --count 20 --seed 1        # scenarios/generated/gen-1-01.yaml ...
 *   bun src/run.ts scenarios/generated --frozen --step 2  # runs the folder
 *
 * Each fixture is the compact arena (23 x 15 walkable, feet at y=-60) with two
 * to four terrain features drawn from steps, two-high wall segments, one-deep
 * hollows, pillars and water pools, and two to four mobs drawn from zombies,
 * skeletons and creepers, spawned at least six blocks from the bot and off
 * the features. The bot carries cobblestone for cover. Names are
 * jev-gen-<seed>-<n>; review scripts fold them into one "gen" family.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1]!;
};
const count = Number(option("--count", "10"));
const seed = Number(option("--seed", "1"));
const outDir = path.resolve(option("--out", path.join(import.meta.dirname, "generated")));

/** Mulberry32: small, seedable, good enough for layouts. */
function rng(s: number): () => number {
  let a = s >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The compact arena: floor top at y=-61, feet at y=-60, walls from x=-6 and 18, z=-8 and 8.
const X_MIN = -5, X_MAX = 17, Z_MIN = -7, Z_MAX = 7;
const BOT = { x: 0.5, z: 0.5 };
const ARENA_GEOMETRY = [
  "  - fill: { block: bedrock, from: [-6, -64, -8], to: [18, -64, 8] }",
  "  - fill: { block: dirt, from: [-6, -63, -8], to: [18, -62, 8] }",
  "  - fill: { block: sea_lantern, from: [-6, -61, -8], to: [18, -61, 8] }",
  "  - fill: { block: bedrock, from: [-6, -63, -8], to: [-6, -58, 8] }",
  "  - fill: { block: bedrock, from: [18, -63, -8], to: [18, -58, 8] }",
  "  - fill: { block: bedrock, from: [-5, -63, -8], to: [17, -58, -8] }",
  "  - fill: { block: bedrock, from: [-5, -63, 8], to: [17, -58, 8] }",
];

interface Footprint {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
const overlaps = (a: Footprint, b: Footprint, margin = 1) => a.x0 - margin <= b.x1 && b.x0 - margin <= a.x1 && a.z0 - margin <= b.z1 && b.z0 - margin <= a.z1;
const BOT_ZONE: Footprint = { x0: -2, x1: 3, z0: -2, z1: 3 };

for (let n = 1; n <= count; n += 1) {
  const random = rng(seed * 1000 + n);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));

  const footprints: Footprint[] = [BOT_ZONE];
  const geometry: string[] = [...ARENA_GEOMETRY];
  const notes: string[] = [];
  const featureCount = between(2, 4);
  for (let attempt = 0; attempt < 40 && footprints.length - 1 < featureCount; attempt += 1) {
    const kind = pick(["step", "step", "wall", "wall", "hollow", "pillar", "water"] as const);
    const w = kind === "pillar" ? 1 : kind === "wall" ? between(1, 3) : between(2, 4);
    const d = kind === "pillar" ? 1 : kind === "wall" ? between(2, 4) : between(2, 4);
    const x0 = between(X_MIN + 1, X_MAX - w), z0 = between(Z_MIN + 1, Z_MAX - d);
    const fp: Footprint = { x0, x1: x0 + w - 1, z0, z1: z0 + d - 1 };
    if (footprints.some((other) => overlaps(fp, other))) continue;
    footprints.push(fp);
    if (kind === "step") geometry.push(`  - fill: { block: stone, from: [${fp.x0}, -60, ${fp.z0}], to: [${fp.x1}, -60, ${fp.z1}] }`);
    else if (kind === "wall") geometry.push(`  - fill: { block: cobblestone, from: [${fp.x0}, -60, ${fp.z0}], to: [${fp.x1}, -59, ${fp.z1}] }`);
    else if (kind === "hollow") geometry.push(`  - fill: { block: air, from: [${fp.x0}, -61, ${fp.z0}], to: [${fp.x1}, -61, ${fp.z1}] }`);
    else if (kind === "pillar") geometry.push(`  - fill: { block: cobblestone, from: [${fp.x0}, -60, ${fp.z0}], to: [${fp.x0}, -59, ${fp.z0}] }`);
    else geometry.push(`  - fill: { block: water, from: [${fp.x0}, -61, ${fp.z0}], to: [${fp.x1}, -61, ${fp.z1}] }`);
    notes.push(`${kind} ${w}x${d} at ${fp.x0},${fp.z0}`);
  }

  const mobs: { type: string; x: number; z: number }[] = [];
  const mobCount = between(2, 4);
  const kinds = new Set<string>();
  for (let attempt = 0; attempt < 60 && mobs.length < mobCount; attempt += 1) {
    const type = pick(["zombie", "zombie", "zombie", "skeleton", "skeleton", "creeper"] as const);
    if (type === "creeper" && mobs.some((m) => m.type === "creeper")) continue;
    const x = between(X_MIN + 1, X_MAX - 1), z = between(Z_MIN + 1, Z_MAX - 1);
    if (Math.hypot(x + 0.5 - BOT.x, z + 0.5 - BOT.z) < 6) continue;
    const fp: Footprint = { x0: x, x1: x, z0: z, z1: z };
    if (footprints.some((other) => overlaps(fp, other, 0))) continue;
    if (mobs.some((m) => Math.hypot(m.x - x, m.z - z) < 2)) continue;
    mobs.push({ type, x, z });
    kinds.add(type);
  }

  const entities = mobs.map((m) =>
    m.type === "skeleton"
      ? `  - { type: skeleton, pos: [${m.x + 0.5}, -60, ${m.z + 0.5}], nbt: '{PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}' }`
      : `  - { type: ${m.type}, pos: [${m.x + 0.5}, -60, ${m.z + 0.5}], nbt: "{PersistenceRequired:1b}" }`,
  );
  const goals = [...kinds].map((kind) => `    - { kind: entityCount, entity: ${kind}, max: 0 }`);
  const id = `${seed}-${String(n).padStart(2, "0")}`;
  const yaml = `name: jev-gen-${id}
description: "Generated fight ${id}: ${mobs.map((m) => m.type).join(", ")}; terrain ${notes.join("; ") || "flat"}."

world:
  type: flat
  time: midnight
  difficulty: normal
  gamerules:
    doDaylightCycle: false
    doMobSpawning: false
    naturalRegeneration: false
    mobGriefing: false

# The compact arena's own geometry plus this fixture's features (a fixture's geometry replaces the template's).
geometry:
${geometry.join("\n")}

players:
  - name: JevFighter
    pos: [0.5, -60, 0.5]
    # Operator so the client can freeze and step the server (JEV_FROZEN, see TIMING in src/regime.ts).
    op: true
    inventory:
      - { item: diamond_sword, count: 1 }
      - { item: shield, count: 1 }
      - { item: iron_helmet, count: 1 }
      - { item: iron_chestplate, count: 1 }
      - { item: iron_leggings, count: 1 }
      - { item: iron_boots, count: 1 }
      - { item: cobblestone, count: 16 }

entities:
${entities.join("\n")}

client:
  command: bun
  args: ["../../src/fight.ts"]

goal:
  kind: all
  # Wall time. A frozen fight spends jev's latency per window on top of game time, so allow ten minutes.
  timeout: 600
  goals:
${goals.join("\n")}
    - { kind: completion, who: JevFighter }
`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `gen-${id}.yaml`), yaml);
  console.log(`gen-${id}: ${mobs.map((m) => m.type).join(", ")} | ${notes.join("; ") || "flat"}`);
}
console.log(`wrote ${count} fixtures to ${outDir}`);

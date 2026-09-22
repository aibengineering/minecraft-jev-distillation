/**
 * Writes the two nether-styled fixtures: a basalt delta with uneven columns,
 * and an open nether fortress hall with wither skeletons and a blaze.
 *
 *   bun scenarios/generate-nether.ts        # scenarios/basalt-delta.yaml, scenarios/nether-fortress.yaml
 *
 * Both use the compact arena footprint (walkable x -5..17, z -7..7, feet at
 * y=-60). The basalt layout is drawn from a fixed seed so the file is stable.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

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

const HEADER = (name: string, description: string, gamerules: string[]) => `name: ${name}
description: "${description}"

world:
  type: flat
  time: midnight
  difficulty: normal
  gamerules:
    doDaylightCycle: false
    doMobSpawning: false
    naturalRegeneration: false
${gamerules.map((rule) => `    ${rule}`).join("\n")}
`;

const PLAYER = `players:
  - name: JevFighter
    pos: [0.5, -60, 0.5]
    # Operator so the client can freeze and step the server (JEV_FROZEN, see TIMING in src/regime.ts).
    op: true
    inventory:
      - { item: diamond_sword, count: 1 }
      - { item: cobblestone, count: 16 }
      - { item: shield, count: 1 }
      - { item: iron_helmet, count: 1 }
      - { item: iron_chestplate, count: 1 }
      - { item: iron_leggings, count: 1 }
      - { item: iron_boots, count: 1 }
`;

const CLIENT = `client:
  command: bun
  args: ["../src/fight.ts"]
`;

// Basalt delta: blackstone floor, basalt columns one to three high, magma patches, one lava pool.
{
  const random = rng(2026);
  const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const geometry = [
    "  - fill: { block: bedrock, from: [-6, -64, -8], to: [18, -64, 8] }",
    "  - fill: { block: basalt, from: [-6, -63, -8], to: [18, -62, 8] }",
    "  - fill: { block: blackstone, from: [-6, -61, -8], to: [18, -61, 8] }",
    "  - fill: { block: basalt, from: [-6, -63, -8], to: [-6, -58, 8] }",
    "  - fill: { block: basalt, from: [18, -63, -8], to: [18, -58, 8] }",
    "  - fill: { block: basalt, from: [-5, -63, -8], to: [17, -58, -8] }",
    "  - fill: { block: basalt, from: [-5, -63, 8], to: [17, -58, 8] }",
    // The floor is dim under a night sky; light it from the top course of the long walls so the replay reads.
    "  - fill: { block: shroomlight, from: [-6, -58, -8], to: [18, -58, -8] }",
    "  - fill: { block: shroomlight, from: [-6, -58, 8], to: [18, -58, 8] }",
  ];
  // Cells kept clear: the bot's spawn and the three mob spawns, with a margin.
  const taken = new Set<string>();
  const clear = (x: number, z: number, r = 1) => {
    for (let dx = -r; dx <= r; dx += 1) for (let dz = -r; dz <= r; dz += 1) taken.add(`${x + dx},${z + dz}`);
  };
  clear(0, 0);
  clear(9, 3);
  clear(9, -4);
  clear(15, 0);
  const notes: string[] = [];
  let columns = 0;
  const place = (cx: number, cz: number, h: number) => {
    if (h < 1 || cx < -4 || cx > 16 || cz < -6 || cz > 6 || taken.has(`${cx},${cz}`)) return;
    taken.add(`${cx},${cz}`);
    geometry.push(`  - fill: { block: basalt, from: [${cx}, -60, ${cz}], to: [${cx}, ${-61 + h}, ${cz}] }`);
    columns += 1;
  };
  // Three raised plateaus, one block up, two to three cells wide: ground the bot can fight from and be pinned against.
  for (let i = 0; i < 3; i += 1) {
    const x = between(-3, 13), z = between(-5, 3), w = between(2, 3), d = between(2, 3);
    let ok = true;
    for (let dx = 0; dx < w; dx += 1) for (let dz = 0; dz < d; dz += 1) if (taken.has(`${x + dx},${z + dz}`)) ok = false;
    if (!ok) continue;
    for (let dx = 0; dx < w; dx += 1) for (let dz = 0; dz < d; dz += 1) place(x + dx, z + dz, 1);
  }
  // Columns in clumps: a seed one to three high, neighbours a step lower with a good chance, their neighbours lower again.
  for (let attempt = 0; attempt < 600 && columns < 70; attempt += 1) {
    const x = between(-4, 16), z = between(-6, 6);
    if (taken.has(`${x},${z}`)) continue;
    const height = between(1, 3);
    place(x, z, height);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (random() < 0.65) {
        place(x + dx, z + dz, height - 1);
        for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (random() < 0.35) place(x + dx + ex, z + dz + ez, height - 2);
      }
    }
  }
  notes.push(`${columns} basalt cells in clumps and three plateaus`);
  // Two one-deep hollows the ground drops into.
  for (const [x, z] of [[3, 4], [12, -6]] as const) {
    geometry.push(`  - fill: { block: air, from: [${x}, -61, ${z}], to: [${x + 1}, -61, ${z + 1}] }`);
    clear(x, z, 0);
    clear(x + 1, z + 1, 0);
  }
  notes.push("two hollows");
  // Magma patches burn a bot that stands on them (unless sneaking); two of them, flush with the floor.
  for (const [x, z] of [[9, 4], [4, -5]] as const) {
    geometry.push(`  - fill: { block: magma_block, from: [${x}, -61, ${z}], to: [${x + 1}, -61, ${z + 1}] }`);
    for (const c of [`${x},${z}`, `${x + 1},${z}`, `${x},${z + 1}`, `${x + 1},${z + 1}`]) taken.add(c);
  }
  notes.push("two magma patches");
  // One lava pool, sunk into the floor away from the spawns.
  geometry.push("  - fill: { block: lava, from: [13, -61, -3], to: [14, -61, -2] }");
  notes.push("a lava pool at 13,-3");
  const yaml =
    HEADER("jev-basalt-delta", `Uneven basalt-delta ground: ${notes.join(", ")}; two zombies and a bow skeleton. The loop refuses any move into lava or off a drop.`, ["mobGriefing: false"]) +
    `
# The arena's own geometry: the compact footprint in nether blocks, with the columns drawn from a fixed seed.
geometry:
${geometry.join("\n")}

${PLAYER}
entities:
  - { type: zombie, pos: [9.5, -60, 3.5], nbt: "{PersistenceRequired:1b}" }
  - { type: zombie, pos: [9.5, -60, -3.5], nbt: "{PersistenceRequired:1b}" }
  - { type: skeleton, pos: [15.5, -60, 0.5], nbt: '{PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}' }

${CLIENT}
goal:
  kind: all
  # Wall time. A frozen fight spends jev's latency per window on top of game time, so allow ten minutes.
  timeout: 600
  goals:
    - { kind: entityCount, entity: zombie, max: 0 }
    - { kind: entityCount, entity: skeleton, max: 0 }
    - { kind: completion, who: JevFighter }
`;
  writeFileSync(path.join(import.meta.dirname, "basalt-delta.yaml"), yaml);
  console.log(`basalt-delta: ${notes.join(", ")}`);
}

// Nether fortress: nether brick floor, walls and a ceiling nine blocks up so the blaze stays in; two wither skeletons and a blaze.
{
  const geometry = [
    "  - fill: { block: bedrock, from: [-6, -64, -8], to: [18, -64, 8] }",
    "  - fill: { block: nether_bricks, from: [-6, -63, -8], to: [18, -61, 8] }",
    "  - fill: { block: nether_bricks, from: [-6, -63, -8], to: [-6, -58, 8] }",
    "  - fill: { block: nether_bricks, from: [18, -63, -8], to: [18, -58, 8] }",
    "  - fill: { block: nether_bricks, from: [-5, -63, -8], to: [17, -58, -8] }",
    "  - fill: { block: nether_bricks, from: [-5, -63, 8], to: [17, -58, 8] }",
    "  - fill: { block: glowstone, from: [-6, -58, -8], to: [18, -58, -8] }",
    "  - fill: { block: glowstone, from: [-6, -58, 8], to: [18, -58, 8] }",
    // The blaze flies: an invisible barrier cage above the low walls keeps it in without hiding the fight.
    "  - fill: { block: barrier, from: [-6, -57, -8], to: [-6, -55, 8] }",
    "  - fill: { block: barrier, from: [18, -57, -8], to: [18, -55, 8] }",
    "  - fill: { block: barrier, from: [-5, -57, -8], to: [17, -55, -8] }",
    "  - fill: { block: barrier, from: [-5, -57, 8], to: [17, -55, 8] }",
    "  - fill: { block: barrier, from: [-6, -54, -8], to: [18, -54, 8] }",
    // Ceiling: a blaze hovers a few blocks above its target and would leave an open arena.
    // Two low nether-brick walls for cover from the blaze, and a pillar.
    "  - fill: { block: nether_bricks, from: [6, -60, -1], to: [6, -59, 1] }",
    "  - fill: { block: nether_bricks, from: [11, -60, 3], to: [13, -59, 3] }",
    "  - fill: { block: nether_bricks, from: [3, -60, -5], to: [3, -58, -5] }",
  ];
  const yaml =
    HEADER("jev-nether-fortress", "An open nether fortress hall: two wither skeletons and a blaze, with low walls for cover; an invisible barrier keeps the blaze in.", ["mobGriefing: false"]) +
    `
# The arena's own geometry: the compact footprint in nether bricks, walls three high, an invisible barrier cage above.
geometry:
${geometry.join("\n")}

${PLAYER}
entities:
  - { type: wither_skeleton, pos: [10.5, -60, 4.5], nbt: "{PersistenceRequired:1b}" }
  - { type: wither_skeleton, pos: [10.5, -60, -4.5], nbt: "{PersistenceRequired:1b}" }
  - { type: blaze, pos: [15.5, -58, 0.5], nbt: "{PersistenceRequired:1b}" }

${CLIENT}
goal:
  kind: all
  # Wall time. A frozen fight spends jev's latency per window on top of game time, so allow ten minutes.
  timeout: 600
  goals:
    - { kind: entityCount, entity: wither_skeleton, max: 0 }
    - { kind: entityCount, entity: blaze, max: 0 }
    - { kind: completion, who: JevFighter }
`;
  writeFileSync(path.join(import.meta.dirname, "nether-fortress.yaml"), yaml);
  console.log("nether-fortress: two wither skeletons, a blaze, barrier-caged");
}

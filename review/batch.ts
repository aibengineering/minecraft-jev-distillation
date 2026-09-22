// Batch review of the N most recent logs matching a name: outcome, damage, hits by attacker, creeper fate, frame drift, holds.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const dir = path.resolve(import.meta.dirname, "../logs");
const match = process.argv[2] ?? "terrain";
const count = Number(process.argv[3] ?? 3);
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f.includes(match)).sort().slice(-count);
for (const file of files) {
  const lines = readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const turns = lines.filter((r) => r.kind === "turn"), frames = lines.filter((r) => r.kind === "frame"), hits = lines.filter((r) => r.kind === "hit"), end = lines.find((r) => r.kind === "end");
  const first = frames[0]?.bot.health ?? 20, last = end?.health ?? frames.at(-1)?.bot.health ?? first;
  const by = hits.reduce((m: any, h) => { const k = h.by.replace(/ \(.*$/, ""); m[k] = (m[k] ?? 0) + h.amount; return m; }, {});
  const creeperLast = frames.filter((f) => f.enemies.some((e: any) => e.name === "creeper")).at(-1);
  const c = creeperLast?.enemies.find((e: any) => e.name === "creeper");
  const creeperFate = !creeperLast ? "none" : `gone at tick ${creeperLast.tick}, ${Math.hypot(c.position.x - creeperLast.bot.position.x, c.position.z - creeperLast.bot.position.z).toFixed(1)} blocks, hp ${c.health}`;
  const drift = turns.filter((t) => t.applied.drift), held = turns.filter((t) => t.applied.drift?.includes("held instead"));
  const fall = frames.find((f) => f.bot.position.y < (frames[0]?.bot.position.y ?? -60) - 0.5);
  const blocks = lines.filter((r) => r.kind === "status" && r.status === 29).length;
  console.log(`${file.slice(11, 19)} ${end?.status ?? "?"} ${turns.length} decisions ${lines.filter((r) => r.kind === "swing").length} swings ${blocks} blocks | damage ${(first - last).toFixed(1)} ${JSON.stringify(by)} | creeper ${creeperFate} | drift windows ${drift.length}, holds ${held.length} | ${fall ? "fell at " + fall.tick : "no fall"}`);
  for (const h of hits) {
    const d = turns.filter((t) => t.appliedTick <= h.tick).at(-1);
    const f = frames.filter((x) => x.tick <= h.tick).at(-1);
    const nearest = Math.min(...(f?.enemies.map((e: any) => Math.hypot(e.position.x - f.bot.position.x, e.position.z - f.bot.position.z)) ?? [NaN]));
    console.log(`    hit ${h.tick} ${h.amount} ${h.by.replace(/ \(.*$/, "")}: d${d?.turn} ${d?.applied.hands}${d?.applied.note ?? ""} ${d?.applied.move} facing ${d?.applied.facedName} (+${h.tick - (d?.appliedTick ?? 0)}), nearest ${nearest.toFixed(1)}b, ${h.shield}`);
  }
}

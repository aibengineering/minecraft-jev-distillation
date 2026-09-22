// Outcomes by scenario and policy over every log: wins, damage taken, decisions, swings, blocks, and how long a fight ran.
//   bun review/compare.ts [--last N] [--since 2026-09-21]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../logs");
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const last = Number(option("--last") ?? 0);
const since = option("--since") ?? "";

interface Outcome {
  file: string;
  scenario: string;
  policy: string;
  won: boolean;
  damage: number;
  hits: number;
  decisions: number;
  swings: number;
  blocks: number;
  ticks: number;
  latency: number;
  tokens: number;
}

const outcomes: Outcome[] = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f >= since).sort()) {
  const lines = readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const meta = lines.find((r) => r.kind === "meta");
  const turns = lines.filter((r) => r.kind === "turn");
  if (turns.length === 0) continue;
  const end = lines.find((r) => r.kind === "end");
  const hits = lines.filter((r) => r.kind === "hit");
  const frames = lines.filter((r) => r.kind === "frame");
  const first = frames[0]?.bot.health ?? turns[0]?.snapshot.bot.health ?? 20;
  const lastHealth = end?.health ?? frames.at(-1)?.bot.health ?? first;
  outcomes.push({
    file,
    scenario: (meta?.scenario ?? file.replace(/^[0-9T-]+Z-/u, "").replace(/(-lgbm)?\.jsonl$/u, "")).replace(/^jev-/u, "").replace(/^gen-\d+-\d+$/u, "gen"),
    policy: `${meta?.policy ?? (/-lgbm/u.test(file) ? "lgbm" : "jev")}${meta?.regime === "frozen" ? "-frozen" : ""}${meta?.regime && meta.regime !== "latency" ? `@${meta.hold}` : ""}${/-explore\.jsonl$/u.test(file) ? "-explore" : ""}`,
    won: end?.status === "succeeded",
    damage: first - lastHealth,
    hits: hits.length,
    decisions: turns.length,
    swings: lines.filter((r) => r.kind === "swing").length,
    blocks: lines.filter((r) => r.kind === "status" && r.status === 29).length,
    ticks: frames.at(-1)?.tick ?? turns.at(-1)?.appliedTick ?? 0,
    latency: turns.reduce((s, t) => s + (t.latencyMs ?? 0), 0) / turns.length,
    tokens: (() => {
      const billed = turns.filter((t) => t.usage?.input_tokens);
      return billed.length ? billed.reduce((s, t) => s + t.usage.input_tokens, 0) / billed.length : NaN;
    })(),
  });
}

const groups = new Map<string, Outcome[]>();
for (const o of outcomes) {
  const key = `${o.scenario} | ${o.policy}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(o);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 : NaN;
};
const rows = [...groups.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, all]) => {
    const group = last > 0 ? all.slice(-last) : all;
    return {
      "scenario | policy": key,
      runs: group.length,
      "win %": Math.round((100 * group.filter((o) => o.won).length) / group.length),
      "dmg mean": mean(group.map((o) => o.damage)).toFixed(1),
      "dmg median": median(group.map((o) => o.damage)).toFixed(1),
      "no-dmg %": Math.round((100 * group.filter((o) => o.damage < 0.05).length) / group.length),
      "hits mean": mean(group.map((o) => o.hits)).toFixed(1),
      "decisions med": median(group.map((o) => o.decisions)).toFixed(0),
      "ticks med": median(group.map((o) => o.ticks)).toFixed(0),
      "swings mean": mean(group.map((o) => o.swings)).toFixed(1),
      "blocks mean": mean(group.map((o) => o.blocks)).toFixed(1),
      "latency ms": mean(group.map((o) => o.latency)).toFixed(0),
      "tokens/window": mean(group.map((o) => o.tokens).filter((t) => !Number.isNaN(t))).toFixed(0),
    };
  });
console.table(rows);

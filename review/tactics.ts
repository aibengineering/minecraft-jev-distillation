// Tactical habits per run group: sidestep reversals, how long a move is held, wall use under a crossfire,
// arrows taken, and what jev did when an archer was in reach with the sword ready.
//   bun review/tactics.ts [--match gauntlet] [--last N] [--since 2026-09-21T05]
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../logs");
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const match = option("--match") ?? "";
const since = option("--since") ?? "";
const last = Number(option("--last") ?? 0);

interface RunStats {
  file: string;
  group: string;
  promptHash: string;
  won: boolean;
  windows: number;
  damage: number;
  hits: number;
  reversals: number;
  sidePairs: number;
  runLengths: number[];
  crossfireWindows: number;
  crossfireAtWall: number;
  archerInReachReady: number;
  archerStruck: number;
}

const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f.includes(match) && f >= since).sort();
const stats: RunStats[] = [];
for (const file of files) {
  const lines = readFileSync(path.join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const meta = lines.find((r) => r.kind === "meta");
  const turns = lines.filter((r) => r.kind === "turn");
  if (turns.length < 5) continue;
  const end = lines.find((r) => r.kind === "end");
  const hits = lines.filter((r) => r.kind === "hit");
  const first = turns[0].snapshot.bot.health;
  const lastHealth = end?.health ?? turns.at(-1).snapshot.bot.health;
  const scenario = (meta?.scenario ?? "").replace(/^jev-/u, "").replace(/^gen-\d+-\d+$/u, "gen");
  const policy = `${meta?.policy ?? "jev"}${meta?.regime === "frozen" ? "-frozen" : ""}${meta?.regime && meta.regime !== "latency" ? `@${meta.hold}` : ""}${/-explore\.jsonl$/u.test(file) ? "-explore" : ""}`;
  const s: RunStats = {
    file,
    group: `${scenario} | ${policy}`,
    promptHash: "",
    won: end?.status === "succeeded",
    windows: turns.length,
    damage: first - lastHealth,
    hits: hits.length,
    reversals: 0,
    sidePairs: 0,
    runLengths: [],
    crossfireWindows: 0,
    crossfireAtWall: 0,
    archerInReachReady: 0,
    archerStruck: 0,
  };
  let prev: string | null = null;
  let run = 0;
  for (const t of turns) {
    const snap = t.snapshot;
    const move: string = t.applied.move;
    const side = (m: string | null) => m === "left" || m === "right";
    if (side(prev) && side(move)) {
      s.sidePairs += 1;
      if (prev !== move) s.reversals += 1;
    }
    if (move === prev) run += 1;
    else {
      if (run) s.runLengths.push(run);
      run = 1;
    }
    prev = move;
    // Crossfire: two or more archers spread over more than 170 degrees of bearing.
    const archers = snap.enemies.filter((e: any) => e.held === "bow" && typeof e.degrees === "number");
    if (archers.length >= 2) {
      const angles = archers.map((e: any) => ((e.degrees % 360) + 360) % 360).sort((a: number, b: number) => a - b);
      let gap = 360 - angles[angles.length - 1] + angles[0];
      for (let i = 1; i < angles.length; i += 1) gap = Math.max(gap, angles[i] - angles[i - 1]);
      if (360 - gap >= 170) {
        s.crossfireWindows += 1;
        const atWall = Object.values(snap.ground as Record<string, string>).some((g) => /^wall at [12]$/u.test(g));
        if (atWall) s.crossfireAtWall += 1;
      }
    }
    const faced = snap.enemies.find((e: any) => e.id === snap.bot.facedId);
    if (faced && faced.held === "bow" && faced.distance <= 3 && snap.bot.swordReadyIn === 0) {
      s.archerInReachReady += 1;
      if (t.applied.hands === "strike") s.archerStruck += 1;
    }
  }
  if (run) s.runLengths.push(run);
  // The prompt hash lives in the sample file, when there is one.
  try {
    const sample = readFileSync(path.resolve(dir, "../data/samples", file), "utf8").split("\n").find((l) => l.trim());
    if (sample) s.promptHash = JSON.parse(sample).promptHash?.slice(0, 8) ?? "";
  } catch {
    // no sample file
  }
  stats.push(s);
}

const groups = new Map<string, RunStats[]>();
for (const s of stats) {
  if (!groups.has(s.group)) groups.set(s.group, []);
  groups.get(s.group)!.push(s);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1]! : NaN;
};
const pct = (num: number, den: number) => (den ? `${Math.round((100 * num) / den)}%` : "-");
const rows = [...groups.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([group, all]) => {
    const g = last > 0 ? all.slice(-last) : all;
    return {
      "scenario | policy": group,
      prompts: [...new Set(g.map((s) => s.promptHash))].join(","),
      runs: g.length,
      "win %": Math.round((100 * g.filter((s) => s.won).length) / g.length),
      "hits/run": mean(g.map((s) => s.hits)).toFixed(1),
      "dmg/run": mean(g.map((s) => s.damage)).toFixed(1),
      "windows med": median(g.map((s) => s.windows)),
      "side reversals": pct(g.reduce((a, s) => a + s.reversals, 0), g.reduce((a, s) => a + s.sidePairs, 0)),
      "move held med": median(g.flatMap((s) => s.runLengths)),
      "crossfire win.": g.reduce((a, s) => a + s.crossfireWindows, 0),
      "at wall": pct(g.reduce((a, s) => a + s.crossfireAtWall, 0), g.reduce((a, s) => a + s.crossfireWindows, 0)),
      "archer in reach, struck": pct(g.reduce((a, s) => a + s.archerStruck, 0), g.reduce((a, s) => a + s.archerInReachReady, 0)),
    };
  });
console.table(rows);
if (args.includes("--runs")) for (const s of stats) console.log(`${s.file.slice(11, 19)} ${s.group} ${s.promptHash} won=${s.won} hits=${s.hits} dmg=${s.damage.toFixed(1)} windows=${s.windows} reversals=${pct(s.reversals, s.sidePairs)} crossfire=${s.crossfireWindows} atWall=${pct(s.crossfireAtWall, s.crossfireWindows)}`);

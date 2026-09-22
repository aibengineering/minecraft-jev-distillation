/**
 * Builds data/samples/<run>.jsonl from every log under logs/, so the fights
 * already paid for become training rows without asking jev again.
 *
 *   bun ml/backfill.ts            # runs that have no sample file yet
 *   bun ml/backfill.ts --force    # rebuild all of them
 *
 * The rows are the same ones the loop writes live: featureRow over the logged
 * snapshot, with the previous window's applied answer for the lag features
 * and the pit depth read back from the state text where the snapshot lacks it.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { featureRow, previousOf, type Snapshot } from "../src/sense/features.ts";
import { labelsOf, promptHash, sampleFile, SampleLog, type Sample } from "../src/record/samples.ts";

const LOG_DIR = path.resolve(import.meta.dirname, "../logs");
const force = process.argv.includes("--force");

const files = readdirSync(LOG_DIR).filter((name) => name.endsWith(".jsonl")).sort();
let built = 0;
let rows = 0;
let skipped = 0;
for (const name of files) {
  const run = name.slice(0, -".jsonl".length);
  if (!force && existsSync(sampleFile(run))) {
    skipped += 1;
    continue;
  }
  const records = readFileSync(path.join(LOG_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, any>);
  const meta = records.find((record) => record.kind === "meta");
  const templateHash: string | undefined = records.find((record) => record.kind === "prompt")?.templateHash;
  const turns = records.filter((record) => record.kind === "turn");
  const hits = records.filter((record) => record.kind === "hit") as { tick: number; amount: number }[];
  const frames = records.filter((record) => record.kind === "frame") as { tick: number; enemies: { id: number; health: number | null }[] }[];
  const frameAt = (tick: number) => {
    let best = frames[0];
    for (const frame of frames) {
      if (frame.tick <= tick) best = frame;
      else break;
    }
    return best;
  };
  // Enemy health removed between a tick and forty ticks later; an enemy gone by then counts for what it had left.
  const dealtWithin = (tick: number, span: number) => {
    const before = frameAt(tick), after = frameAt(tick + span);
    if (!before || !after) return { dealt: 0, kills: 0 };
    let dealt = 0, kills = 0;
    for (const enemy of before.enemies) {
      const later = after.enemies.find((e) => e.id === enemy.id);
      const hp = enemy.health ?? 0;
      if (!later || (later.health ?? 0) <= 0) {
        dealt += hp;
        kills += 1;
      } else dealt += Math.max(0, hp - (later.health ?? 0));
    }
    return { dealt: Math.round(dealt * 100) / 100, kills };
  };
  const outcomeOf = (tick: number) => {
    const within = (span: number) => hits.filter((hit) => hit.tick > tick && hit.tick <= tick + span);
    const h20 = within(20), h40 = within(40);
    const { dealt, kills } = dealtWithin(tick, 40);
    return {
      hitWithin20: h20.length > 0,
      damageWithin20: Math.round(h20.reduce((sum, hit) => sum + hit.amount, 0) * 100) / 100,
      hitWithin40: h40.length > 0,
      damageWithin40: Math.round(h40.reduce((sum, hit) => sum + hit.amount, 0) * 100) / 100,
      damageDealtWithin40: dealt,
      killsWithin40: kills,
    };
  };
  if (turns.length === 0) {
    skipped += 1;
    continue;
  }
  const policy: string = meta?.policy ?? (/-lgbm(\.|$)/u.test(run) ? "lgbm" : "jev");
  const scenario: string = meta?.scenario ?? run.replace(/^[0-9T-]+Z-/u, "").replace(/-lgbm$/u, "");
  if (force) rmSync(sampleFile(run), { force: true });
  const out = new SampleLog(run);
  let previousApplied: Record<string, any> | undefined;
  for (const turn of turns) {
    const snapshot = turn.snapshot as Snapshot;
    const enemyLabels = snapshot.enemies.map((enemy) => enemy.label);
    const sample: Sample = {
      run,
      scenario,
      policy,
      promptHash: promptHash(turn.questions ?? {}, templateHash),
      turn: turn.turn,
      tick: turn.tick,
      lead: turn.lead,
      regime: turn.regime ?? "latency",
      hold: turn.hold ?? turn.lead,
      latencyMs: turn.latencyMs,
      features: featureRow(snapshot, { previous: previousOf(previousApplied as any) }),
      labels: labelsOf(turn.answers ?? {}, enemyLabels),
      answers: turn.answers ?? {},
      text: { state: turn.state ?? "", now: turn.now ?? "", faceCriteria: turn.questions?.face?.criteria ?? {} },
      outcome: outcomeOf(turn.tick),
    };
    out.record(sample);
    previousApplied = turn.applied;
    rows += 1;
  }
  built += 1;
}
console.log(`backfill: ${built} runs written (${rows} rows), ${skipped} skipped${force ? "" : " (already built or empty)"}; samples in ${path.resolve(import.meta.dirname, "../data/samples")}`);

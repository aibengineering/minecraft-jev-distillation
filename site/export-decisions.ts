/** Export recorded probabilities for the selected clip, without the full fight logs. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENEMY_KINDS } from "../src/sense/features.ts";

const [samples, offset] = process.argv.slice(2);
const tickZero = Number(offset);
if (!samples || offset === undefined || !Number.isFinite(tickZero) || tickZero < 0) {
  throw new Error("Usage: bun site/export-decisions.ts <samples.jsonl> <video-seconds-at-tick-zero>");
}
const content = path.join(import.meta.dirname, "content");
type Recorded = {
  run: string; turn: number; tick: number; features: Record<string, number | null>;
  answers: Record<string, { type: "choice"; choice: string; probabilities: Record<string, number> } | { type: "noul"; noul: number }>;
};
const moment = JSON.parse(readFileSync(path.join(content, "moment.json"), "utf8")) as Recorded;
const rows = readFileSync(samples, "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line) as Recorded);
if (rows.some(row => row.run !== moment.run)) throw new Error("Samples must belong to the selected capture");
const selected = [...rows.filter(row => row.tick < moment.tick), moment];
if (selected.some((row, i) => i > 0 && row.tick <= selected[i - 1]!.tick)) throw new Error("Decision ticks must increase");
const frames = selected.map(row => ({
  turn: row.turn, tick: row.tick, health: row.features.b_health,
  captured: row === moment,
  heads: ["face", "move", "hands", "pace", "jump"].map(name => {
    const answer = row.answers[name]!;
    const probabilities = answer.type === "noul" ? { no: 1 - answer.noul, yes: answer.noul } : answer.probabilities;
    const choice = answer.type === "noul" ? answer.noul >= .5 ? "yes" : "no" : answer.choice;
    return { name, choice, options: Object.entries(probabilities).map(([key, probability]) => {
      const kind = name === "face" && key !== "keep" ? row.features[`e${key.charCodeAt(0) - 65}_kind`] : null;
      return { key, label: kind == null ? key : `${key} ${ENEMY_KINDS[kind] ?? "enemy"}`, probability };
    }) };
  }),
}));
const configPath = path.join(content, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!config.video || tickZero + moment.tick / 20 > config.pauseAt) throw new Error("Timeline must reach the captured tick before the video pause");
writeFileSync(path.join(content, "decisions.json"), JSON.stringify({ tickZero, frames }));
writeFileSync(configPath, JSON.stringify({ ...config, decisions: "decisions.json" }, null, 2) + "\n");
console.log(`Exported ${frames.length} decisions from ${moment.run}; tick zero at ${tickZero}s.`);

/**
 * Checks the TypeScript LightGBM predictor against Python's probabilities on
 * the rows train.py wrote to ml/models/check.jsonl.
 *
 *   bun ml/verify.ts [model.json] [check.jsonl]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Predictor, type ModelFile } from "../src/decide/lgbm-json.ts";

const modelFile = process.argv[2] ?? path.resolve(import.meta.dirname, "models/jev-lgbm.json");
const checkFile = process.argv[3] ?? path.resolve(import.meta.dirname, "models/check.jsonl");
const predictor = new Predictor(JSON.parse(readFileSync(modelFile, "utf8")) as ModelFile);
const rows = readFileSync(checkFile, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as { features: Record<string, number | null>; expected: Record<string, Record<string, number>> });

let worst = 0;
let disagreements = 0;
let compared = 0;
for (const row of rows) {
  const features = Object.fromEntries(Object.entries(row.features).map(([k, v]) => [k, v === null ? NaN : v]));
  for (const [head, expected] of Object.entries(row.expected)) {
    const got = predictor.predict(head, features);
    const argmax = (p: Record<string, number>) => Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0];
    if (argmax(got) !== argmax(expected)) disagreements += 1;
    for (const [cls, p] of Object.entries(expected)) worst = Math.max(worst, Math.abs((got[cls] ?? 0) - p));
    compared += 1;
  }
}
console.log(`${compared} head predictions over ${rows.length} rows: max |Δp| ${worst.toExponential(2)}, argmax disagreements ${disagreements}`);
if (worst > 1e-6 || disagreements > 0) {
  console.error("the TypeScript predictor does not match LightGBM");
  process.exit(1);
}

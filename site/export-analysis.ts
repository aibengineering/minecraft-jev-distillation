/** Reproduce the report from the published model and its recorded training runs.
 * bun site/export-analysis.ts
 * No retraining, external calls, or raw combat observations in the output.
 */
import { createHash } from "node:crypto";
import { Predictor, type ModelFile, type DumpedModel } from "../src/decide/lgbm-json.ts";
import { FEATURE_LABELS, PDP_FEATURES, type ModelAnalysis, type Score } from "./analysis-data.ts";

const modelBytes = await Bun.file(new URL("./content/model.json", import.meta.url)).text();
const file: ModelFile = JSON.parse(modelBytes);
const model = new Predictor(file);
const meta = file.meta as { rows: number; runs: string[]; policy: string; regime: string; promptHashes: string[]; cv: Record<string, Score> };
const rows: Record<string, number>[] = [];
const counts: Record<string, Record<string, number>> = Object.fromEntries(model.heads.map(head => [head, {}]));
for (const run of meta.runs) {
  const text = await Bun.file(new URL(`../data/samples/${run}.jsonl`, import.meta.url)).text();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const sample = JSON.parse(line);
    if (sample.run !== run || sample.policy !== meta.policy || sample.regime !== meta.regime || "relabel" in sample || !meta.promptHashes.includes(sample.promptHash)) continue;
    rows.push(Object.fromEntries(Object.entries(sample.features).map(([key, value]) => [key, value === null ? NaN : Number(value)])));
    for (const head of model.heads) {
      const choice = String(sample.labels[head]).toLowerCase();
      counts[head]![choice] = (counts[head]![choice] ?? 0) + 1;
    }
  }
}
if (rows.length !== meta.rows) throw new Error(`Expected ${meta.rows} training rows, found ${rows.length}`);
for (const head of model.heads) {
  for (const [choice, count] of Object.entries(meta.cv[head]!.classes)) {
    if ((counts[head]![choice] ?? 0) !== count) throw new Error(`Training label counts differ for ${head}/${choice}`);
  }
}

function splitImportance(dump: DumpedModel) {
  const counts = new Map<string, number>();
  function visit(node: DumpedModel["tree_info"][number]["tree_structure"]) {
    if ("leaf_value" in node) return;
    const key = dump.feature_names[node.split_feature]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    visit(node.left_child); visit(node.right_child);
  }
  dump.tree_info.forEach(tree => visit(tree.tree_structure));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { totalSplits: total, importance: [...counts].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count, share: count / total })) };
}

// Reproducible uniform reservoir sample of decision rows, not of fights.
function sampleRows(input: Record<string, number>[], size = 1024) {
  const result = input.slice(0, size);
  let seed = 7;
  for (let i = size; i < input.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(seed / 2 ** 32 * (i + 1));
    if (j < size) result[j] = input[i]!;
  }
  return result;
}

const analysis: ModelAnalysis = { modelSha256: createHash("sha256").update(modelBytes).digest("hex"), trainedAt: file.trainedAt, rows: rows.length, runs: meta.runs.length, heads: {} };
for (const head of model.heads) {
  const pdps = (PDP_FEATURES[head] ?? []).map(spec => {
    const eligible = rows.filter(row => Number.isFinite(row[spec.key]));
    const background = sampleRows(eligible);
    const values = eligible.map(row => row[spec.key]!).sort((a, b) => a - b);
    if (!values.length) throw new Error(`No observed values for ${spec.key}`);
    const unique = [...new Set(values)];
    const low = values[Math.floor((values.length - 1) * .05)]!;
    const high = values[Math.floor((values.length - 1) * .95)]!;
    const grid = unique.length <= 21 ? unique : [...new Set(Array.from({ length: 21 }, (_, i) => {
      const value = low + (high - low) * i / 20;
      return spec.integer ? Math.round(value) : Number(value.toFixed(4));
    }))];
    const probabilities = Object.fromEntries(file.heads[head]!.classes.map(choice => [choice, [] as number[]]));
    for (const value of grid) {
      const sums = Object.fromEntries(file.heads[head]!.classes.map(choice => [choice, 0]));
      for (const row of background) {
        for (const [choice, probability] of Object.entries(model.predict(head, { ...row, [spec.key]: value }))) sums[choice]! += probability;
      }
      for (const choice of Object.keys(sums)) probabilities[choice]!.push(sums[choice]! / background.length);
    }
    console.log(`${head} / ${spec.key}: ${background.length} of ${eligible.length} observed rows, ${grid.length} points`);
    return { key: spec.key, label: FEATURE_LABELS[spec.key] ?? spec.key, unit: spec.unit, categories: spec.categories, eligibleRows: eligible.length, sampledRows: background.length, grid, probabilities };
  });
  analysis.heads[head] = { score: meta.cv[head]!, ...splitImportance(file.heads[head]!.model), pdps };
}
await Bun.write(new URL("./content/analysis.json", import.meta.url), JSON.stringify(analysis));
console.log(`Exported analysis for ${analysis.rows} decisions / ${analysis.runs} runs.`);

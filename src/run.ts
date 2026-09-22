/**
 * Runs a fixture under a chosen policy: a thin front for `mine-labs run`
 * that sets the environment src/fight.ts reads.
 *
 *   bun src/run.ts terrain                                # live jev, one fight
 *   bun src/run.ts terrain --frozen --step 2 --repeat 3   # jev with the world paused while it thinks
 *   bun src/run.ts mixed --policy lgbm --repeat 3         # the model, two ticks a window
 *   bun src/run.ts gauntlet --policy lgbm --watch         # the same with the Mine Labs client open
 *   bun src/run.ts duel --policy fixed --fixed "hands=cover,move=hold"
 *
 * Scenario is a fixture alias (terrain, mixed, duel, gauntlet, basalt,
 * fortress), a file under scenarios/, or a path. --model names another model
 * file, --sample draws answers from the model's distribution, --lead-ms holds
 * every answer to at least that latency so a fast policy runs at jev's pace.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const ALIASES: Record<string, string> = { terrain: "terrain-fight", mixed: "mixed-fight", duel: "zombie-duel", gauntlet: "skeleton-gauntlet", basalt: "basalt-delta", fortress: "nether-fortress" };
const VALUED = ["--policy", "--model", "--step", "--repeat", "--jobs", "--lead-ms", "--fixed"];

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name: string) => args.includes(name);
const positional = args.filter((arg, i) => !arg.startsWith("--") && !VALUED.includes(args[i - 1] ?? ""));
const scenarioArg = positional[0] ?? "terrain";

const root = path.resolve(import.meta.dirname, "..");
const stem = ALIASES[scenarioArg] ?? scenarioArg.replace(/\.yaml$/u, "");
const fixture = existsSync(scenarioArg) ? path.resolve(scenarioArg) : path.join(root, "scenarios", `${stem}.yaml`);
if (!existsSync(fixture)) {
  console.error(`no fixture at ${fixture}; use ${Object.keys(ALIASES).join(", ")} or a path`);
  process.exit(2);
}

const policy = (option("--policy") ?? "jev").toLowerCase();
const repeat = Number(option("--repeat") ?? 1);
const frozen = flag("--frozen");
const demo = flag("--demo");
if (demo && (policy !== "lgbm" || frozen || flag("--sample") || option("--lead-ms") || repeat !== 1 || (option("--jobs") ?? "1") !== "1")) {
  throw new Error("--demo needs --policy lgbm, one run and one worker, without --frozen, --sample or --lead-ms");
}
const step = option("--step");
const leadMs = option("--lead-ms");
const outName = `${path.basename(fixture, ".yaml")}${policy === "jev" ? "" : `-${policy}`}${flag("--sample") ? "-sampled" : ""}${frozen ? "-frozen" : ""}`;

const command = ["bun", "x", "--bun", "mine-labs", "run", fixture, "--jobs", option("--jobs") ?? "1", "--out", path.join(root, ".mine-labs", outName)];
if (repeat > 1) command.push("--repeat", String(repeat));
if (flag("--watch")) command.push("--client");

// Everything the fight reads is documented on selectPolicy (src/decide/policy.ts) and TIMING (src/regime.ts).
const env: Record<string, string> = { ...(process.env as Record<string, string>), JEV_POLICY: policy };
const model = option("--model");
if (model) env.JEV_MODEL = path.resolve(model);
if (flag("--sample")) env.JEV_SAMPLE = "1";
const fixed = option("--fixed");
if (fixed) env.JEV_FIXED = fixed;
if (leadMs) env.JEV_LEAD_MS = leadMs;
if (frozen) env.JEV_FROZEN = "1";
if (step) env.JEV_STEP_TICKS = step;
if (demo) env.JEV_DEMO = "1";

console.log(`${policy}${flag("--sample") ? " (sampled)" : ""}${frozen ? ` frozen, ${step ?? 2} ticks a window` : ""}${leadMs ? ` at >= ${leadMs} ms` : ""} x${repeat} on ${path.relative(root, fixture)}`);
const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);

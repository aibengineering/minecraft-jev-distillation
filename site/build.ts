/**
 * Builds the static site into dist/: the page, the bundled app (with the
 * model reader from src/decide/lgbm-json.ts), and only the selected moment,
 * model and recording. GitHub Actions publishes dist/ to Pages;
 * locally, `bun site/build.ts` then open dist/index.html over any static
 * server (`bunx serve dist`).
 */
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const config = JSON.parse(readFileSync(path.join(root, "site/content/config.json"), "utf8"));
const analysis = JSON.parse(readFileSync(path.join(root, "site/content/analysis.json"), "utf8"));
const modelHash = createHash("sha256").update(readFileSync(path.join(root, "site/content/model.json"))).digest("hex");
if (analysis.modelSha256 !== modelHash) throw new Error("Analysis does not match the published model. Run bun site/export-analysis.ts");
if (process.argv.includes("--release") && (!config.video || !Number.isFinite(config.pauseAt) || config.pauseAt < 0)) {
  throw new Error("Publishing needs the final recording and a calibrated pauseAt. Local preview: bun run site:build");
}
if (config.video && (config.video !== path.basename(config.video) || !existsSync(path.join(root, "site/content", config.video)))) throw new Error("Configured video is missing or not a local content filename");
if (config.poster && (config.poster !== path.basename(config.poster) || !existsSync(path.join(root, "site/content", config.poster)))) throw new Error("Configured poster is missing or not a local content filename");
if (config.decisions && (config.decisions !== path.basename(config.decisions) || !existsSync(path.join(root, "site/content", config.decisions)))) throw new Error("Configured decisions are missing or not a local content filename");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "site", "app.ts")],
  outdir: dist,
  target: "browser",
  minify: true,
  sourcemap: "none",
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
cpSync(path.join(root, "site", "index.html"), path.join(dist, "index.html"));
cpSync(path.join(root, "site", "style.css"), path.join(dist, "style.css"));
mkdirSync(path.join(dist, "content"));
for (const file of ["config.json", "moment.json", "model.json", "analysis.json", ...(config.video ? [config.video] : []), ...(config.poster ? [config.poster] : []), ...(config.decisions ? [config.decisions] : [])]) {
  cpSync(path.join(root, "site", "content", file), path.join(dist, "content", file));
}
console.log(`built ${path.relative(root, dist)}: ${result.outputs.map((o) => `${path.basename(o.path)} ${(o.size / 1e3).toFixed(0)} kB`).join(", ")}`);

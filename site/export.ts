/** Export exactly one captured moment and its exact model. No full fights or recording files are copied implicitly. */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { Predictor, type ModelFile } from "../src/decide/lgbm-json.ts";

const root = path.resolve(import.meta.dirname, "..");
const content = path.join(root, "site/content");
const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const capture = option("--capture");
if (!capture) throw new Error('Usage: bun site/export.ts --capture data/demo/<run>.json [--video <recording.mp4> --pause-at <seconds>]');
const file = path.resolve(capture);
const moment = JSON.parse(readFileSync(file, "utf8"));
if (moment.version !== 1 || !moment.features || !moment.state || !moment.questions || !moment.snapshot?.enemies) throw new Error("Not a demo capture");
const modelFile = file.replace(/\.json$/u, ".model.json");
const model = JSON.parse(readFileSync(modelFile, "utf8")) as ModelFile;
const predictor = new Predictor(model);
if (model.featureNames.some(key => !(key in moment.features))) throw new Error("Captured features do not match the captured model");
for (const head of ["face", "move", "hands", "pace", "jump"]) predictor.predict(head, moment.features);
const videoArg = option("--video");
const pauseArg = option("--pause-at");
const pauseAt = pauseArg === undefined ? null : Number(pauseArg);
if (pauseAt !== null && (!Number.isFinite(pauseAt) || pauseAt < 0)) throw new Error("--pause-at must be a non-negative number of seconds");
if (videoArg && (!existsSync(videoArg) || path.extname(videoArg).toLowerCase() !== ".mp4")) throw new Error("--video must point to an MP4 recording (OBS can remux MKV to MP4)");
if (!videoArg && pauseAt !== null) throw new Error("Supply --video with --pause-at so the frame and recording are exported together");
// Preserve all thresholds and leaf values; browser predictions must match the recording exactly.
writeFileSync(path.join(content, "model.json"), JSON.stringify(model));
writeFileSync(path.join(content, "moment.json"), JSON.stringify(moment));
if (videoArg && path.resolve(videoArg) !== path.join(content, "demo.mp4")) copyFileSync(videoArg, path.join(content, "demo.mp4"));
writeFileSync(path.join(content, "config.json"), JSON.stringify({ video: videoArg ? "demo.mp4" : null, pauseAt }, null, 2) + "\n");
console.log(`Exported one moment: ${moment.run}, turn ${moment.turn}; ${Object.keys(moment.features).length} features.`);
console.log(videoArg ? pauseAt === null ? "Video copied. Open the local page with ?calibrate, find the frozen hold, then export again with --pause-at." : `Video will pause at ${pauseAt}s.` : "State preview ready. Export again with the matching OBS recording when available.");

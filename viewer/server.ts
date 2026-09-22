/**
 * Decision viewer for the fights: lists the JSONL logs src/fight.ts
 * writes under ../logs and serves the pages in ./public: the replay at /
 * and the live decision panel at /live.html, which follows the newest log
 * as it is written (for recording a fight with the decisions alongside);
 * /live.html?policy=jev or ?policy=lgbm follows one policy's fights only,
 * so two panels can show jev and the model side by side.
 *
 *   bun run viewer
 *
 * --hot reloads this file on change; the page files are read per request, so
 * a browser refresh picks up edits to them too.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const LOGS = path.resolve(import.meta.dirname, "../logs");
const SAMPLES = path.resolve(import.meta.dirname, "../data/samples");
const PUBLIC = path.resolve(import.meta.dirname, "public");
const PORT = Number(process.env.PORT ?? 4321);

async function listRuns() {
  let names: string[] = [];
  try {
    names = (await readdir(LOGS)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    names.map(async (name) => {
      const file = path.join(LOGS, name);
      const info = await stat(file);
      const records = await readRun(name);
      const turns = records.filter((record) => record.kind === "turn");
      const hits = records.filter((record) => record.kind === "hit");
      const end = records.find((record) => record.kind === "end");
      const meta = records.find((record) => record.kind === "meta");
      const first = turns[0]?.snapshot?.bot?.health ?? 20;
      const last = end?.health ?? turns.at(-1)?.snapshot?.bot?.health ?? first;
      return {
        name,
        modified: info.mtimeMs,
        turns: turns.length,
        hits: hits.length,
        damage: Math.round((first - last) * 10) / 10,
        status: end?.status ?? (turns.length ? "incomplete" : "empty"),
        policy: meta?.policy ?? (/-lgbm.jsonl$/u.test(name) ? "lgbm" : "jev"),
        detail: end?.detail ?? "",
      };
    }),
  );
  return runs.sort((a, b) => b.modified - a.modified);
}

async function readRun(name: string): Promise<Record<string, any>[]> {
  const file = path.join(LOGS, path.basename(name));
  const text = await readFile(file, "utf8");
  const records: Record<string, any>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A line still being written; the next refresh will have it.
    }
  }
  return records;
}

const json = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });

/**
 * The live feed for /live.html: tails whichever log is newest, so a page left open follows each new fight,
 * and streams every non-frame record (meta, prompt, turn, hit, shield, death, end) as it is written.
 */
async function newestLog(policy: string | null): Promise<string | undefined> {
  let names: string[] = [];
  try {
    names = (await readdir(LOGS)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  // A run's name carries its policy suffix (-lgbm, -fixed, or none for jev), so a panel can follow one policy.
  if (policy === "jev") names = names.filter((name) => !/-(lgbm|fixed)/u.test(name));
  else if (policy) names = names.filter((name) => name.includes(`-${policy}`));
  // Names start with an ISO timestamp, so the last in sort order is the newest fight.
  return names.sort().at(-1);
}

function liveStream(request: Request): Response {
  const policy = new URL(request.url).searchParams.get("policy");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let current: string | undefined;
      let offset = 0;
      let partial = "";
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const timer = setInterval(async () => {
        try {
          const newest = await newestLog(policy);
          if (!newest) return;
          if (newest !== current) {
            current = newest;
            offset = 0;
            partial = "";
            send({ kind: "run", name: current });
          }
          const file = Bun.file(path.join(LOGS, current));
          const size = file.size;
          if (size <= offset) return;
          partial += await file.slice(offset, size).text();
          offset = size;
          const lines = partial.split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const record = JSON.parse(line);
            if (record.kind !== "frame") send(record);
          }
        } catch (cause) {
          send({ kind: "error", detail: String(cause) });
        }
      }, 100);
      request.signal.addEventListener("abort", () => {
        clearInterval(timer);
        controller.close();
      });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/runs") return json(await listRuns());
    if (url.pathname === "/api/live") return liveStream(request);
    // The run's training rows: the feature row the model reads, and the labels, one per decision.
    if (url.pathname.startsWith("/api/samples/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/samples/".length));
      const file = path.join(SAMPLES, path.basename(name).replace(/\.jsonl$/u, "") + ".jsonl");
      try {
        const text = await readFile(file, "utf8");
        const rows = text.split("\n").filter((line) => line.trim()).map((line) => {
          const row = JSON.parse(line);
          return { turn: row.turn, regime: row.regime, hold: row.hold, promptHash: row.promptHash, features: row.features, labels: row.labels };
        });
        return json(rows);
      } catch {
        return json([]);
      }
    }
    if (url.pathname.startsWith("/api/runs/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      try {
        return json(await readRun(name));
      } catch {
        return new Response("no such run", { status: 404 });
      }
    }
    const asset = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(path.join(PUBLIC, path.normalize(asset)));
    if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-store" } });
    return new Response("not found", { status: 404 });
  },
});

console.log(`jev viewer at http://localhost:${PORT}/ reading ${LOGS}`);

/** The run log: one JSONL per fight, every window and event, replayed by the viewer and rebuilt into samples. */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";


/** Every window's input and output, plus hits and the result, one JSON record per line, for the viewer. */
export const LOG_DIR = path.resolve(import.meta.dirname, "../../logs");

export class RunLog {
  readonly file: string;
  /** The run's name: the log's basename, shared with its sample file under data/samples. */
  readonly run: string;
  #pending: string[] = [];
  constructor(scenario: string, suffix: string) {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    this.run = `${stamp}-${scenario}${suffix}`;
    this.file = path.join(LOG_DIR, `${this.run}.jsonl`);
  }
  /** Decisions, hits and events go straight to disk; frames are buffered and flushed in batches. */
  record(entry: Record<string, unknown>, buffered = false): void {
    this.#pending.push(JSON.stringify({ at: Date.now(), ...entry }));
    if (!buffered || this.#pending.length >= 40) this.flush();
  }
  flush(): void {
    if (this.#pending.length === 0) return;
    appendFileSync(this.file, `${this.#pending.join("\n")}\n`);
    this.#pending = [];
  }
}

/**
 * The training set: one row per decision window, persisted by every run so
 * the input-to-output pairs jev is paid for are kept once and reused.
 *
 * A row carries the flat feature vector (src/sense/features.ts), jev's answers with
 * their probabilities, the labels the models are trained on, and the text jev
 * actually read, so a text model can be trained from the same file later.
 * Rows live in data/samples/<run>.jsonl, one file per run, named after the
 * run's log so the two can be joined.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Answer, Question } from "../decide/jev.ts";
import { CLASSES, type FeatureRow } from "../sense/features.ts";

export const SAMPLE_DIR = path.resolve(import.meta.dirname, "../../data/samples");

export interface SampleLabels {
  /** Enemy slot index as a string ("0" is A), or "keep". */
  face: string;
  move: string;
  hands: string;
  pace: string;
  jump: boolean;
  /** jev's raw yes-probability for the jump question. */
  jumpScore: number;
}

/**
 * What followed the window, for outcome analysis: hits on the bot within
 * twenty and forty ticks of the snapshot and the damage they did. Known only
 * after the fact, so the backfill writes it from the log's hit records; a
 * row written live has none until the run is rebuilt.
 */
export interface Outcome {
  hitWithin20: boolean;
  damageWithin20: number;
  hitWithin40: boolean;
  damageWithin40: number;
  /** Enemy health removed within forty ticks, from the frames, kills counted at their remaining health. */
  damageDealtWithin40?: number;
  killsWithin40?: number;
}

export interface Sample {
  run: string;
  scenario: string;
  /** Who answered: "jev", or a distilled model's name. */
  policy: string;
  /** Hash of the static prompt text, so training can tell prompt versions apart. */
  promptHash: string;
  turn: number;
  tick: number;
  lead: number;
  /** See TIMING in src/regime.ts: latency (world ran while the policy thought), instant, or frozen. */
  regime: "latency" | "instant" | "frozen";
  /** Ticks the answer held before the next question. */
  hold: number;
  latencyMs: number;
  features: FeatureRow;
  labels: SampleLabels;
  answers: Record<string, Answer>;
  text: { state: string; now: string; faceCriteria: Record<string, string | null> };
  outcome?: Outcome;
}

/** Labels from the answers as the loop reads them, so training targets match what was applied. */
export function labelsOf(answers: Record<string, Answer>, enemyLabels: readonly string[]): SampleLabels {
  const choice = (name: string, fallback: string) => (answers[name]?.type === "choice" ? answers[name].choice : fallback);
  const faceChoice = choice("face", "keep");
  const slot = enemyLabels.indexOf(faceChoice);
  const jumpScore = answers.jump?.type === "noul" ? answers.jump.noul : 0;
  return {
    face: slot === -1 ? "keep" : String(slot),
    move: choice("move", "hold"),
    hands: choice("hands", "free"),
    pace: choice("pace", "walk"),
    jump: jumpScore >= 0.5,
    jumpScore,
  };
}

/**
 * A hash of everything in the questions that does not change from window to
 * window: the situation text and the fixed criteria. The face criteria and
 * the "right now" sentence are per window and left out.
 */
export function promptHash(questions: Record<string, Question>, templateHash?: string): string {
  // The situation text quotes this window's lead and latency; those are not prompt changes.
  const timeless = (text: string | undefined) => (text ?? "").replace(/about \d+ ticks \(\d+ ms\)/u, "about N ticks (N ms)");
  const fixed = {
    situation: timeless(questions.pace?.instructions),
    move: questions.move?.criteria ?? null,
    hands: questions.hands?.criteria ?? null,
    pace: questions.pace?.criteria ?? null,
    jump: questions.jump?.criteria ?? null,
    face: timeless(questions.face?.instructions),
    /** The prompt-building code's own hash, when the loop supplies it; older logs have none. */
    template: templateHash ?? null,
  };
  return Bun.hash(JSON.stringify(fixed)).toString(16).padStart(16, "0");
}

export function sampleFile(run: string): string {
  return path.join(SAMPLE_DIR, `${run}.jsonl`);
}

export class SampleLog {
  readonly file: string;
  constructor(run: string) {
    mkdirSync(SAMPLE_DIR, { recursive: true });
    this.file = sampleFile(run);
  }
  record(sample: Sample): void {
    // NaN serialises as null, which is what the trainer reads as missing.
    appendFileSync(this.file, `${JSON.stringify(sample)}\n`);
  }
}

/** Sanity check that a label is one the model can be trained on. */
export function isKnownLabel(head: keyof typeof CLASSES, value: string): boolean {
  return (CLASSES[head] as readonly string[]).includes(value);
}

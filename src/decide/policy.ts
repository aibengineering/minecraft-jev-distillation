/**
 * Who answers the questions each window: jev over the API, or the LightGBM
 * model over the feature row. Both return answers in jev's shape so the loop
 * applies them the same way and the logs stay comparable.
 *
 * Selected with JEV_POLICY (default "jev"). JEV_MODEL points the model policy
 * at a model file (default ml/models/jev-lgbm.json); JEV_SAMPLE=1
 * draws each answer from the model's distribution instead of the argmax.
 * JEV_LEAD_MS holds every answer back to at least that latency, so a fast
 * model can be run at jev's own pace for a like-for-like comparison.
 * JEV_POLICY=fixed with JEV_FIXED="hands=cover,move=hold" exercises a
 * mechanic without jev or a model.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { CLASSES, type FeatureRow } from "../sense/features.ts";
import { ask, type Answer, type Question } from "./jev.ts";
import { Predictor, type ModelFile } from "./lgbm-json.ts";

export interface DecisionInput {
  state: string;
  questions: Record<string, Question>;
  features: FeatureRow;
  /** The enemy letters in slot order, so a slot prediction maps back to a face label. */
  enemyLabels: readonly string[];
}

export interface Decision {
  answers: Record<string, Answer>;
  /** Tokens billed for the call, when the policy is jev. */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface Policy {
  readonly name: string;
  readonly model?: ModelFile;
  /** Answers within a tick, so the loop runs the instant regime (lead 0, answers hold for a fixed step); see TIMING in regime.ts. */
  readonly instant: boolean;
  decide(input: DecisionInput): Promise<Decision>;
}

const DEFAULT_MODEL = path.resolve(import.meta.dirname, "../../ml/models/jev-lgbm.json");

class JevPolicy implements Policy {
  readonly name = "jev";
  readonly instant = false;
  async decide(input: DecisionInput): Promise<Decision> {
    const response = await ask(input.state, input.questions);
    return { answers: response.answers, usage: response.usage };
  }
}

class LightGbmPolicy implements Policy {
  readonly name: string;
  /** About 0.2 ms for all five heads, measured over stored rows: far inside a tick. */
  readonly instant = true;
  readonly #predictor: Predictor;
  readonly #sample: boolean;

  get model(): ModelFile { return this.#predictor.file; }

  /**
   * With `sample`, each choice is drawn from the predicted distribution
   * rather than taken as its argmax. jev is not deterministic: in a clinch it
   * guards and backs off most windows and strikes in a few, and the odd
   * strike is what breaks the clinch. An argmax policy loses those exits.
   */
  constructor(file: string, sample: boolean) {
    this.#predictor = new Predictor(JSON.parse(readFileSync(file, "utf8")) as ModelFile);
    this.#sample = sample;
    // A model other than the default is named after its file, so its runs are told apart in the logs.
    const stem = path.basename(file, ".json").replace(/^jev-lgbm-?/u, "");
    this.name = `lgbm${stem ? `-${stem}` : ""}${sample ? "-sampled" : ""}`;
    for (const head of Object.keys(CLASSES)) {
      if (!this.#predictor.heads.includes(head)) throw new Error(`${file} has no model for the ${head} question`);
    }
  }

  #pick(probabilities: Record<string, number>): [string, number] {
    const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    if (!this.#sample) return ranked[0]!;
    let r = Math.random();
    for (const [name, p] of ranked) {
      r -= p;
      if (r <= 0) return [name, p];
    }
    return ranked[0]!;
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const answers: Record<string, Answer> = {};
    for (const head of ["move", "hands", "pace"] as const) {
      const probabilities = this.#predictor.predict(head, input.features);
      const [choice, confidence] = this.#pick(probabilities);
      answers[head] = { type: "choice", choice, probabilities, confidence };
    }

    // Face: the model predicts a slot or "keep"; a slot with no enemy in it this window cannot be chosen, so its
    // mass goes to the next best.
    const slots = this.#predictor.predict("face", input.features);
    const probabilities: Record<string, number> = {};
    for (const [cls, p] of Object.entries(slots)) {
      if (cls === "keep") probabilities.keep = p;
      else {
        const label = input.enemyLabels[Number(cls)];
        if (label !== undefined) probabilities[label] = p;
      }
    }
    const total = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1;
    for (const key of Object.keys(probabilities)) probabilities[key]! /= total;
    const [choice, confidence] = Object.keys(probabilities).length ? this.#pick(probabilities) : ["keep", 1];
    answers.face = { type: "choice", choice, probabilities, confidence };

    // The loop reads jump as "yes at 0.5 or more"; when sampling, a draw decides and is reported as 0 or 1.
    const yes = this.#predictor.predict("jump", input.features).true ?? 0;
    answers.jump = { type: "noul", noul: this.#sample ? (Math.random() < yes ? 1 : 0) : yes };
    return { answers };
  }
}

/** Fixed answers from JEV_FIXED ("hands=cover,move=hold"); anything unspecified takes a default. */
class FixedPolicy implements Policy {
  readonly name = "fixed";
  readonly instant = true;
  readonly #choices: Record<string, string>;
  constructor(spec: string) {
    this.#choices = Object.fromEntries(spec.split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]));
  }
  async decide(input: DecisionInput): Promise<Decision> {
    const pick = (head: string, fallback: string): Answer => {
      const choice = this.#choices[head] ?? fallback;
      return { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
    };
    return {
      answers: {
        face: pick("face", input.enemyLabels[0] ?? "keep"),
        move: pick("move", "hold"),
        hands: pick("hands", "guard"),
        pace: pick("pace", "walk"),
        jump: { type: "noul", noul: this.#choices.jump === "true" ? 1 : 0 },
      },
    };
  }
}

/** Wraps a policy so no answer lands sooner than `minimumMs` after it was asked; the loop then forecasts for it like jev's. */
function withMinimumLatency(policy: Policy, minimumMs: number): Policy {
  return {
    name: `${policy.name}-${minimumMs}ms`,
    instant: false,
    async decide(input) {
      const startedAt = Date.now();
      const decision = await policy.decide(input);
      const remaining = minimumMs - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return decision;
    },
  };
}

export function selectPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const name = (env.JEV_POLICY ?? "jev").toLowerCase();
  let policy: Policy;
  if (name === "jev") policy = new JevPolicy();
  else if (name === "lgbm") policy = new LightGbmPolicy(env.JEV_MODEL ?? DEFAULT_MODEL, env.JEV_SAMPLE === "1");
  else if (name === "fixed") policy = new FixedPolicy(env.JEV_FIXED ?? "");
  else throw new Error(`unknown JEV_POLICY ${name}; use jev, lgbm or fixed`);
  const minimumMs = Number(env.JEV_LEAD_MS ?? 0);
  return minimumMs > 0 ? withMinimumLatency(policy, minimumMs) : policy;
}

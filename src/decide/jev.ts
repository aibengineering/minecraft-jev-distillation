/**
 * The smallest possible TypeSafe client: one POST to /v1/systemone.
 *
 * Reads JEV_API_KEY from the repository's .env (Bun only auto-loads a .env in
 * the working directory, and Mine Labs runs this client from the fixture's
 * folder). Retries on 429 and 529 with a short backoff, as the docs ask.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities?: Record<string, number>; confidence: number };

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

function apiKey(): string {
  const fromEnv = process.env.JEV_API_KEY;
  if (fromEnv) return fromEnv;
  const envFile = path.resolve(import.meta.dirname, "../../.env");
  const line = readFileSync(envFile, "utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("JEV_API_KEY="));
  if (!line) throw new Error(`JEV_API_KEY is not set and not found in ${envFile}`);
  return line.slice("JEV_API_KEY=".length).trim().replace(/^["']|["']$/gu, "");
}

export async function ask(state: unknown, questions: Record<string, Question>): Promise<JevResponse> {
  const key = apiKey();
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: MODEL, questions }),
    });
    if (response.ok) return (await response.json()) as JevResponse;
    const body = await response.text();
    // Rate limits and transient upstream failures (a 503 "no healthy upstream" has been seen mid-fight) are retried with backoff.
    // Keep trying for about two minutes: a frozen fight loses nothing by waiting, and overloads of that length have been seen.
    if ((response.status === 429 || (response.status >= 500 && response.status <= 504) || response.status === 529) && attempt < 28) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * 2 ** attempt)));
      continue;
    }
    throw new Error(`jev ${response.status}: ${body.slice(0, 300)}`);
  }
}

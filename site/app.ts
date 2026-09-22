import { highlightedJson } from "./json-view.ts";
import { INPUT_EXAMPLES } from "./input-examples.ts";
import { mountAnalysis } from "./analysis.ts";
import type { ModelAnalysis } from "./analysis-data.ts";
import { Predictor, type ModelFile } from "../src/decide/lgbm-json.ts";
import { describeFeature, featureCodes, FEATURE_GROUPS } from "./feature-docs.ts";
import type { Question, JevResponse } from "../src/decide/jev.ts";

type Moment = {
  preview: boolean; state: string; now: string; questions: Record<string, Question>;
  features: Record<string, number | null>;
  jevAnswer?: JevResponse | null;
  jevResponseMeta?: { requestedAt: string; latencyMs: number; requestedModel: string };
  tick: number; swordHits?: { tick: number }[];
  snapshot: { enemies: { name: string; label: string; distance: number; releaseIn: number | null }[] };
};
type Config = { video: string | null; pauseAt: number | null; poster?: string; decisions?: string };
type DecisionFrame = {
  turn: number; tick: number; health: number; captured: boolean;
  heads: { name: string; choice: string; options: { key: string; label: string; probability: number }[] }[];
};
type Timeline = { tickZero: number; frames: DecisionFrame[] };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const fmt = (value: number) => Number.isNaN(value) ? "missing" : Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
const video = $<HTMLVideoElement>("video");
const body = $("panel-body");
let moment: Moment;
let config: Config;
let model: Predictor;
let row: Record<string, number>;
let original: Record<string, number>;
let side: "jev" | "lgbm" = "jev";
let requestView: "preview" | "json" = "preview";
let stopped = false;
let videoReady = false;
let timeline: Timeline | undefined;
let displayedDecision: DecisionFrame | undefined;
let inspectorScroll: ReturnType<typeof setTimeout> | undefined;

function syncDecisions() {
  if (!timeline) return;
  const tick = Math.floor((video.currentTime - timeline.tickZero) * 20);
  const frame = stopped && !videoReady ? timeline.frames.at(-1) : timeline.frames.findLast(frame => frame.tick <= tick);
  if (frame === displayedDecision) return;
  displayedDecision = frame;
  $("decision-clock").textContent = frame ? `Tick ${frame.tick} · ${frame.health}/20 health` : "Before combat";
  $("decision-bars").innerHTML = frame ? frame.heads.map(head => `<div class="decision-head"><h4>${esc(head.name)}</h4>${head.options.map(option => `<div class="decision-option ${option.key === head.choice ? "chosen" : ""}"><span>${esc(option.label)}</span><small>${(option.probability * 100).toFixed(1)}%</small><div class="decision-track"><i style="width:${option.probability * 100}%"></i></div></div>`).join("")}</div>`).join("") : "";
}

function theme(value: string) {
  document.documentElement.dataset.theme = value;
  const label = value === "dark" ? "Switch to light mode" : "Switch to dark mode";
  $("theme").setAttribute("aria-label", label);
  $("theme").title = label;
  try { localStorage.setItem("combat-theme", value); } catch { /* Storage is optional. */ }
}
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem("combat-theme"); } catch { /* Storage is optional. */ }
theme(savedTheme === "dark" ? "dark" : "light");
$("theme").onclick = () => theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

async function json<T>(file: string): Promise<T> {
  const response = await fetch(`content/${file}`);
  if (!response.ok) throw new Error(`Could not load ${file}`);
  return response.json() as Promise<T>;
}

function reveal(scrollDelay = 500) {
  if (stopped) return;
  stopped = true;
  video.pause();
  if (videoReady && config.pauseAt !== null) video.currentTime = config.pauseAt;
  $("demo").classList.add("revealed");
  body.hidden = false;
  $("panel").hidden = false;
  for (const name of ["jev", "lgbm"]) $<HTMLButtonElement>("pick-" + name).disabled = false;
  $("status").textContent = videoReady ? `Paused at ${config.pauseAt?.toFixed(1)} s` : "Saved state · recording unavailable";
  $("play").textContent = "↻ Replay";
  $("screen").dataset.playback = "captured";
  $("freeze-label").hidden = false;
  $("freeze-label").textContent = `Ⅱ Paused · tick ${moment.tick}`;
  $("decision-story").hidden = false;
  $("model-analysis").hidden = false;
  $("inspect-now").hidden = true;
  $("inspect-now").setAttribute("aria-expanded", "true");
  render();
  syncDecisions();
  if (videoReady) {
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    inspectorScroll = setTimeout(() => {
      $("decision-story").scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
    }, reducedMotion ? 0 : scrollDelay);
  }
}

function watchTime() {
  syncDecisions();
  if (!stopped && videoReady && config.pauseAt !== null && video.currentTime >= config.pauseAt) reveal();
  if (!video.paused) requestAnimationFrame(watchTime);
}

function render() {
  $("panel").dataset.side = side;
  for (const name of ["jev", "lgbm"] as const) $("pick-" + name).setAttribute("aria-pressed", String(name === side));
  body.innerHTML = side === "jev" ? jevView() : modelView();
}

function requestPreview(): string {
  const split = moment.state.indexOf("\n\nSnapshot");
  const observation = split < 0 ? moment.state : moment.state.slice(split + 2);
  const instructions = split < 0 ? "" : moment.state.slice(0, split);
  return `<div class="request-preview">
    <h3>Questions <small>${Object.keys(moment.questions).length}</small></h3>
    <div class="preview-questions">${Object.entries(moment.questions).map(([name, question]) => `<details class="preview-question"><summary><span>${esc(name)}</span><code>${esc(question.type)}</code></summary><p>${esc(question.instructions)}</p>${question.criteria ? `<dl>${Object.entries(question.criteria).map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value ?? "")}</dd>`).join("")}</dl>` : ""}</details>`).join("")}</div>
    <h3>State <small>tick ${moment.tick}</small></h3>
    ${instructions ? `<p class="state-caption"><em>Shared combat instructions</em></p><div class="state-text">${esc(instructions)}</div>` : ""}
    <p class="state-caption"><em>Observations at tick ${moment.tick}</em></p>
    <div class="state-text">${esc(observation)}</div>
  </div>`;
}

function jevView(): string {
  const request = { model: moment.jevResponseMeta?.requestedModel ?? "jev-latest", questions: moment.questions, state: moment.state };
  return `<div class="io-grid">
    <section class="input-column"><div class="io-heading"><span class="eyebrow">Input</span><h2>Jev request</h2><p>State and questions from tick ${moment.tick}.</p></div>
      <div class="io-content"><div class="request-file">
        <div class="request-toolbar"><div role="tablist" aria-label="Request format">${(["preview", "json"] as const).map(view => `<button type="button" role="tab" id="request-tab-${view}" data-request-view="${view}" aria-selected="${requestView === view}" aria-controls="request-${view}" tabindex="${requestView === view ? 0 : -1}">${view === "json" ? "JSON" : "Preview"}</button>`).join("")}</div><span>request.json</span></div>
        <div id="request-preview" role="tabpanel" aria-labelledby="request-tab-preview" tabindex="0" ${requestView === "preview" ? "" : "hidden"}>${requestPreview()}</div>
        <div id="request-json" role="tabpanel" aria-labelledby="request-tab-json" ${requestView === "json" ? "" : "hidden"}><pre class="json-code request-json" tabindex="0" aria-label="Jev request JSON"><code>${highlightedJson(request)}</code></pre></div>
      </div></div>
    </section>
    <section class="output-column">${moment.jevAnswer ? jevOutput(moment.jevAnswer) : `<div class="io-heading"><span class="eyebrow">Output</span><h2>What Jev would answer</h2><p>Four choices and a probability of jumping.</p></div>
      <div class="io-content response-note"><strong>No Jev response recorded</strong><p>LightGBM controlled this run. This captured request has not been sent to Jev.</p></div>`}
    </section></div>`;
}

function probabilityRow(head: string, probabilities: Record<string, number>, label: (key: string) => string, winner: string): string {
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return `<details class="prediction compact" open><summary><span>${esc(head)}</span></summary><div class="probabilities">${ranked.map(([key, p]) => `<div class="${key === winner ? "selected-option" : ""}"><span>${esc(label(key))}${key === winner ? ' <span class="selected-mark" aria-label="selected">✓</span>' : ""}</span><meter aria-label="${esc(head)}: ${esc(label(key))}" min="0" max="1" value="${p}">${p}</meter><small>${(p * 100).toFixed(1)}%</small></div>`).join("")}</div></details>`;
}

function jevOutput(response: JevResponse): string {
  const answers = Object.entries(response.answers).map(([head, answer]) => {
    const label = (key: string) => {
      const enemy = head === "face" ? moment.snapshot.enemies.find(enemy => enemy.label === key) : undefined;
      return enemy ? `${key} · ${enemy.name}` : key;
    };
    if (answer.type === "choice") return probabilityRow(head, answer.probabilities, label, answer.choice);
    if (answer.type === "noul") return probabilityRow(head, { no: 1 - answer.noul, yes: answer.noul }, label, answer.noul >= .5 ? "yes" : "no");
    return "";
  }).join("");
  return `<div class="io-heading"><span class="eyebrow">Output</span><h2>Jev’s response <span class="model-badge">${esc(response.model)}</span></h2><p>Probability of each answer.</p></div>
    <div class="io-content"><div class="predictions">${answers}</div>
    <p class="fine">Queried after recording, using this saved state.</p>
    <details class="raw-response"><summary>Full response JSON</summary><pre class="json-code" tabindex="0" aria-label="Jev response JSON"><code>${highlightedJson(response)}</code></pre></details></div>`;
}

function predictedHeads() {
  return ["face", "move", "hands", "pace", "jump"].map(head => {
    let probabilities = model.predict(head, row);
    if (head === "face") {
      // Match the live policy: exclude unoccupied enemy slots and renormalize.
      probabilities = Object.fromEntries(Object.entries(probabilities).filter(([key]) => key === "keep" || Number(key) < moment.snapshot.enemies.length));
      const sum = Object.values(probabilities).reduce((a, b) => a + b, 0) || 1;
      probabilities = Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, value / sum]));
    }
    return { head, probabilities };
  });
}

function predictions(): string {
  return predictedHeads().map(({ head, probabilities }) => {
    const label = (key: string) => head === "face" && key !== "keep" ? `${moment.snapshot.enemies[Number(key)]?.label} · ${moment.snapshot.enemies[Number(key)]?.name}` : head === "jump" ? key === "true" ? "yes" : "no" : key;
    const winner = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
    return probabilityRow(head, probabilities, label, winner);
  }).join("");
}

function control(key: string, title: string, min: number, max: number, step: number | "any" = "any"): string {
  const value = row[key]!;
  return `<label class="control" data-changed="${!Object.is(value, original[key])}" title="${esc(describeFeature(key))}"><span>${esc(title)}</span><output data-value="${key}">${fmt(value)}</output><input aria-label="${esc(title)}" type="range" data-key="${key}" min="${Math.min(min, Number.isNaN(value) ? min : value)}" max="${Math.max(max, Number.isNaN(value) ? max : value)}" step="${step}" value="${Number.isNaN(value) ? min : value}"><small>${key}</small></label>`;
}

function changedKeys(): string[] {
  return Object.keys(row).filter(key => !Object.is(row[key], original[key]));
}

function inputStatus(): string {
  const count = changedKeys().length;
  return count ? `${count} input${count === 1 ? "" : "s"} changed` : "Using recorded inputs";
}

function inputChanges(): string {
  const keys = changedKeys();
  return keys.length ? `<details class="input-changes"><summary>See ${keys.length} feature changes</summary><dl>${keys.map(key => `<div><dt title="${esc(describeFeature(key))}">${esc(key)}</dt><dd>${fmt(original[key]!)} → ${fmt(row[key]!)}</dd></div>`).join("")}</dl></details>` : "";
}

function exampleSelected(index: number): boolean {
  const edits = INPUT_EXAMPLES[index]!.edits;
  return Object.keys(row).every(key => Object.is(row[key], edits[key] ?? original[key]));
}

function modelView(): string {
  const controls: string[] = [];
  const creeper = moment.snapshot.enemies.findIndex(enemy => enemy.name === "creeper");
  const skeleton = moment.snapshot.enemies.findIndex(enemy => enemy.name === "skeleton");
  if (creeper >= 0) controls.push(
    '<h4 class="control-group-title">Creeper fuse</h4>',
    control(`e${creeper}_fuse`, "Creeper fuse · ticks", 0, 30, 1),
    control("n_maxFuse", "Highest creeper fuse · ticks", 0, 30, 1),
    control("n_bombImminent", "Imminent explosion · 0 = no, 1 = yes", 0, 1, 1),
  );
  if (skeleton >= 0) controls.push(
    '<h4 class="control-group-title">Skeleton bow</h4>',
    control(`e${skeleton}_releaseIn`, "Bow releases in · ticks", 0, 20, 1),
    control("n_minReleaseIn", "Earliest bow release · ticks", 0, 20, 1),
    control("n_archerFiresWithinWindow", "Fires this window · 0 = no, 1 = yes", 0, 1, 1),
    control("n_minShotTicks", "Next shot lands or releases · ticks", 0, 20, 1),
    control("n_minArrival", "Earliest bow arrow arrival · ticks", 0, 30, 1),
  );
  controls.push('<h4 class="control-group-title">Health and distance</h4>', control("b_health", "Health", 0, 20), control("b_swordReadyIn", "Sword ready in · ticks", 0, 13, 1));
  moment.snapshot.enemies.forEach((enemy, i) => {
    if (enemy.name === "creeper" || enemy.name === "skeleton") {
      controls.push(control(`e${i}_dist`, `${enemy.label} · ${enemy.name} distance`, 0, 20));
    }
  });
  return `<div class="io-grid">
    <section class="input-column"><div class="io-heading"><span class="eyebrow">Input</span><h2>${Object.keys(row).length} numerical features</h2><p>Predictions update as you edit the features.</p></div>
      <div class="io-content"><div class="playground-heading"><h3>Example edits</h3><button id="reset" class="text-button">Reset inputs</button></div>
      <div class="input-examples" role="group" aria-label="Try a different decision">${INPUT_EXAMPLES.map((example, index) => `<button type="button" data-example="${index}" aria-pressed="${exampleSelected(index)}"><span>${esc(example.title)} <span aria-hidden="true">↗</span></span><small>${esc(example.description)}</small></button>`).join("")}</div>
      <p class="fine example-note">Each example resets the inputs before applying its edits.</p>
      <div id="input-changes">${inputChanges()}</div>
      <div class="controls">${controls.join("")}</div>
      <h3 class="section-title">All features</h3><div class="feature-groups">${FEATURE_GROUPS.map(([title, re]) => {
        const keys = Object.keys(row).filter(key => re.test(key));
        return `<details class="feature-group"><summary><span>${esc(title)}</span><small>${keys.length}</small></summary><div class="feature-list">${keys.map(key => {
          const codes = featureCodes(key);
          const input = codes ? `<select aria-label="${key}" data-key="${key}"><option value="" ${Number.isNaN(row[key]) ? "selected" : ""}>missing</option>${codes.map((name, i) => `<option value="${i}" ${row[key] === i ? "selected" : ""}>${esc(name)}</option>`).join("")}</select>` : `<input aria-label="${key}" data-key="${key}" type="number" step="any" placeholder="missing" value="${Number.isNaN(row[key]) ? "" : row[key]}">`;
          return `<label title="${esc(describeFeature(key))}"><span>${key}<small>${esc(describeFeature(key))}</small></span>${input}</label>`;
        }).join("")}</div></details>`;
      }).join("")}</div></div>
    </section>
    <section class="output-column"><div class="io-heading"><span class="eyebrow">Output</span><h2>LightGBM predictions</h2><p>Probability of each answer.</p></div>
      <div class="io-content"><div id="predictions" class="predictions">${predictions()}</div>
      <p id="changed" class="output-status" aria-live="polite">${inputStatus()}</p></div>
    </section></div>`;

}

// Delegate once; switching tabs and resetting never stacks input listeners.
body.addEventListener("input", event => {
  const input = event.target as HTMLInputElement;
  const key = input.dataset.key;
  if (!key || !(key in row)) return;
  const value = input.value === "" ? NaN : Number(input.value);
  if (!Number.isFinite(value) && !Number.isNaN(value)) return;
  row[key] = value;
  body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]").forEach(other => {
    if (other !== input && other.dataset.key === key) other.value = Number.isNaN(value) ? "" : String(value);
  });
  body.querySelectorAll<HTMLOutputElement>("[data-value]").forEach(output => { output.value = fmt(row[output.dataset.value!]!); });
  body.querySelectorAll<HTMLElement>(".control").forEach(control => {
    const key = control.querySelector<HTMLInputElement>("[data-key]")!.dataset.key!;
    control.dataset.changed = String(!Object.is(row[key], original[key]));
  });
  $("predictions").innerHTML = predictions();
  $("changed").textContent = inputStatus();
  $("input-changes").innerHTML = inputChanges();
  body.querySelectorAll<HTMLButtonElement>("[data-example]").forEach(button => button.setAttribute("aria-pressed", String(exampleSelected(Number(button.dataset.example)))));
});
function setRequestView(view: "preview" | "json") {
  requestView = view;
  for (const name of ["preview", "json"] as const) {
    const tab = $("request-tab-" + name);
    tab.setAttribute("aria-selected", String(name === view));
    tab.tabIndex = name === view ? 0 : -1;
    $("request-" + name).hidden = name !== view;
  }
}
body.addEventListener("keydown", event => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-request-view]");
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const view = event.key === "Home" ? "preview" : event.key === "End" ? "json" : requestView === "json" ? "preview" : "json";
  setRequestView(view);
  $("request-tab-" + view).focus();
});
body.addEventListener("click", event => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-request-view]");
  if (tab) setRequestView(tab.dataset.requestView as "preview" | "json");
  const example = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-example]");
  if (example) {
    const index = Number(example.dataset.example);
    row = { ...original, ...INPUT_EXAMPLES[index]!.edits };
    render();
    body.querySelector<HTMLButtonElement>(`[data-example="${index}"]`)?.focus({ preventScroll: true });
  }
  if ((event.target as HTMLElement).closest("#reset")) { row = { ...original }; render(); }
});

async function main() {
  [config, moment] = await Promise.all([json<Config>("config.json"), json<Moment>("moment.json")]);
  model = new Predictor(await json<ModelFile>("model.json"));
  if (config.decisions) {
    timeline = await json<Timeline>(config.decisions);
    $("recorded-decisions").hidden = false;
    $("decision-clock").textContent = "Before combat";
  }
  original = Object.fromEntries(Object.entries(moment.features).map(([key, value]) => [key, value ?? NaN]));
  row = { ...original };
  mountAnalysis($("model-analysis"), await json<ModelAnalysis>("analysis.json"));
  $("status").textContent = "Saved inputs loaded";
  const archer = moment.snapshot.enemies.find(enemy => enemy.name === "skeleton");
  $("decision-title").textContent = `The decision at tick ${moment.tick}`;
  $("story-detail").textContent = `The bot has landed ${moment.swordHits?.length ?? "several"} sword hits. The skeleton is drawing its bow${archer?.releaseIn != null ? ` and will release in about ${archer.releaseIn} ticks` : ""}. Both models receive inputs from this state.`;
  for (const name of ["jev", "lgbm"] as const) $("pick-" + name).onclick = () => { side = name; render(); };
  $("inspect-now").onclick = () => reveal(0);
  const play = async () => {
    if (!video.paused) {
      video.pause();
      $("play").textContent = "▶ Continue";
      $("screen").dataset.playback = "paused";
      $("freeze-label").hidden = false;
      $("freeze-label").textContent = "Ⅱ Paused";
      return;
    }
    clearTimeout(inspectorScroll);
    $("freeze-label").hidden = true;
    if (stopped) {
      stopped = false;
      video.currentTime = 0;
      $("demo").classList.remove("revealed");
      body.hidden = true;
      $("decision-story").hidden = true;
      $("model-analysis").hidden = true;
      $("freeze-label").hidden = true;
      $("panel").hidden = true;
      $("inspect-now").hidden = false;
      $("inspect-now").setAttribute("aria-expanded", "false");
      for (const name of ["jev", "lgbm"]) $<HTMLButtonElement>("pick-" + name).disabled = true;
    }
    syncDecisions();
    try {
      await video.play();
      $("play").textContent = "Ⅱ Pause";
      $("screen").dataset.playback = "playing";
      $("status").textContent = `Playing · pauses at tick ${moment.tick}`;
    } catch { $("status").textContent = "Press play to start the recording."; }
  };
  $("play").onclick = play;
  if (config.video) {
    video.hidden = false;
    $("placeholder").hidden = true;
    if (config.poster) video.poster = `content/${config.poster}`;
    video.src = `content/${config.video}`;
    video.addEventListener("loadedmetadata", () => {
      const author = new URLSearchParams(location.search).has("calibrate");
      if (config.pauseAt === null || config.pauseAt < 0 || config.pauseAt >= video.duration) {
        if (!author) { $("status").textContent = "Recording needs its pause point set."; return; }
      } else {
        videoReady = true;
        $<HTMLButtonElement>("play").disabled = false;
        $<HTMLButtonElement>("inspect-now").disabled = false;
      }
      $("status").textContent = `Playback pauses at tick ${moment.tick}.`;

      if (author) {
        video.controls = true;
        $("calibration").hidden = false;
        $("set-pause").onclick = () => { video.pause(); $("pause-value").textContent = `--pause-at ${video.currentTime.toFixed(3)}`; };
      }
    });
    video.addEventListener("error", () => {
      videoReady = false;
      video.hidden = true;
      $("placeholder").hidden = false;
      reveal();
      $<HTMLButtonElement>("play").disabled = true;
    });
    video.addEventListener("play", () => { if (stopped) video.pause(); else watchTime(); });
    video.addEventListener("timeupdate", () => { if (videoReady && !stopped && config.pauseAt !== null && video.currentTime >= config.pauseAt) reveal(); syncDecisions(); });
    video.addEventListener("seeked", syncDecisions);
  } else reveal();
}
void main().catch(error => {
  $("status").textContent = `The demo couldn't load. ${error instanceof Error ? error.message : String(error)}`;
});

import { FEATURE_LABELS, type Dependence, type ModelAnalysis } from "./analysis-data.ts";
import { describeFeature } from "./feature-docs.ts";

const esc = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const number = (value: number) => Number(value.toFixed(2)).toLocaleString();

function plot(pdp: Dependence, choice: string, output: string, labels: number[], boundary?: number): string {
  const values = pdp.probabilities[choice]!;
  if (pdp.categories) {
    const height = 58 + values.length * 29;
    return `<svg class="pdp-chart category-chart" viewBox="0 0 480 ${height}" role="img" aria-label="${esc(pdp.label)}: average probability of ${esc(output)}">
      <text x="125" y="17" class="chart-caption">Average P(${esc(output)})</text>
      ${[0, .5, 1].map(p => `<line x1="${125 + p * 275}" x2="${125 + p * 275}" y1="28" y2="${height - 30}" class="chart-grid"/><text x="${125 + p * 275}" y="${height - 9}" text-anchor="middle">${p * 100}%</text>`).join("")}
      ${values.map((p, i) => `<text x="113" y="${44 + i * 29}" text-anchor="end">${esc(pdp.categories![pdp.grid[i]!]!)}</text><rect x="125" y="${33 + i * 29}" width="${p * 275}" height="15" class="${labels.includes(i) ? "pdp-bar-highlight" : "pdp-bar"}"/><text x="${Math.max(132, 133 + p * 275)}" y="${45 + i * 29}" class="point-label">${percent(p)}</text>`).join("")}
    </svg>`;
  }
  const min = pdp.grid[0]!, max = pdp.grid.at(-1)!;
  const x = (value: number) => 48 + (value - min) / (max - min || 1) * 390;
  const y = (value: number) => 186 - value * 150;
  const path = values.map((value, i) => `${i ? "L" : "M"}${x(pdp.grid[i]!).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
  const ticks = [...new Set([0, Math.floor((pdp.grid.length - 1) / 2), pdp.grid.length - 1])];
  return `<svg class="pdp-chart" viewBox="0 0 480 234" role="img" aria-label="${esc(pdp.label)}: average probability of ${esc(output)}">
    <text x="48" y="17" class="chart-caption">Average P(${esc(output)})</text>
    ${[0, .5, 1].map(p => `<line x1="48" x2="438" y1="${y(p)}" y2="${y(p)}" class="chart-grid"/><text x="38" y="${y(p) + 4}" text-anchor="end">${p * 100}%</text>`).join("")}
    ${boundary === undefined ? "" : `<line x1="${x(boundary)}" x2="${x(boundary)}" y1="36" y2="186" class="chart-boundary"/><text x="${x(boundary) + 6}" y="52" class="chart-caption">${boundary}° shield edge</text>`}
    <path d="${path}" class="pdp-line"/>
    ${values.map((p, i) => `<circle cx="${x(pdp.grid[i]!)}" cy="${y(p)}" r="${labels.includes(i) ? 4 : 2}" class="pdp-point"><title>${number(pdp.grid[i]!)}: ${percent(p)}</title></circle>`).join("")}
    ${labels.map(i => `<text x="${x(pdp.grid[i]!)}" y="${y(values[i]!) - 12}" text-anchor="${i === 0 ? "start" : i === values.length - 1 ? "end" : "middle"}" class="point-label">${percent(values[i]!)}</text>`).join("")}
    ${ticks.map(i => `<text x="${x(pdp.grid[i]!)}" y="206" text-anchor="middle">${number(pdp.grid[i]!)}</text>`).join("")}
    <text x="243" y="229" text-anchor="middle">${esc(pdp.unit)}</text>
  </svg>`;
}

function selectedStories(data: ModelAnalysis): string {
  const sword = data.heads.hands!.pdps.find(p => p.key === "b_swordReadyIn")!;
  const shield = data.heads.face!.pdps.find(p => p.key === "e0_shotDegIfFaced")!;
  const ground = data.heads.jump!.pdps.find(p => p.key === "g_ahead_kind")!;
  const at = (pdp: Dependence, choice: string, value: number) => percent(pdp.probabilities[choice]![pdp.grid.indexOf(value)]!);
  const stories = [
    {
      pdp: sword, choice: "strike", output: "strike", title: "A ready sword changes the decision",
      insight: `${at(sword, "strike", 0)} → ${at(sword, "strike", 1)}`,
      detail: "Ready now → one tick of cooldown left",
      explanation: `The average chance of striking drops sharply as soon as the sword still needs time to recharge. At three ticks, it is ${at(sword, "strike", 3)}.`,
      labels: [0, sword.grid.indexOf(1), sword.grid.indexOf(3)], boundary: undefined,
    },
    {
      pdp: shield, choice: "0", output: "face A", title: "Shield coverage matters when choosing a target",
      insight: `${percent(shield.probabilities["0"]![0]!)} → ${percent(shield.probabilities["0"]!.at(-1)!)}`,
      detail: `Shots straight ahead → ${Math.round(shield.grid.at(-1)!)}° off to the side`,
      explanation: "If facing enemy A would leave incoming fire outside the shield arc—more than 90° off-centre—the model becomes less likely to choose A. The curve drops near that boundary. A is the nearest enemy, not a fixed species.",
      labels: [0, shield.grid.length - 1], boundary: 90,
    },
    {
      pdp: ground, choice: "true", output: "jump", title: "A step ahead raises the chance of jumping",
      insight: `${at(ground, "true", 0)} → ${at(ground, "true", 2)}`,
      detail: "Open floor → a step up",
      explanation: "Jumping is uncommon overall, but changing the ground ahead to a step produces a clear increase. It still stays below 50%: the other parts of the state also matter.",
      labels: [ground.grid.indexOf(2)], boundary: undefined,
    },
  ];
  return stories.map((story, index) => `<article class="pdp-story"><div class="pdp-story-copy"><span class="eyebrow">${String(index + 1).padStart(2, "0")} · ${esc(story.output)}</span><h4>${esc(story.title)}</h4><p class="pdp-insight">${story.insight}</p><p class="pdp-contrast">${esc(story.detail)}</p><p>${esc(story.explanation)}</p></div><div class="pdp-story-figure">${plot(story.pdp, story.choice, story.output, story.labels, story.boundary)}<p class="fine">${story.pdp.sampledRows.toLocaleString()} sampled states · ${story.pdp.eligibleRows.toLocaleString()} with this feature observed</p><details class="pdp-values"><summary>Underlying values</summary><table><thead><tr><th>${esc(story.pdp.unit)}</th><th>P(${esc(story.output)})</th></tr></thead><tbody>${story.pdp.grid.map((value, i) => `<tr><td>${esc(story.pdp.categories?.[value] ?? number(value))}</td><td>${percent(story.pdp.probabilities[story.choice]![i]!)}</td></tr>`).join("")}</tbody></table></details></div></article>`).join("");
}

export function mountAnalysis(element: HTMLElement, data: ModelAnalysis) {
  let head = "hands";
  element.innerHTML = `<div class="analysis-heading"><span class="eyebrow">Across the training fights</span><h2>Model analysis</h2><p>${data.rows.toLocaleString()} Jev-labelled decisions from ${data.runs} fights. How closely does LightGBM reproduce them?</p></div>
    <h3>Agreement with Jev</h3>
    <p class="analysis-caption">Cross-validation with entire fights held out together. Accuracy here means choosing the same answer as Jev.</p>
    <div class="score-scroll"><table class="score-table"><thead><tr><th scope="col">Decision</th><th scope="col">Accuracy</th><th scope="col" aria-describedby="baseline-note">Majority baseline</th><th scope="col" aria-describedby="macro-f1-note">Macro-F1</th></tr></thead><tbody>${Object.entries(data.heads).map(([name, { score }]) => `<tr><th scope="row">${name}</th><td><span class="score-value">${percent(score.accuracy)}</span><span class="score-track" aria-hidden="true"><i style="width:${score.accuracy * 100}%"></i><b style="left:${score.majorityBaseline * 100}%"></b></span></td><td>${percent(score.majorityBaseline)}</td><td>${score.macroF1.toFixed(3)}</td></tr>`).join("")}</tbody></table></div>
    <p id="baseline-note" class="fine"><strong>Majority baseline:</strong> accuracy from always choosing the most common answer. For movement, always choosing “forward” scores ${percent(data.heads.move!.score.majorityBaseline)}. The marker on each bar shows this baseline.</p>
    <p id="macro-f1-note" class="fine"><strong>Macro-F1:</strong> the simple average of F1 scores across observed classes. Each class’s F1 is the harmonic mean of precision and recall. Rare actions such as “hold” count as much as common ones such as “forward”.</p>
    <div class="analysis-picker"><h3>Feature importance</h3><div class="analysis-tabs" role="tablist" aria-label="Decision">${Object.keys(data.heads).map(name => `<button type="button" role="tab" id="analysis-tab-${name}" data-head="${name}" aria-controls="feature-importance-panel" aria-selected="${name === head}" tabindex="${name === head ? 0 : -1}">${name[0]!.toUpperCase() + name.slice(1)}</button>`).join("")}</div></div>
    <div id="feature-importance-panel" role="tabpanel" aria-labelledby="analysis-tab-hands" tabindex="0"><p class="analysis-caption">Share of tree splits · top eight features. This measures how often a feature is used, rather than the size of its effect.</p><div id="importance-bars"></div></div>
    <section class="selected-pdps"><h3>Three patterns in the model</h3><p class="analysis-caption">Selected partial dependence plots: change one input across saved states and average the predictions. All charts use a 0–100% scale.</p>${selectedStories(data)}<p class="fine">These are selected examples, not a ranking of all effects. Related features stay fixed, so some combinations may not occur in play. <a href="https://scikit-learn.org/1.7/modules/partial_dependence.html">About PDPs</a></p></section>
    <details class="analysis-method"><summary>Data and method</summary><p>The recorded model was trained on ${data.rows.toLocaleString()} decisions from ${data.runs} Jev-controlled, frozen-window fights. The saved scores use grouped cross-validation by fight. Those validation folds also selected boosting rounds, so these are validation estimates, not an untouched final test or combat win rates.</p>
      <p>The baseline is the share of the most frequent label in the full dataset. Macro-F1 averages over classes present in the labels. Jumping is rare: only ${data.heads.jump!.score.classes.true} of ${data.rows.toLocaleString()} labels request a jump.</p>
      <p>Feature importance counts splits in the exact exported model. Gain values were not retained in that export. <a href="https://lightgbm.readthedocs.io/en/latest/pythonapi/lightgbm.Booster.html#lightgbm.Booster.feature_importance">LightGBM importance definitions</a>.</p>
      <p>The three PDPs were selected for interpretable contrasts after inspecting candidate features. Each averages raw probabilities over a reproducible sample of up to 1,024 training decisions where that feature was observed. Each decision has equal weight; longer fights contribute more rows. Continuous grids span the 5th–95th percentiles; features with at most 21 distinct values use all observed values. Other features, including related summaries, remain unchanged. These curves describe the trained model, not causal effects or held-out performance.</p>
      <p>Model trained ${esc(data.trainedAt.slice(0, 10))}. <a href="content/analysis.json" download>Download analysis data</a>.</p>
    </details>`;

  function renderImportance() {
    const top = data.heads[head]!.importance.slice(0, 8);
    element.querySelector<HTMLElement>("#importance-bars")!.innerHTML = top.map(feature => `<div class="importance-row" title="${esc(describeFeature(feature.key))}"><div><span>${esc(FEATURE_LABELS[feature.key] ?? feature.key)}</span><strong>${percent(feature.share)}</strong></div><div class="importance-track"><i style="width:${feature.share / top[0]!.share * 100}%"></i></div><small>${esc(feature.key)} · ${feature.count.toLocaleString()} splits</small></div>`).join("");
  }
  const tabs = [...element.querySelectorAll<HTMLButtonElement>(".analysis-tabs [role=tab]")];
  function selectTab(tab: HTMLButtonElement) {
    head = tab.dataset.head!;
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    element.querySelector("#feature-importance-panel")!.setAttribute("aria-labelledby", tab.id);
    renderImportance();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next]!);
      tabs[next]!.focus();
    });
  });
  renderImportance();
}

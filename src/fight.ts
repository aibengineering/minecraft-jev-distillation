/**
 * The fight: one decision window at a time, sense, decide, act, advance.
 *
 *   sense   src/sense/    the snapshot (numbers), the text jev reads, the feature row the model reads
 *   decide  src/decide/   jev over the API, or the LightGBM model; the questions they answer
 *   act     src/act/      turning the answers into controls, a swing, a shield, a block of cover
 *   record  src/record/   the run log the viewer replays, the samples the trainer learns from
 *   regime  src/regime.ts how a window relates to game time: live jev, an instant model, or jev with the world frozen
 *
 * Mine Labs builds the arena, summons the enemies and judges the outcome;
 * this file owns the Mineflayer connection and the loop, nothing else steers.
 */
import mineflayer, { type Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { runNodeClient, type NodeClientSession } from "mine-labs/client";

import { applyDecision, gearUp, inventoryArrived, type Applied } from "./act/actions.ts";
import { selectPolicy } from "./decide/policy.ts";
import { questions, situation } from "./decide/prompt.ts";
import { RunLog } from "./record/run-log.ts";
import { demoMoment, demoWait, saveDemo, withDemoFreeze } from "./record/demo.ts";
import { labelsOf, promptHash, SampleLog } from "./record/samples.ts";
import { advance, beginWindow, CLEAR_TICKS, DEFAULT_HOLD_TICKS, DEFAULT_LEAD_TICKS, frozenNow, MAX_FIGHT_TICKS, MAX_JEV_TURNS, tickCommand, type Regime, type Window } from "./regime.ts";
import { Clocks } from "./sense/clocks.ts";
import { describe, faceBlurb, nowLine, promptTemplateHash } from "./sense/describe.ts";
import { featureRow, previousOf } from "./sense/features.ts";
import { distance, eyes } from "./sense/geometry.ts";
import { snapshotData } from "./sense/snapshot.ts";
import { useArrowClock, trackArrowFlights } from "./sense/perception/arrow-flight.ts";
import { trackBowDraws } from "./sense/perception/bow-timing.ts";
import { gameClock } from "./sense/perception/game-clock.ts";
import { hostiles, trackFireballs } from "./sense/world.ts";

await runNodeClient(async (session) => {
  const bot = mineflayer.createBot({ host: session.host, port: session.port, username: session.username, version: session.version, auth: "offline" });
  session.signal.addEventListener("abort", () => bot.quit(), { once: true });
  await new Promise<void>((resolve, reject) => {
    bot.once("spawn", resolve);
    bot.once("error", reject);
  });
  // Perception that extrapolates between packets runs on game time, so it stops with a frozen world (see TIMING).
  useArrowClock(gameClock(bot));
  trackFireballs(bot);
  using arrows = trackArrowFlights(bot);
  using draws = trackBowDraws(bot);
  void arrows;
  void draws;
  session.ready();
  await session.arranged;
  await inventoryArrived(bot);
  await gearUp(bot);
  session.prepared();
  await session.start;
  let runLog: RunLog | undefined;
  try {
    const completion = await fight(bot, session, (log) => (runLog = log));
    runLog?.record({ kind: "end", ...completion, health: bot.health });
    session.finish(completion);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    runLog?.record({ kind: "end", status: "failed", detail, health: bot.health });
    session.finish({ status: "failed", detail });
  } finally {
    runLog?.flush();
    bot.quit();
  }
});

type Completion = { status: "succeeded" | "failed"; detail: string };

async function fight(bot: Bot, session: NodeClientSession, onLog: (log: RunLog) => void): Promise<Completion> {
  // Who answers, and how the window relates to game time: frozen when asked for, instant for a policy that answers
  // within a tick, latency otherwise. Fails here, before the fight, if a model file is missing.
  const policy = selectPolicy();
  const frozen = process.env.JEV_FROZEN === "1";
  const hold = Math.max(1, Math.round(Number(process.env.JEV_STEP_TICKS ?? DEFAULT_HOLD_TICKS)));
  const regime: Regime = frozen ? "frozen" : policy.instant ? "instant" : "latency";
  const demo = process.env.JEV_DEMO === "1";
  if (demo && (regime !== "instant" || !policy.model || policy.name.includes("sampled"))) throw new Error("Demo capture requires a realtime, unsampled LightGBM policy");
  const scenario = session.scenario.name ?? "scenario";
  const runLog = new RunLog(scenario, `${policy.name === "jev" ? "" : `-${policy.name}`}${frozen ? "-frozen" : ""}`);
  onLog(runLog);
  const samples = new SampleLog(runLog.run);
  const templateHash = promptTemplateHash();
  runLog.record({ kind: "meta", scenario: session.scenario.name ?? null, policy: policy.name, regime, hold, username: session.username, players: session.scenario.players, entities: session.scenario.entities });
  runLog.record({ kind: "prompt", templateHash });
  session.log(`  policy ${policy.name}, regime ${regime}${regime === "latency" ? "" : `, hold ${hold} ticks`}, prompt ${templateHash}; log ${runLog.file}`);

  if (frozen) {
    tickCommand(bot, "freeze");
    bot.physicsEnabled = false;
    if (!(await frozenNow(bot))) throw new Error("the world age kept climbing after /tick freeze: is the player op: true in the fixture?");
  } else tickCommand(bot, "unfreeze"); // A client that died mid-fight leaves the server frozen for the next trial.

  if (demo) await withDemoFreeze(bot, session.signal, async () => {
    session.log("DEMO READY — start OBS now. The arena stays frozen for 20 seconds; then the fight runs in real time.");
    await demoWait(20_000, session.signal);
    session.log("DEMO ROLLING — waiting for two landed sword attacks, then a nearby creeper and a skeleton within six ticks of release.");
  });

  const clocks = new Clocks(bot, session.log, runLog);
  const startedAt = Date.now();
  let latencyMs = DEFAULT_LEAD_TICKS * 50;
  let last = "none yet";
  let previous: Applied | undefined;
  let swings = 0;
  let blocks = 0;
  let faced: Entity | undefined;
  let lastHostileTick = clocks.tick;
  // Mine Labs respawns a dead player outside the arena with full health; the death event is the reliable signal.
  let died = false;
  bot.once("death", () => {
    died = true;
    runLog.record({ kind: "death", tick: clocks.tick });
  });
  // The shield arc follows the head, so the head follows the target between windows too; inside a block the
  // target's bearing is noise and following it would spin the head.
  const track = () => {
    if (!bot.physicsEnabled) return;
    if (faced?.isValid && distance(bot, faced) >= 1) void bot.lookAt(eyes(faced), true).catch(() => undefined);
  };
  bot.on("physicsTick", track);
  // jev is paid per window: 400 windows live, or as many as the game-time cap allows when frozen.
  const maxTurns = !policy.name.startsWith("jev") ? Number.POSITIVE_INFINITY : regime === "frozen" ? Math.ceil(MAX_FIGHT_TICKS / hold) : MAX_JEV_TURNS;

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      session.signal.throwIfAborted();
      if (died || bot.health <= 0) return { status: "failed", detail: `died on turn ${turn} at tick ${clocks.tick}` };
      if (clocks.tick >= MAX_FIGHT_TICKS) break;

      // Sense: who is left, and everything about them and the ground, as numbers and as text.
      const enemies = hostiles(bot);
      if (enemies.length === 0) {
        // A fixture may spawn replacements a tick after a kill; only a quiet spell ends the fight.
        if (clocks.tick - lastHostileTick >= CLEAR_TICKS) return { status: demo ? "failed" : "succeeded", detail: demo ? "No matching demo moment occurred; record another attempt" : `no hostiles left after ${turn - 1} turns, ${swings} swings, shield up on ${blocks} turns` };
        await advance(bot, { regime, lead: 0, hold });
        continue;
      }
      lastHostileTick = clocks.tick;
      if (!faced || !enemies.includes(faced)) {
        faced = enemies[0]!;
        await bot.lookAt(eyes(faced), true);
      }
      const labelled = enemies.map((enemy, index) => ({ enemy, label: String.fromCharCode(65 + index) }));
      // Lead is only real when the world runs while the policy thinks; frozen and instant windows land at once.
      const lead = regime === "latency" ? Math.min(12, Math.max(3, Math.round(latencyMs / 50))) : 0;
      const window: Window = { regime, lead, hold: regime === "latency" ? lead : hold };
      beginWindow(window);
      const snapshot = snapshotData(bot, clocks, lead, labelled, faced);
      const now = nowLine(bot, clocks, snapshot, faced);
      const state = `${situation({ ...window, latencyMs }).trim()}\n\n${describe(bot, clocks, lead, labelled, faced, turn, last)}\n${now}`;
      for (const line of state.split("\n")) session.log(`  ${line}`);
      const asked = questions(labelled.map(({ enemy, label }) => ({ label, blurb: faceBlurb(bot, clocks, lead, enemy) })));
      const features = featureRow(snapshot, { previous: previousOf(previous) });

      if (demo && demoMoment(snapshot, clocks.swordHits.length)) {
        const captured = await withDemoFreeze(bot, session.signal, async () => {
          // Read again after acknowledgement: this is the stationary world visible in the video.
          const pausedEnemies = hostiles(bot).map((enemy, index) => ({ enemy, label: String.fromCharCode(65 + index) }));
          if (!faced?.isValid) return false;
          const paused = snapshotData(bot, clocks, lead, pausedEnemies, faced);
          if (!demoMoment(paused, clocks.swordHits.length)) return false;
          const pausedNow = nowLine(bot, clocks, paused, faced);
          const pausedState = `${situation({ ...window, latencyMs }).trim()}\n\n${describe(bot, clocks, lead, pausedEnemies, faced, turn, last)}\n${pausedNow}`;
          const pausedQuestions = questions(pausedEnemies.map(({ enemy, label }) => ({ label, blurb: faceBlurb(bot, clocks, lead, enemy) })));
          const pausedFeatures = featureRow(paused, { previous: previousOf(previous) });
          const decision = await policy.decide({ state: pausedState, questions: pausedQuestions, features: pausedFeatures, enemyLabels: pausedEnemies.map(e => e.label) });
          const file = saveDemo(runLog.run, { turn, tick: paused.tick, snapshot: paused, state: pausedState, now: pausedNow,
            questions: pausedQuestions, features: pausedFeatures, answers: decision.answers, policy: policy.name,
            capturedAt: new Date().toISOString(), jevAnswer: null, swordHits: clocks.swordHits }, policy.model);
          runLog.record({ kind: "demo", turn, tick: paused.tick, file });
          session.log(`DEMO CAPTURED — ${file} (${clocks.swordHits.length} landed sword attacks before this frame)`);
          session.log("Hold this frozen picture in OBS. Stop recording now; capture ends in 20 seconds. No decision is applied after this frame.");
          await demoWait(20_000, session.signal);
          return true;
        });
        if (captured) return { status: "succeeded", detail: "Demo moment captured; realtime fight stopped before applying the selected decision" };
        continue;
      }

      // Decide.
      const askedAt = Date.now();
      const { answers, usage } = await policy.decide({ state, questions: asked, features, enemyLabels: labelled.map(({ label }) => label) });
      const latency = Date.now() - askedAt;
      latencyMs = Math.round(latencyMs * 0.6 + latency * 0.4);
      if (!faced.isValid) continue;

      // Act.
      const outcome = await applyDecision(bot, clocks, answers, snapshot, labelled, faced);
      faced = outcome.faced;
      const applied = outcome.applied;
      if (applied.swung) swings += 1;
      if (applied.guarding) blocks += 1;
      last = `faced ${applied.facedName}, ${applied.controls.join("+") || "hold"}, hands ${applied.hands}${applied.note}${applied.drift}`;
      session.log(
        `turn ${turn} ${latency} ms${usage ? ` ${usage.input_tokens} tok` : ""} lead ${lead} | ${enemies.length} enemies, facing ${applied.face}=${applied.facedName} ` +
          `at ${distance(bot, faced).toFixed(1)} | health ${bot.health.toFixed(1)} | move ${applied.move} hands ${applied.hands} pace ${applied.pace} -> ${last}`,
      );

      // Record: the window for the viewer, and the training row.
      runLog.record({ kind: "turn", turn, tick: snapshot.tick, appliedTick: clocks.tick, lead, regime, hold: window.hold, latencyMs: latency, usage: usage ?? null, snapshot, state, questions: asked, now, answers, applied });
      samples.record({
        run: runLog.run,
        scenario,
        policy: policy.name,
        promptHash: promptHash(asked, templateHash),
        turn,
        tick: snapshot.tick,
        lead,
        regime,
        hold: window.hold,
        latencyMs: latency,
        features,
        labels: labelsOf(answers, labelled.map(({ label }) => label)),
        answers,
        text: { state, now, faceCriteria: asked.face?.type === "choice" ? asked.face.criteria : {} },
      });
      previous = applied;

      await advance(bot, window);
    }
    bot.clearControlStates();
    return { status: "failed", detail: `hostiles still alive after ${clocks.tick} ticks and ${Date.now() - startedAt} ms, ${swings} swings, shield up on ${blocks} turns` };
  } finally {
    bot.off("physicsTick", track);
    if (frozen) {
      bot.physicsEnabled = true;
      tickCommand(bot, "unfreeze");
    }
  }
}

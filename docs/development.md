# Development guide

[Project overview](../README.md)

Commands below run from the repository root. For the published recording and analysis provenance, see [recording notes](../site/recording.md).

## Layout

The loop is `src/fight.ts`; everything else is what it needs, grouped by role.

| Path | What it is |
| --- | --- |
| `src/fight.ts` | The loop: sense, decide, act, record, advance. Owns the Mineflayer connection and nothing else steers. |
| `src/regime.ts` | How a window relates to game time (latency, instant, frozen), the fight bounds, and the TIMING notes every clock refers to. |
| `src/sense/` | `world.ts` reads the world and entities; `clocks.ts` counts cooldowns and attributes hits from events; `snapshot.ts` is the window as numbers; `describe.ts` is the same window as prose for jev; `features.ts` is the same window as a flat row for the model; `constants.ts` and `geometry.ts` are what they share; `perception/` is the ported bow, arrow and creeper timing. |
| `src/decide/` | `policy.ts` chooses who answers (jev, the model, or fixed answers); `prompt.ts` is the situation paragraph and the five questions; `jev.ts` the API client; `lgbm-json.ts` reads the model file and walks its trees, so the model runs in the loop with no Python (there is no LightGBM runtime for Bun). |
| `src/act/actions.ts` | Turns an answer into controls, a swing, a shield or a block of cover, and gears the bot up. |
| `src/record/` | `run-log.ts` writes the JSONL the viewer replays; `samples.ts` writes the training row. |
| `src/run.ts` | Launcher: `bun src/run.ts <fixture> [--policy lgbm] [--frozen --step 2] [--repeat n] [--watch]`. |
| `scenarios/` | Mine Labs fixtures: `zombie-duel`, `mixed-fight`, `terrain-fight`, `skeleton-gauntlet`, `basalt-delta`, `nether-fortress`, and `generated/` from `generate.ts`. |
| `templates/arenas/` | The walled arena the fixtures share. |
| `ml/` | `backfill.ts` rebuilds samples from logs, `train.py` trains the heads (a uv project with LightGBM, polars and scikit-learn), `lgbm_json.py` writes the model file format that `src/decide/lgbm-json.ts` reads, `verify.ts` checks the TypeScript predictor against Python. |
| `viewer/` | Bun server and a single page: run list, health timeline with hits and decisions, top-down replay, decision panel with the text and the feature row. |
| `review/` | `compare.ts` tabulates outcomes by scenario and policy; `tactics.ts` measures habits (reversals, wall use, strikes in reach); `batch.ts` summarises recent runs of one fixture. |
| `logs/`, `data/samples/`, `ml/models/` | Local only, not in git: run logs, training rows, trained models. See Data below. |

## Setup

Bun 1.4 or newer, Java 21 for the Minecraft server Mine Labs runs, and
[uv](https://docs.astral.sh/uv/) for the trainer.

```bash
bun install
```

Live jev needs a TypeSafe key in `.env` at the project root:

```
JEV_API_KEY=...
```

## Mode one: live jev

```bash
bun src/run.ts terrain                        # jev at its own latency
bun src/run.ts terrain --frozen --step 2      # jev with the world paused while it thinks
bun src/run.ts gauntlet --frozen --step 2 --repeat 3 --watch
```

Fixtures are `terrain`, `mixed`, `duel`, `gauntlet`, `basalt`, `fortress`, a
file under `scenarios/`, or a path. `--watch` opens the Mine Labs client.

What jev reads each window is built in `src/sense/describe.ts` from the
snapshot in `src/sense/snapshot.ts`, so every number in the prose has a
twin in the logged data. The questions and their criteria are in
`src/decide/prompt.ts`. A hash of the prompt-building code is stamped on
every log and sample as `promptHash`, so a change to the teacher is a new
version the trainer can select on.

Timing is the part that needs care. jev answers in about six ticks, so a
live answer is a forecast: the text says at which tick it will land and
every countdown is measured from there. `--frozen` takes the latency out:
the bot is an operator, freezes the server while jev thinks, then steps
exactly `--step` ticks and asks again. Lead is zero and the answer holds
for the step, which is the shape the model runs in, so frozen labels are
for the regime the model faces. The full set of considerations, including
what the freeze does and does not stop, is the TIMING comment in
`src/regime.ts`.

## Mode two: the distilled model

```bash
bun run samples      # data/samples from every log under logs/ (--force rebuilds)
bun run train        # five heads on the frozen jev rows, run-grouped CV, ml/models/jev-lgbm.json
bun run verify       # the TypeScript predictor matches Python's probabilities
bun src/run.ts mixed --policy lgbm --repeat 3
bun src/run.ts fortress --policy lgbm --watch
bun run compare      # outcomes by scenario and policy over the logs
```

Each question is its own model: `face` predicts an enemy slot (nearest
first, as jev letters them) or `keep`; `move`, `hands` and `pace` their
choices; `jump` yes or no. Rows are the feature row in
`src/sense/features.ts`, a pure function of the logged snapshot, so live
fights and replayed logs produce identical rows. The row describes the
situation only: relative distances, angles and countdowns, never a tick or
turn counter, an absolute position or the timing regime, which would let a
model learn the fixtures' scripts rather than the combat. The model answers within a
tick, so the loop runs the instant regime: apply, let `--step` ticks run
(two by default), ask again. `--sample` draws each answer from the model's
distribution instead of the argmax; `--lead-ms 300` holds answers back to
jev's own latency for a like-for-like comparison.

The deployed model is trained on every frozen jev window: 17,592 windows
from 93 fights across all six fixtures and the generated set. Runs are held
out whole for grouped cross-validation. These validation folds also select the
boosting rounds, so the scores are validation estimates rather than an untouched
final test. They measure imitation of Jev, not combat win rates.

| Question | Majority class | Agreement with jev | Where jev was at least 60 % sure |
| --- | --- | --- | --- |
| face | 75.0 % | 89.7 % | 98.7 % |
| move | 64.9 % | 90.8 % | 99.2 % |
| hands | 84.7 % | 97.4 % | 99.8 % |
| pace | 89.4 % | 98.9 % | 99.9 % |
| jump | 99.2 % | 99.7 % | – |

## Data

`logs/` holds one JSONL per fight: a `frame` every tick, a `turn` per
decision with the snapshot, the text, the questions, the answers and what
was applied, plus swing, shield, hit and end records. `data/samples/` holds
one row per window with the feature row, the labels, jev's probabilities and
the text. Both are rebuilt or written by every run and are the paid-for
asset: keep them backed up outside the repository. `ml/models/` is rebuilt
from the samples in about two minutes. None of those directories is tracked in
Git. The selected demo model is committed separately at `site/content/model.json`;
a fresh clone can use it without retraining:

```bash
bun src/run.ts mixed --policy lgbm --model site/content/model.json --watch
```

## Explore a fight

```bash
bun run viewer
```

Then open http://localhost:4321/. Arrow keys step one tick, shift with
arrows jumps between decisions, space plays at real time. The panel shows
the decision in force at the current tick: when it was asked, when it took
effect, every answer with its probabilities, the "right now" sentence, the
full state text, and the feature row the model would read.

For recording a playthrough, http://localhost:4321/live.html follows the
newest log as it is written: each window's five answers with every option's
probability, what was applied, the "right now" sentence, health, and hits
as they land. Start the viewer, put that page next to the Mine Labs client,
and run a fight with `--watch`. To show jev and the model against each
other, open `live.html?policy=jev` and `live.html?policy=lgbm` side by side:
each follows only its own policy's fights, so after a jev fight and a model
fight both panels hold their last window, with each fight's latency per
window and its mean.

## The single-moment demo

`site/` presents one real recording, one frozen moment, and a Jev / LightGBM
switch over that same captured state. Jev shows the exact generated state text
and questions; LightGBM shows the captured model's predictions and editable
features. The Jev tab includes a saved response requested after the recording;
LightGBM controlled the recorded fight. Editing a
feature holds other inputs fixed, including derived values; it is not a world
simulation. The existing viewer remains available for full-fight analysis.

### Record now

Prepare OBS Game Capture for the Mine Labs Minecraft client, then run from the
project root:

```powershell
bun run demo:record
```

This expands to `bun src/run.ts demo-moment --policy lgbm --model site/content/model.json --demo --watch`.
It uses the committed demo model in real time, with the ordinary two-tick decision
windows. **Do not add `--frozen`.** No Jev API call or key is needed.

1. When the log says **DEMO READY**, start OBS recording. The world stays frozen
   for 20 seconds to let you frame the arena. Keep the creeper, skeleton and bot
   visible from a fixed spectator angle. The fight then starts automatically.
2. The capture first waits for **two landed sword attacks**, confirmed by server
   damage events (empty swings do not count). The nearer zombie provides the
   opening combat. Then it waits for a visible creeper within 8 blocks and a skeleton looking
   at the bot, drawing with a known **1–6 ticks until release**, while the bot is
   alive and grounded. It confirms the server freeze and reads the state again.
3. When **DEMO CAPTURED** appears, keep a few seconds of the stationary picture,
   then stop OBS. The world stays held for 20 seconds before the run completes.
   The selected decision is predicted but not applied. A run without a matching
   moment fails explicitly; it does not silently export some other frame.
4. Save/remux the recording to MP4 (H.264 is a suitable browser format). Trim off
   the setup/countdown, keeping the action and a short final frozen hold. Do not
   speed it up. Keep the capture filename printed by **DEMO CAPTURED** alongside
   the recording, so they cannot get mixed up.

The files `data/demo/<run>.json` and `<run>.model.json` hold the confirmed paused
snapshot, verbatim state/questions, all 414 features, model answers, and the
exact model. They stay local until explicitly exported. Freeze cleanup restores
server ticking and bot physics on completion, failure or cancellation. As with
normal frozen runs, Minecraft player cooldowns continue during a server freeze;
the recorded countdowns are the fight's simulation clocks, not wall-clock time
spent waiting in OBS.

### Add the recording and choose its pause point

```powershell
bun site/export.ts --capture data/demo/<run>.json --video "C:/path/to/demo.mp4"
bun site/export-analysis.ts
bun run site:build
bunx serve dist
```

Open the local server with `?calibrate` added to its URL. Scrub to a clear frame
in the **final frozen hold** and click **Use this video time**. It prints the
`--pause-at` value in seconds. Export that same capture and video again with it:

```powershell
bun site/export.ts --capture data/demo/<run>.json --video "C:/path/to/demo.mp4" --pause-at 3.250
bun site/export-analysis.ts
bun site/build.ts --release
```

`3.250` is an example, not an automatic offset. Use the value from your edited
video. Because the game is frozen, a frame inside that hold corresponds to the
saved state without guessing from log wall-clock timestamps. Video playback
pauses there and reveals the toggle; **Watch again** re-arms it.

Without `--video`, export makes a state-only local preview and clears any prior
video calibration. The selected recording is now the user-recorded September 22 fight, paired with
`2026-09-22T01-29-22-740Z-jev-demo-moment-lgbm`. The 720p silent clip is 7.47
seconds long and pauses at 5.4 seconds, after four server-confirmed sword hits.
See `site/recording.md` for the source trim and crop.
The probability panel replays saved decisions alongside the clip; export and timing
details are in `site/recording.md`.
Only `config.json`, `moment.json`, `model.json`, `analysis.json`, the configured video, optional poster and decision timeline enter
the build. The old full-fight exports are not shipped. Model values are kept
at full precision so browser predictions match the run.

Commit the selected inputs under `site/content/` and the source changes; do not
commit `dist/`. The existing `.github/workflows/pages.yml` builds and publishes
through GitHub Actions on main. The release build deliberately fails until a
video and a non-negative pause point are configured. Pages must use **GitHub
Actions** as its publishing source. The final video timestamp must also lie
inside the recording; the browser reports an invalid calibration.

### Build from a clean checkout

All selected demo assets are committed under `site/content/`, including the
trained prediction model, captured state/request/response, probability timeline,
video, poster and precomputed analysis. GitHub Actions builds these inputs; it
does not run training or the data-export scripts. No Jev key, Minecraft server,
Python environment, raw samples, development logs or original OBS recording is
needed for the site build.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test src/record/demo.test.ts src/sense/perception/bow-timing.test.ts
bun site/build.ts --release
```

Regenerating `analysis.json` is a separate local step that requires the original
training samples. Its model hash is checked during the build. The generated
`dist/` folder is uploaded to Pages by Actions and stays out of Git.

## What was learned

Results from the development experiments that shaped the code:

- **Latency changes the fighter.** jev with no latency circles instead of
  backing off and takes a quarter of the damage live jev does. All training
  rows are frozen rows for that reason.
- **jev is not deterministic, and that matters.** In a clinch it guards and
  backs off in nine windows of ten and strikes in the odd one, and that
  strike is what breaks the clinch. An argmax policy can sit in the clinch;
  `--sample` restores the exits. Decisions are asked to hold two ticks and
  the move criteria ask jev to keep circling the same way, which cut
  sidestep reversals from about half of consecutive windows to a tenth.
- **Facts beat prose.** Computed lines ("out of reach with the sword ready
  and nothing due, so close", "column here would silence archer B") moved
  jev's behaviour; descriptive advice did not. The compact prompt halved the
  tokens per window without changing the answers, as long as the face
  priority stayed in the question.
- **The ceiling is the crossfire.** In the skeleton gauntlet the remaining
  hits are a point-blank trade as a strike lands and the third bow no facing
  covers. Cover columns, a learned danger map, outcome-weighted training,
  a hands-outcome head with randomised exploration, and one DAgger round were
  all tried against it and none moved the arrow count; the DAgger round made
  the model worse and its rows are kept on disk but skipped by the trainer.
- **Terrain is in the row.** A five-by-five egocentric grid, walls in eight
  directions and line of sight per enemy went into both the text and the
  feature row, and a move into lava, water, magma or a drop is refused for
  every policy after the model walked into basalt-delta lava once.

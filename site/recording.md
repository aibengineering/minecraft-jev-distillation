# Selected recording

- Original: `2026-09-22 11-29-04.mkv` (the user's OBS recording; unchanged).
- Capture: `2026-09-22T01-29-22-740Z-jev-demo-moment-lgbm`, turn 42, tick 82.
- Four direct sword hits acknowledged at ticks 6, 20, 54 and 68.
- Source interval: 39.5–47.0 seconds, including the opening attacks and frozen hold.
- Crop: 1776 × 1000 pixels at x=2, y=200 from the 2560 × 1440 recording.
  This frames the arena without the desktop, live viewer, window chrome or debug overlay.
- Output: 1280 × 720, H.264, 30 fps, no audio, fast-start MP4; 927,745 bytes.
- Pause: 5.4 seconds in the edited clip (44.9 seconds in the original), within the
  stationary hold after the fight reaches tick 82. The later capture write time
  includes the server-freeze acknowledgement wait.
- Poster: first frame of the edited clip.

To reproduce with ffmpeg, from the repository root (substitute the source path):

```powershell
ffmpeg -ss 39.5 -i "<source.mkv>" -t 7.5 -vf "crop=1776:1000:2:200,scale=1280:720,setsar=1" -an -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -movflags +faststart site/content/demo.mp4
```

`site/content/config.json` connects the clip and poster to the captured inputs.
The entire recording and other fight logs are not part of the Pages build.

## Jev comparison

The captured `state` and `questions` were sent to Jev in one successful API call
after recording. The full `jev-1.13.0` response is preserved as `jevAnswer` in both
the source capture and the site's `moment.json`. `jevResponseMeta` records the
request time, requested model, SHA-256 of the exact request body and measured
round-trip time (662 ms for this call).

The page shows answer probabilities, distinct from Jev's separate `confidence`
field, and includes the unmodified response JSON. Jev's choices agree with the
captured LightGBM prediction: face A, back, guard, sprint, and no jump (Jev's jump
probability is 0.07). This comparison was not applied in the recorded fight.

## Probability panel

The original sidebar is disconnected through much of the opening exchange, and
its text is too small when the full desktop is scaled into the page. The page
instead displays the run's saved probabilities as HTML below the arena video.

`decisions.json` contains the 41 applied decisions and the final captured prediction
(turn 42, explicitly marked as not applied). Values are copied from `answers`,
with enemy names resolved separately at each turn because letter slots change
when the zombie dies. Editing the frozen inputs does not alter this recorded panel.

Tick zero is aligned to approximately 40.3 seconds in the original, or 0.8 seconds
in the edited clip. Alignment uses the visible tick counter during the latter
part of the recording and 20 game ticks per second; it is not a per-frame timestamp
recording. Replay and seeking select the corresponding saved tick.

After exporting the matching capture and video, regenerate this small asset with:

```powershell
bun site/export-decisions.ts data/samples/2026-09-22T01-29-22-740Z-jev-demo-moment-lgbm.jsonl 0.8
```

## Model analysis

After changing the published model, regenerate the analysis before building:

```powershell
bun site/export-analysis.ts
bun site/build.ts --release
```

The exporter reads only the model's listed training runs, checks row and label
counts against its saved metadata, and copies the saved grouped cross-validation
scores. Validation folds also selected boosting rounds; these are not scores on
an untouched test set. Importance is split frequency because the pruned model
does not retain gain. PDPs average raw class probabilities across deterministic
samples of up to 1,024 rows per feature, restricted to rows where it was observed.
They vary one feature at a time, leaving correlated features unchanged.
The page presents three selected, annotated contrasts: sword cooldown and
striking, incoming-shot angle and facing, and ground type and jumping. These
were chosen after inspecting candidates; they are not an exhaustive effect ranking.

`analysis.json` contains aggregated scores, split counts and PDP points, not raw
training rows. The build checks its model SHA-256 to prevent stale analysis.

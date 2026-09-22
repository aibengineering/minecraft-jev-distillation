"""Distils jev's answers into five LightGBM models, one per question.

    uv run --project ml python ml/train.py --regime frozen [--since 2026-09-21T06-17] [--latest-prompt]

Reads every row under data/samples, holds runs out whole (GroupKFold by run)
to measure how often each model picks what jev picked, then trains on all
rows and writes ml/models/jev-lgbm.json in the format lgbm_json.py describes:
the feature order, each head's class list and tree dump, and the
cross-validated agreement. It also writes ml/models/check.jsonl, a few hundred
rows with Python's own probabilities, which `bun ml/verify.ts` compares with
the TypeScript predictor. Rows from the model's own runs (policy lgbm) are
ignored; --regime frozen selects the zero-lead labels the model runs under.
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import polars as pl
from lgbm_json import head_entry
from sklearn.metrics import accuracy_score, f1_score, log_loss
from sklearn.model_selection import GroupKFold

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "data" / "samples"
MODELS = ROOT / "ml" / "models"

# Mirrors CLASSES in src/sense/features.ts; the order is what the model file records.
CLASSES = {
    "face": ["0", "1", "2", "3", "4", "5", "keep"],
    "move": ["forward", "back", "left", "right", "hold"],
    "hands": ["strike", "guard", "free", "cover"],
    "pace": ["sprint", "walk", "sneak"],
    "jump": ["false", "true"],
}

PARAMS = {
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 20,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "verbose": -1,
    "seed": 7,
    "num_threads": 0,
}


def load(policy: str, regime: str) -> pl.DataFrame:
    """One row per window: run, scenario, promptHash, regime, then f:<feature>, y:<head> and c:<head> (jev's confidence).

    A plain loop over the JSONL: the files are nested (a 410-field feature struct, answers with per-enemy
    probabilities) and their schemas drift between runs, and letting polars infer them is four times slower.
    """
    rows = []
    for file in sorted(SAMPLES.glob("*.jsonl")):
        for line in file.read_text(encoding="utf8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if policy != "any" and row["policy"] != policy:
                continue
            if regime != "any" and row.get("regime", "latency") != regime:
                continue
            # DAgger relabels (a `relabel` field) are kept on disk for the record; training on them made the model worse.
            if "relabel" in row:
                continue
            rows.append({
                "run": row["run"],
                "scenario": row["scenario"],
                "promptHash": row["promptHash"],
                "regime": row.get("regime", "latency"),
                **{f"f:{name}": value for name, value in row["features"].items()},
                **{f"y:{head}": str(row["labels"][head]).lower() for head in CLASSES},
                **{f"c:{head}": row["answers"].get(head, {}).get("confidence") for head in ("face", "move", "hands", "pace")},
            })
    if not rows:
        raise SystemExit(f"no rows for policy {policy!r} regime {regime!r} under {SAMPLES}; run `bun ml/backfill.ts` first")
    return pl.from_dicts(rows, infer_schema_length=None)


def tally(column: pl.Series) -> dict:
    return dict(column.value_counts().sort("count", descending=True).iter_rows())


def head_params(head: str) -> dict:
    if head == "jump":
        return {**PARAMS, "objective": "binary"}
    return {**PARAMS, "objective": "multiclass", "num_class": len(CLASSES[head])}


def probabilities(booster: lgb.Booster, x: np.ndarray, head: str) -> np.ndarray:
    p = booster.predict(x)
    if head == "jump":
        p = np.asarray(p).reshape(-1)
        return np.stack([1 - p, p], axis=1)
    return np.asarray(p)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", default="jev", help="whose answers to learn (rows from other policies are ignored)")
    parser.add_argument("--regime", default="any", choices=["any", "latency", "instant", "frozen"], help="keep rows from one timing regime only (see TIMING in src/regime.ts)")
    parser.add_argument("--latest-prompt", action="store_true", help="train only on rows from the most recent prompt version")
    parser.add_argument("--since", default="", help="keep only runs whose name sorts at or after this prefix, e.g. 2026-09-21T06-17")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--rounds", type=int, default=600, help="upper bound on boosting rounds; early stopping picks the rest")
    parser.add_argument("--out", default=str(MODELS / "jev-lgbm.json"))
    args = parser.parse_args()

    df = load(args.policy, args.regime)
    print(f"{df.height} rows from {df['run'].n_unique()} runs, scenarios {tally(df['scenario'])}, regimes {tally(df['regime'])}")
    prompts = (
        df.group_by("promptHash")
        .agg(pl.len().alias("rows"), pl.col("run").n_unique().alias("runs"), pl.col("run").min().alias("first"), pl.col("run").max().alias("last"))
        .sort("last")
    )
    print("prompt versions (by hash of the prompt-building code):")
    with pl.Config(tbl_rows=50, fmt_str_lengths=64, tbl_hide_dataframe_shape=True, tbl_hide_column_data_types=True):
        print(prompts)
    if args.since:
        df = df.filter(pl.col("run") >= args.since)
        print(f"runs since {args.since}: {df.height} rows from {df['run'].n_unique()} runs")
    if args.latest_prompt:
        latest = prompts["promptHash"][-1]
        df = df.filter(pl.col("promptHash") == latest)
        print(f"training on the latest prompt only: {latest}, {df.height} rows from {df['run'].n_unique()} runs")

    feature_names = [c[2:] for c in df.columns if c.startswith("f:")]
    x_all = df.select(pl.col(f"f:{n}").cast(pl.Float64) for n in feature_names).to_numpy()
    groups = df["run"].to_numpy()
    folds = min(args.folds, df["run"].n_unique())
    splitter = GroupKFold(n_splits=folds)

    heads_out: dict[str, dict] = {}
    final: dict[str, lgb.Booster] = {}
    cv_report: dict[str, dict] = {}
    for head, classes in CLASSES.items():
        y_text = df[f"y:{head}"].to_numpy()
        unknown = sorted(set(y_text) - set(classes))
        if unknown:
            raise SystemExit(f"{head}: labels {unknown} are not in the class list")
        y = np.array([classes.index(v) for v in y_text])
        counts = tally(df[f"y:{head}"])
        majority = max(counts.values()) / len(y)
        oof = np.zeros((len(y), len(classes)))
        best_iterations = []
        for train_idx, test_idx in splitter.split(x_all, y, groups):
            train_set = lgb.Dataset(x_all[train_idx], y[train_idx], feature_name=feature_names, free_raw_data=False)
            valid_set = lgb.Dataset(x_all[test_idx], y[test_idx], reference=train_set)
            booster = lgb.train(
                head_params(head), train_set, num_boost_round=args.rounds, valid_sets=[valid_set], callbacks=[lgb.early_stopping(40, verbose=False)]
            )
            best_iterations.append(booster.best_iteration or args.rounds)
            oof[test_idx] = probabilities(booster, x_all[test_idx], head)
        predicted = oof.argmax(axis=1)
        accuracy = accuracy_score(y, predicted)
        macro_f1 = f1_score(y, predicted, average="macro", labels=sorted(set(y)), zero_division=0)
        ll = log_loss(y, oof, labels=list(range(len(classes))))
        if head == "jump":
            confident = np.ones(len(y), dtype=bool)
        else:
            confident = df[f"c:{head}"].cast(pl.Float64).fill_null(0.0).to_numpy() >= 0.6
        agreement_confident = accuracy_score(y[confident], predicted[confident]) if confident.any() else float("nan")
        rounds = max(20, int(np.mean(best_iterations)))
        cv_report[head] = {
            "rows": int(len(y)),
            "classes": {c: int(counts.get(c, 0)) for c in classes},
            "majorityBaseline": round(float(majority), 4),
            "accuracy": round(float(accuracy), 4),
            "accuracyWhereJevConfident": round(float(agreement_confident), 4),
            "confidentShare": round(float(confident.mean()), 4),
            "macroF1": round(float(macro_f1), 4),
            "logLoss": round(float(ll), 4),
            "rounds": rounds,
        }
        print(f"\n{head}: {counts}")
        print(
            f"  majority {majority:.3f}  accuracy {accuracy:.3f}  (where jev >= 60% sure, {confident.mean():.0%} of rows: {agreement_confident:.3f})"
            f"  macro-F1 {macro_f1:.3f}  logloss {ll:.3f}  rounds {rounds}"
        )

        full = lgb.Dataset(x_all, y, feature_name=feature_names, free_raw_data=False)
        booster = lgb.train(head_params(head), full, num_boost_round=rounds)
        final[head] = booster
        gain = booster.feature_importance(importance_type="gain")
        total = float(gain.sum()) or 1.0
        top = sorted(zip(feature_names, gain), key=lambda kv: -kv[1])[:12]
        print("  top features: " + ", ".join(f"{n} {g / total:.1%}" for n, g in top))
        heads_out[head] = head_entry(booster, classes)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "featureNames": feature_names,
        "heads": heads_out,
        "meta": {
            "policy": args.policy,
            "regime": args.regime,
            "rows": df.height,
            "runs": df["run"].unique().sort().to_list(),
            "latestPromptOnly": bool(args.latest_prompt),
            "promptHashes": df["promptHash"].unique().sort().to_list(),
            "params": PARAMS,
            "cv": cv_report,
        },
    }
    out.write_text(json.dumps(payload), encoding="utf8")
    print(f"\nwrote {out} ({out.stat().st_size / 1e6:.1f} MB)")

    # A slice with Python's own probabilities, for the TypeScript predictor to be checked against.
    rng = random.Random(7)
    picks = rng.sample(range(df.height), min(300, df.height))
    check = out.parent / "check.jsonl"
    with check.open("w", encoding="utf8") as handle:
        for i in picks:
            row = {n: (None if np.isnan(v) else float(v)) for n, v in zip(feature_names, x_all[i])}
            expected = {}
            for head, classes in CLASSES.items():
                p = probabilities(final[head], x_all[i : i + 1], head)[0]
                expected[head] = {c: float(p[k]) for k, c in enumerate(classes)}
            handle.write(json.dumps({"features": row, "expected": expected}) + "\n")
    print(f"wrote {check} with {len(picks)} rows for `bun ml/verify.ts`")


if __name__ == "__main__":
    main()

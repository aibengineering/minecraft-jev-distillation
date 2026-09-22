"""The model file format: LightGBM's `Booster.dump_model()` JSON, pruned to what
prediction needs, one entry per question head.

    {
      "version": 1, "trainedAt": ..., "featureNames": [...],
      "heads": { "<head>": { "classes": [...], "objective": "multiclass" | "binary", "model": <pruned dump> } },
      "meta": { ... how it was trained, the cross-validation report ... }
    }

The pruned dump keeps `num_class`, `num_tree_per_iteration`, `objective`,
`feature_names` and, per tree, the split nodes (feature, threshold, decision
type, missing-value routing) and leaf values; counts, gains and weights are
dropped, which cuts the file to a third. There is no LightGBM runtime for
Bun, so the reader is our own: src/decide/lgbm-json.ts walks these trees and
applies the softmax or sigmoid, and `bun ml/verify.ts` checks it against
Python over the rows in check.jsonl.
"""

from __future__ import annotations

import lightgbm as lgb

KEEP_NODE_KEYS = {"split_feature", "threshold", "decision_type", "default_left", "missing_type", "left_child", "right_child", "leaf_value"}


def _prune(node: dict) -> dict:
    out = {k: v for k, v in node.items() if k in KEEP_NODE_KEYS}
    for child in ("left_child", "right_child"):
        if child in out:
            out[child] = _prune(out[child])
    return out


def head_entry(booster: lgb.Booster, classes: list[str]) -> dict:
    """One head's entry for the model file: its class list, objective and pruned tree dump."""
    dump = booster.dump_model()
    return {
        "classes": classes,
        "objective": "binary" if dump["num_class"] == 1 else "multiclass",
        "model": {
            "num_class": dump["num_class"],
            "num_tree_per_iteration": dump["num_tree_per_iteration"],
            "objective": dump["objective"],
            "feature_names": dump["feature_names"],
            "tree_info": [{"tree_index": t["tree_index"], "tree_structure": _prune(t["tree_structure"])} for t in dump["tree_info"]],
        },
    }

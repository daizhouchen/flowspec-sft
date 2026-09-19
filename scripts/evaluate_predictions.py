"""Evaluate saved model predictions with the same structural metrics as the heuristic baseline."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from flowspec.eval import f1, features, load_jsonl
from flowspec.simulator import simulate
from flowspec.validator import repair_workflow, validate_workflow


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gold", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    gold = {row["id"]: row for row in load_jsonl(args.gold)}
    predictions = {row["id"]: row for row in load_jsonl(args.predictions)}
    scores = {"schema": 0, "dag": 0, "sandbox": 0, "tool": [], "slot": [], "edge": []}
    parse_failures = 0
    repairs = 0
    exact_structures = 0
    latencies = []
    for item_id, row in gold.items():
        record = predictions.get(item_id, {})
        prediction = record.get("prediction")
        latencies.append(float(record.get("latency_ms", 0)))
        if not isinstance(prediction, dict):
            parse_failures += 1
            prediction = {}
        workflow, validation = validate_workflow(prediction)
        if not validation.valid and prediction:
            repaired, repair_log = repair_workflow(prediction, validation.issues)
            repairs += int(bool(repair_log))
            workflow, validation = validate_workflow(repaired)
            prediction = repaired
        scores["schema"] += int(validation.schema_valid)
        scores["dag"] += int(validation.dag_valid)
        scores["sandbox"] += int(
            bool(workflow and validation.valid and simulate(workflow).status == "completed")
        )
        predicted_features = features(prediction)
        gold_features = features(row["output"])
        exact_structures += int(predicted_features == gold_features)
        for name, predicted_set, gold_set in zip(
            ["tool", "slot", "edge"], predicted_features, gold_features, strict=True
        ):
            scores[name].append(f1(predicted_set, gold_set))
    count = len(gold)
    result = {
        "count": count,
        "parse_failure_rate": round(parse_failures / count, 4),
        "schema_valid_rate": round(scores["schema"] / count, 4),
        "dag_valid_rate": round(scores["dag"] / count, 4),
        "sandbox_pass_rate": round(scores["sandbox"] / count, 4),
        "tool_f1": round(sum(scores["tool"]) / count, 4),
        "argument_slot_f1": round(sum(scores["slot"]) / count, 4),
        "dependency_edge_f1": round(sum(scores["edge"]) / count, 4),
        "exact_structure_rate": round(exact_structures / count, 4),
        "repair_rate": round(repairs / count, 4),
        "mean_latency_ms": round(sum(latencies) / count, 2),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

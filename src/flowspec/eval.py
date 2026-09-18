from __future__ import annotations

import argparse
import json
from pathlib import Path

from .compiler import HeuristicCompiler
from .simulator import simulate
from .validator import validate_workflow


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def f1(predicted: set, expected: set) -> float:
    if not predicted and not expected:
        return 1.0
    tp = len(predicted & expected)
    precision = tp / max(1, len(predicted))
    recall = tp / max(1, len(expected))
    return 2 * precision * recall / max(1e-9, precision + recall)


def features(workflow: dict) -> tuple[set, set, set]:
    tools = {node["tool"] for node in workflow.get("nodes", [])}
    slots = {(node["tool"], key) for node in workflow.get("nodes", []) for key in node.get("arguments", {})}
    edges = {(dep, node["id"]) for node in workflow.get("nodes", []) for dep in node.get("depends_on", [])}
    return tools, slots, edges


def evaluate_rows(rows: list[dict]) -> dict:
    compiler = HeuristicCompiler()
    schema_valid = dag_valid = sandbox_pass = exact = 0
    tool_scores = []
    slot_scores = []
    edge_scores = []
    errors: dict[str, int] = {}
    for row in rows:
        prediction = compiler.compile(row["instruction"])
        workflow, validation = validate_workflow(prediction)
        schema_valid += int(validation.schema_valid)
        dag_valid += int(validation.dag_valid)
        for issue in validation.issues:
            errors[issue.code] = errors.get(issue.code, 0) + 1
        if workflow and validation.valid:
            sandbox_pass += int(simulate(workflow).status == "completed")
        gold = row["output"]
        p_tools, p_slots, p_edges = features(prediction)
        g_tools, g_slots, g_edges = features(gold)
        tool_scores.append(f1(p_tools, g_tools))
        slot_scores.append(f1(p_slots, g_slots))
        edge_scores.append(f1(p_edges, g_edges))
        exact += int((p_tools, p_slots, p_edges) == (g_tools, g_slots, g_edges))
    count = len(rows)
    return {
        "count": count,
        "compiler": compiler.name,
        "schema_valid_rate": round(schema_valid / count, 4),
        "dag_valid_rate": round(dag_valid / count, 4),
        "sandbox_pass_rate": round(sandbox_pass / count, 4),
        "tool_f1": round(sum(tool_scores) / count, 4),
        "argument_slot_f1": round(sum(slot_scores) / count, 4),
        "dependency_edge_f1": round(sum(edge_scores) / count, 4),
        "exact_structure_rate": round(exact / count, 4),
        "errors": errors,
    }


def leakage_check(data_dir: Path) -> dict:
    families = {}
    for split in ["train", "dev", "test", "challenge"]:
        families[split] = {row["template_family"] for row in load_jsonl(data_dir / f"{split}.jsonl")}
    overlaps = {}
    keys = list(families)
    for i, left in enumerate(keys):
        for right in keys[i + 1 :]:
            overlaps[f"{left}:{right}"] = sorted(families[left] & families[right])
    return {"families": {key: sorted(value) for key, value in families.items()}, "overlaps": overlaps, "passed": not any(overlaps.values())}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("data/generated"))
    parser.add_argument("--output", type=Path, default=Path("reports/heuristic-baseline.json"))
    args = parser.parse_args()
    result = {
        "test": evaluate_rows(load_jsonl(args.data / "test.jsonl")),
        "challenge": evaluate_rows(load_jsonl(args.data / "challenge.jsonl")),
        "leakage": leakage_check(args.data),
        "review_status": "pending_user_review",
        "model_baselines": "pending_gpu_run",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()


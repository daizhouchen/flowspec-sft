"""Build a machine-readable and Markdown summary from completed FlowSpec experiments."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def metric_row(label: str, metrics: dict[str, Any] | None) -> list[str]:
    if not metrics:
        return [label] + ["—"] * 8
    keys = [
        "schema_valid_rate",
        "dag_valid_rate",
        "sandbox_pass_rate",
        "tool_f1",
        "argument_slot_f1",
        "dependency_edge_f1",
        "semantic_structure_score",
        "mean_latency_ms",
    ]
    values = []
    for key in keys:
        value = metrics.get(key)
        if key == "semantic_structure_score" and value is None:
            parts = [
                metrics.get("tool_f1"),
                metrics.get("argument_slot_f1"),
                metrics.get("dependency_edge_f1"),
            ]
            if all(part is not None for part in parts):
                value = round(sum(float(part) for part in parts) / 3, 4)
        values.append(str(value) if value is not None else "—")
    return [label] + values


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, default=Path("."))
    parser.add_argument(
        "--run-prefix",
        help="Report filename prefix, for example qwen3-1.7b-schema.",
    )
    parser.add_argument(
        "--artifact",
        type=Path,
        help="Adapter artifact directory relative to the project root.",
    )
    parser.add_argument("--output-json", type=Path, default=Path("reports/experiment-summary.json"))
    parser.add_argument("--output-md", type=Path, default=Path("reports/experiment-summary.md"))
    args = parser.parse_args()

    root = args.project.resolve()
    reports = root / "reports"
    schema_prefix = "qwen3-1.7b-schema"
    legacy_prefix = "qwen3-1.7b"
    prefix = args.run_prefix or (
        schema_prefix
        if (reports / f"{schema_prefix}-sft-test-metrics.json").exists()
        else legacy_prefix
    )
    artifact = root / (
        args.artifact
        or Path(
            "artifacts/qwen3-1.7b-qlora-schema"
            if prefix == schema_prefix
            else "artifacts/qwen3-1.7b-qlora-compact"
        )
    )
    heuristic = read_json(reports / "heuristic-baseline.json") or {}
    named_paths = {
        "zero_shot_test": reports / f"{prefix}-zero-shot-test-metrics.json",
        "few_shot_test": reports / f"{prefix}-few-shot-test-metrics.json",
        "sft_test": reports / f"{prefix}-sft-test-metrics.json",
        "sft_challenge": reports / f"{prefix}-sft-challenge-metrics.json",
    }
    metrics = {name: read_json(path) for name, path in named_paths.items()}
    train = read_json(artifact / "train_results.json")
    evaluation = read_json(artifact / "eval_results.json")
    inference = {
        name.removesuffix("_test"): read_json(path.with_name(path.name.replace("-metrics", ".meta")))
        for name, path in named_paths.items()
    }
    gguf = root / "artifacts" / "gguf" / "flowspec-qwen3-1.7b-q4_k_m.gguf"
    quantized = (
        {"path": str(gguf.relative_to(root)), "bytes": gguf.stat().st_size, "sha256": sha256(gguf)}
        if gguf.exists()
        else None
    )

    sft = metrics["sft_test"] or {}
    few = metrics["few_shot_test"] or {}
    sandbox_delta = round(
        float(sft.get("sandbox_pass_rate", 0)) - float(few.get("sandbox_pass_rate", 0)), 4
    )
    semantic_delta = round(
        float(sft.get("semantic_structure_score", 0))
        - float(few.get("semantic_structure_score", 0)),
        4,
    )
    target_checks = {
        "schema_at_least_0_95": float(sft.get("schema_valid_rate", 0)) >= 0.95,
        "dag_at_least_0_90": float(sft.get("dag_valid_rate", 0)) >= 0.90,
        "sandbox_at_least_0_80": float(sft.get("sandbox_pass_rate", 0)) >= 0.80,
        "semantic_gain_vs_few_shot_at_least_0_08": semantic_delta >= 0.08,
    }
    result = {
        "base_model": "Qwen/Qwen3-1.7B",
        "run_prefix": prefix,
        "artifact": str(artifact.relative_to(root)),
        "train": train,
        "eval": evaluation,
        "heuristic": heuristic,
        "metrics": metrics,
        "inference": inference,
        "quantized_model": quantized,
        "sandbox_gain_vs_few_shot": sandbox_delta,
        "semantic_gain_vs_few_shot": semantic_delta,
        "target_checks": target_checks,
        "all_targets_met": all(target_checks.values()),
    }

    output_json = root / args.output_json
    output_md = root / args.output_md
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    rows = [
        metric_row("启发式基线", heuristic.get("test")),
        metric_row("Qwen3-1.7B zero-shot", metrics["zero_shot_test"]),
        metric_row("Qwen3-1.7B few-shot", metrics["few_shot_test"]),
        metric_row("Qwen3-1.7B QLoRA", metrics["sft_test"]),
        metric_row("Qwen3-1.7B QLoRA（挑战集）", metrics["sft_challenge"]),
    ]
    table = [
        "| 方案 | Schema | DAG | 沙箱 | 工具 F1 | 参数 F1 | 依赖边 F1 | 语义结构 | 平均延迟 ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        *("| " + " | ".join(row) + " |" for row in rows),
    ]
    checks = [f"- {'通过' if passed else '未通过'}：`{name}`" for name, passed in target_checks.items()]
    lines = [
        "# FlowSpec 实验汇总",
        "",
        f"实验前缀：`{prefix}`；Adapter：`{artifact.relative_to(root)}`。",
        "",
        *table,
        "",
        "## 验收门槛",
        "",
        *checks,
        "",
        f"SFT 相对 few-shot 的沙箱通过率变化：`{sandbox_delta:+.4f}`。",
        f"SFT 相对 few-shot 的语义结构得分变化：`{semantic_delta:+.4f}`。",
    ]
    if quantized:
        lines.extend(
            [
                "",
                "## CPU 量化模型",
                "",
                f"- 文件：`{quantized['path']}`",
                f"- 大小：`{quantized['bytes']}` bytes",
                f"- SHA-256：`{quantized['sha256']}`",
            ]
        )
    output_md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

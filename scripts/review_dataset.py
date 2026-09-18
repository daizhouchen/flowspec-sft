"""Interactive review for FlowSpec's fixed test and challenge splits."""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("data/generated"))
    parser.add_argument("--split", choices=["test", "challenge"], required=True)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    items = load_jsonl(args.data / f"{args.split}.jsonl")
    decision_path = args.data / "review_decisions.json"
    decisions = json.loads(decision_path.read_text(encoding="utf-8")) if decision_path.exists() else {}
    pending = [item for item in items if item["id"] not in decisions]
    if args.limit:
        pending = pending[: args.limit]
    print(f"待复核 {len(pending)} / 总计 {len(items)}。输入 y 接受、n 拒绝、s 跳过、q 退出。")
    for item in pending:
        print("\n" + "=" * 72)
        print(f"任务：{item['instruction']}")
        print(json.dumps(item["output"], ensure_ascii=False, indent=2))
        while True:
            choice = input("结论 [y/n/s/q]: ").strip().lower()
            if choice in {"y", "n", "s", "q"}:
                break
        if choice == "q":
            break
        if choice == "s":
            continue
        note = input("备注（可空）: ").strip()
        decisions[item["id"]] = {
            "split": args.split,
            "accepted": choice == "y",
            "reviewer": args.reviewer,
            "note": note,
            "reviewed_at": datetime.now(UTC).isoformat(),
        }
        decision_path.write_text(
            json.dumps(decisions, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    accepted = sum(1 for value in decisions.values() if value["accepted"])
    print(f"已保存 {len(decisions)} 条复核结论，其中接受 {accepted} 条。")


if __name__ == "__main__":
    main()

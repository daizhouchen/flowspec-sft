import json
from collections import Counter
from pathlib import Path

from flowspec.tools import TOOL_MAP

DATA = Path(__file__).parents[1] / "data" / "generated"


def read_split(name: str) -> list[dict]:
    return [
        json.loads(line)
        for line in (DATA / f"{name}.jsonl").read_text(encoding="utf-8").splitlines()
        if line
    ]


def test_fixed_split_sizes_and_no_template_family_leakage():
    splits = {name: read_split(name) for name in ("train", "dev", "test", "challenge")}
    assert {name: len(rows) for name, rows in splits.items()} == {
        "train": 1600,
        "dev": 250,
        "test": 250,
        "challenge": 100,
    }
    families = {
        name: {row["template_family"] for row in rows}
        for name, rows in splits.items()
    }
    names = list(families)
    for index, left in enumerate(names):
        for right in names[index + 1 :]:
            assert families[left].isdisjoint(families[right])


def test_training_curriculum_covers_every_registered_tool():
    rows = read_split("train")
    tool_counts = Counter(
        node["tool"] for row in rows for node in row["output"]["nodes"]
    )
    failure_tools = Counter(
        node["on_failure"]["tool"]
        for row in rows
        for node in row["output"]["nodes"]
        if node.get("on_failure")
    )
    covered = set(tool_counts) | set(failure_tools)
    assert covered == set(TOOL_MAP)
    assert len({row["template_family"] for row in rows}) >= 12
    assert min(tool_counts.values()) >= 100


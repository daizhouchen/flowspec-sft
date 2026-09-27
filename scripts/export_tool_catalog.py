"""Export the Python tool registry for the browser, or check its saved freshness."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from flowspec.tools import TOOL_REGISTRY


def build_tool_catalog() -> list[dict[str, Any]]:
    """Keep the complete registry definitions and their declared ordering."""
    return [tool.model_dump(mode="json") for tool in TOOL_REGISTRY]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "web" / "src" / "tool-catalog.json")
    parser.add_argument("--check", action="store_true", help="Check freshness without writing files")
    args = parser.parse_args(argv)
    catalog = build_tool_catalog()
    if args.check:
        try:
            saved = json.loads(args.output.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = None
        if saved != catalog:
            print(
                "Tool catalog is stale, missing, or invalid. "
                "Re-export with python scripts/export_tool_catalog.py before --check "
                "(reuse --output for a custom path).",
                file=sys.stderr,
            )
            return 1
        print(f"Tool catalog is current: {args.output}")
        return 0

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"Exported {len(catalog)} tool definitions to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

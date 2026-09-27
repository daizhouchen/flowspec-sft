import importlib.util
import json
from pathlib import Path

import pytest

from flowspec.tools import TOOL_REGISTRY

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def exporter():
    spec = importlib.util.spec_from_file_location(
        "export_tool_catalog", ROOT / "scripts" / "export_tool_catalog.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_saved_catalog_contains_all_registry_definitions_without_field_loss(exporter):
    saved = json.loads((ROOT / "web" / "src" / "tool-catalog.json").read_text(encoding="utf-8"))
    expected = [tool.model_dump(mode="json") for tool in TOOL_REGISTRY]
    assert len(saved) == 18
    assert len({tool["name"] for tool in saved}) == 18
    assert saved == expected == exporter.build_tool_catalog()
    search = next(tool for tool in saved if tool["name"] == "knowledge.search")
    assert search["description"] == "检索知识库"
    assert search["parameters"]["query"]["required"] is True
    assert search["parameters"]["query"]["type"] == "string"
    assert search["parameters"]["top_k"]["required"] is False
    assert search["parameters"]["top_k"]["type"] == "integer"
    assert {tool["risk"] for tool in saved} == {"read", "compute", "notify", "approval"}


def test_export_is_repeatable_utf8_with_no_volatile_fields(exporter, tmp_path):
    output = tmp_path / "tool-catalog.json"
    assert exporter.main(["--output", str(output)]) == 0
    first = output.read_bytes()
    assert exporter.main(["--output", str(output)]) == 0
    assert output.read_bytes() == first
    assert "检索知识库" in first.decode("utf-8")
    assert b"\r" not in first
    assert first == (
        json.dumps(exporter.build_tool_catalog(), ensure_ascii=False, indent=2) + "\n"
    ).encode("utf-8")


def test_check_rejects_stale_missing_and_invalid_catalog_without_writing(exporter, tmp_path, capsys):
    output = tmp_path / "tool-catalog.json"
    assert exporter.main(["--output", str(output)]) == 0
    original = output.read_bytes()
    assert exporter.main(["--output", str(output), "--check"]) == 0
    assert output.read_bytes() == original

    stale = json.loads(original)
    stale[0]["parameters"]["query"]["required"] = False
    output.write_text(json.dumps(stale, ensure_ascii=False), encoding="utf-8")
    stale_bytes = output.read_bytes()
    assert exporter.main(["--output", str(output), "--check"]) != 0
    assert "Re-export" in capsys.readouterr().err
    assert output.read_bytes() == stale_bytes

    output.write_text("invalid JSON", encoding="utf-8")
    assert exporter.main(["--output", str(output), "--check"]) != 0
    assert output.read_text(encoding="utf-8") == "invalid JSON"

    missing = tmp_path / "missing" / "tool-catalog.json"
    assert exporter.main(["--output", str(missing), "--check"]) != 0
    assert not missing.parent.exists()

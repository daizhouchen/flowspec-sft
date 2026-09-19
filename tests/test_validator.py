from flowspec.validator import repair_workflow, validate_workflow


def valid_workflow():
    return {
        "schema_version": "1.0", "name": "weekly_report", "description": "生成周报",
        "trigger": {"type": "manual"},
        "nodes": [
            {"id": "search", "tool": "knowledge.search", "arguments": {"query": "反馈"}, "depends_on": []},
            {"id": "report", "tool": "report.generate", "arguments": {"input_from": "search"}, "depends_on": ["search"]},
        ],
    }


def test_valid_workflow_has_topological_order():
    _, result = validate_workflow(valid_workflow())
    assert result.valid
    assert result.topological_order == ["search", "report"]


def test_cycle_is_rejected():
    payload = valid_workflow()
    payload["nodes"][0]["depends_on"] = ["report"]
    _, result = validate_workflow(payload)
    assert not result.valid
    assert any(issue.code == "cycle" for issue in result.issues)


def test_unknown_tool_and_missing_argument_are_rejected():
    payload = valid_workflow()
    payload["nodes"][0]["tool"] = "unknown.call"
    payload["nodes"][1]["arguments"] = {}
    _, result = validate_workflow(payload)
    codes = {issue.code for issue in result.issues}
    assert "unknown_tool" in codes
    assert "missing_argument" in codes


def test_dangling_and_self_dependency_are_rejected():
    payload = valid_workflow()
    payload["nodes"][1]["depends_on"] = ["missing", "report"]
    _, result = validate_workflow(payload)
    codes = {issue.code for issue in result.issues}
    assert "dangling_dependency" in codes
    assert "self_dependency" in codes


def test_repair_treats_null_dependencies_as_empty_list():
    payload = valid_workflow()
    payload["nodes"][1]["depends_on"] = None
    repaired, _ = repair_workflow(payload, [])
    assert repaired["nodes"][1]["depends_on"] == []


def test_repair_wraps_flat_node_and_normalizes_fields():
    payload = {
        "schema_version": "1.0",
        "name": "flat_workflow",
        "description": "模型输出了一个扁平节点",
        "id": "This-ID-Is-Much-Too-Long-For-The-Schema-And-Needs-Truncation",
        "tool": "knowledge.search",
        "arguments": {"query": "测试", "top_k": None},
        "depends_on": None,
        "retry": 2,
        "on_failure": "admin.notify",
    }
    repaired, logs = repair_workflow(payload, [])
    workflow, result = validate_workflow(repaired)
    assert result.schema_valid
    assert workflow is not None
    assert len(workflow.nodes[0].id) <= 32
    assert workflow.nodes[0].arguments == {"query": "测试"}
    assert workflow.nodes[0].retry.max_attempts == 2
    assert workflow.nodes[0].on_failure.tool == "admin.notify"
    assert "将扁平节点包装为 WorkflowSpec" in logs

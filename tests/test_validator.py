from flowspec.validator import repair_workflow, validate_workflow


def valid_workflow():
    return {
        "schema_version": "1.0",
        "name": "weekly_report",
        "description": "生成周报",
        "trigger": {"type": "manual"},
        "nodes": [
            {
                "id": "search",
                "tool": "knowledge.search",
                "arguments": {"query": "反馈"},
                "depends_on": [],
            },
            {
                "id": "report",
                "tool": "report.generate",
                "arguments": {"input_from": "search"},
                "depends_on": ["search"],
            },
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


def test_non_upstream_input_is_rejected():
    payload = valid_workflow()
    payload["nodes"].append(
        {
            "id": "parallel",
            "tool": "text.summarize",
            "arguments": {"input_from": "report"},
            "depends_on": ["search"],
        }
    )
    _, result = validate_workflow(payload)
    assert any(issue.code == "non_upstream_input" for issue in result.issues)


def test_dangling_input_is_rejected():
    payload = valid_workflow()
    payload["nodes"][1]["arguments"]["input_from"] = "missing"
    _, result = validate_workflow(payload)
    assert any(issue.code == "dangling_input" for issue in result.issues)


def test_failure_handler_arguments_are_validated():
    payload = valid_workflow()
    payload["nodes"][0]["on_failure"] = {
        "tool": "admin.notify",
        "arguments": {},
    }
    _, result = validate_workflow(payload)
    assert any(issue.code == "missing_failure_argument" for issue in result.issues)


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


def test_repair_normalizes_model_argument_aliases_and_trigger_node():
    payload = {
        "schema_version": "1.0",
        "name": "model_output",
        "description": "模型参数使用了常见别名",
        "trigger": {"type": "manual"},
        "nodes": [
            {
                "id": "collect",
                "tool": "feedback.search",
                "arguments": {"query": "客户反馈"},
                "depends_on": [],
            },
            {
                "id": "analyze",
                "tool": "text.analyze",
                "arguments": {"input": "collect"},
                "depends_on": ["collect"],
            },
            {
                "id": "send",
                "tool": "message.send",
                "arguments": {"input": "analyze", "recipient": "产品群"},
                "depends_on": ["analyze"],
                "requires_approval": True,
            },
            {
                "id": "trigger",
                "tool": "manual",
                "arguments": {},
                "depends_on": ["send"],
            },
        ],
    }
    repaired, logs = repair_workflow(payload, [])
    workflow, result = validate_workflow(repaired)
    assert result.valid
    assert workflow is not None
    assert [node.tool for node in workflow.nodes] == [
        "feedback.search",
        "sentiment.analyze",
        "message.send",
    ]
    assert workflow.nodes[0].arguments["date_range"] == "latest"
    assert workflow.nodes[1].arguments["input_from"] == "collect"
    assert workflow.nodes[2].arguments["channel"] == "产品群"
    assert any("规范化工具名称" in item for item in logs)
    assert any("移除误作为节点输出的触发器" in item for item in logs)


def test_repair_removes_unknown_tool_arguments():
    payload = valid_workflow()
    payload["nodes"][0]["arguments"]["recipient"] = "不属于检索工具"
    repaired, logs = repair_workflow(payload, [])
    assert repaired["nodes"][0]["arguments"] == {"query": "反馈"}
    assert any("未知参数" in item for item in logs)


def test_repair_adds_failure_notification_message():
    payload = valid_workflow()
    payload["nodes"][0]["on_failure"] = "admin.notify"
    repaired, logs = repair_workflow(payload, [])
    assert repaired["nodes"][0]["on_failure"]["arguments"]["message"]
    assert any("失败通知内容" in item for item in logs)

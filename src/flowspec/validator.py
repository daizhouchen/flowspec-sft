from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

from pydantic import ValidationError

from .schema import ValidationIssue, ValidationResult, WorkflowSpec
from .tools import TOOL_MAP

TOOL_ALIASES = {
    "text.analyze": "sentiment.analyze",
    "sentiment.classify": "sentiment.analyze",
    "notification.send": "message.send",
}

ARGUMENT_ALIASES = {
    "input_from": ["input", "source", "source_node", "from"],
    "channel": ["recipient", "target", "group"],
    "recipient": ["email", "target", "channel"],
    "message": ["content", "reason", "input"],
    "date_range": ["period", "range", "time_range"],
    "query": ["keyword", "topic"],
    "record_type": ["type", "entity"],
    "target_language": ["language", "target_lang"],
    "chart_type": ["type", "format"],
    "format": ["output_format", "file_type"],
}


def _safe_node_id(value: Any, fallback: str, used: set[str]) -> str:
    candidate = "".join(
        char if (char.isascii() and char.isalnum()) or char == "_" else "_"
        for char in str(value).lower()
    )
    candidate = candidate.strip("_")
    if not candidate or not candidate[0].isalpha():
        candidate = fallback
    candidate = candidate[:32]
    base = candidate
    suffix = 2
    while candidate in used:
        tail = f"_{suffix}"
        candidate = f"{base[: 32 - len(tail)]}{tail}"
        suffix += 1
    used.add(candidate)
    return candidate


def _normalize_failure_handler(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict) and value.get("tool"):
        return value
    if isinstance(value, str) and value in TOOL_MAP:
        return {"tool": value, "arguments": {}}
    return None


def _normalize_arguments(node: dict[str, Any], logs: list[str]) -> None:
    tool = TOOL_MAP.get(node.get("tool"))
    if not tool:
        return
    arguments = node["arguments"]
    for name, parameter in tool.parameters.items():
        if name in arguments or not parameter.required:
            continue
        for alias in ARGUMENT_ALIASES.get(name, []):
            if alias in arguments:
                arguments[name] = arguments.pop(alias)
                logs.append(f"规范化 {node.get('id')} 的参数：{alias} → {name}")
                break
        if name in arguments:
            continue
        if name == "input_from" and node.get("depends_on"):
            arguments[name] = node["depends_on"][-1]
            logs.append(f"根据依赖补充 {node.get('id')} 的 input_from")
        elif name == "date_range":
            arguments[name] = "latest"
            logs.append(f"补充 {node.get('id')} 的默认 date_range")
        elif name == "message" and node.get("tool") == "admin.notify":
            arguments[name] = "workflow failed"
            logs.append(f"补充 {node.get('id')} 的失败通知内容")
        elif name == "chart_type":
            arguments[name] = "bar"
            logs.append(f"补充 {node.get('id')} 的默认 chart_type")
    unknown = sorted(set(arguments) - set(tool.parameters))
    for name in unknown:
        arguments.pop(name)
        logs.append(f"移除 {node.get('id')} 的未知参数：{name}")


def validate_workflow(
    payload: dict[str, Any] | WorkflowSpec,
) -> tuple[WorkflowSpec | None, ValidationResult]:
    issues: list[ValidationIssue] = []
    try:
        workflow = (
            payload if isinstance(payload, WorkflowSpec) else WorkflowSpec.model_validate(payload)
        )
    except ValidationError as error:
        for item in error.errors():
            issues.append(ValidationIssue(code="schema_error", level="error", message=item["msg"]))
        return None, ValidationResult(
            valid=False, schema_valid=False, dag_valid=False, issues=issues
        )

    ids = {node.id for node in workflow.nodes}
    adjacency: dict[str, list[str]] = defaultdict(list)
    indegree = {node.id: 0 for node in workflow.nodes}
    for node in workflow.nodes:
        tool = TOOL_MAP.get(node.tool)
        if not tool:
            issues.append(
                ValidationIssue(
                    code="unknown_tool",
                    level="error",
                    message=f"未知工具：{node.tool}",
                    node_id=node.id,
                )
            )
        else:
            for name, parameter in tool.parameters.items():
                if parameter.required and name not in node.arguments:
                    issues.append(
                        ValidationIssue(
                            code="missing_argument",
                            level="error",
                            message=f"缺少必填参数：{name}",
                            node_id=node.id,
                        )
                    )
            for name in sorted(set(node.arguments) - set(tool.parameters)):
                issues.append(
                    ValidationIssue(
                        code="unknown_argument",
                        level="error",
                        message=f"工具不接受参数：{name}",
                        node_id=node.id,
                    )
                )
            if tool.risk == "notify" and not node.requires_approval:
                issues.append(
                    ValidationIssue(
                        code="approval_recommended",
                        level="warning",
                        message="通知类操作建议显式确认",
                        node_id=node.id,
                    )
                )
        for dependency in node.depends_on:
            if dependency not in ids:
                issues.append(
                    ValidationIssue(
                        code="dangling_dependency",
                        level="error",
                        message=f"依赖节点不存在：{dependency}",
                        node_id=node.id,
                    )
                )
                continue
            adjacency[dependency].append(node.id)
            indegree[node.id] += 1
        if node.id in node.depends_on:
            issues.append(
                ValidationIssue(
                    code="self_dependency",
                    level="error",
                    message="节点不能依赖自身",
                    node_id=node.id,
                )
            )
        if node.when and not node.depends_on:
            issues.append(
                ValidationIssue(
                    code="condition_without_source",
                    level="error",
                    message="条件节点必须依赖上游节点",
                    node_id=node.id,
                )
            )
        if node.on_failure:
            failure_tool = TOOL_MAP.get(node.on_failure.tool)
            if not failure_tool:
                issues.append(
                    ValidationIssue(
                        code="unknown_failure_tool",
                        level="error",
                        message=f"未知失败处理工具：{node.on_failure.tool}",
                        node_id=node.id,
                    )
                )
            else:
                for name, parameter in failure_tool.parameters.items():
                    if parameter.required and name not in node.on_failure.arguments:
                        issues.append(
                            ValidationIssue(
                                code="missing_failure_argument",
                                level="error",
                                message=f"失败处理缺少必填参数：{name}",
                                node_id=node.id,
                            )
                        )
                for name in sorted(set(node.on_failure.arguments) - set(failure_tool.parameters)):
                    issues.append(
                        ValidationIssue(
                            code="unknown_failure_argument",
                            level="error",
                            message=f"失败处理工具不接受参数：{name}",
                            node_id=node.id,
                        )
                    )

    queue = deque(sorted(node_id for node_id, degree in indegree.items() if degree == 0))
    order: list[str] = []
    while queue:
        current = queue.popleft()
        order.append(current)
        for nxt in adjacency[current]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                queue.append(nxt)
    dag_valid = len(order) == len(workflow.nodes)
    if not dag_valid:
        issues.append(ValidationIssue(code="cycle", level="error", message="工作流存在循环依赖"))

    if dag_valid:
        descendants: dict[str, set[str]] = {}
        for source in ids:
            seen: set[str] = set()
            pending_descendants = list(adjacency[source])
            while pending_descendants:
                current = pending_descendants.pop()
                if current in seen:
                    continue
                seen.add(current)
                pending_descendants.extend(adjacency[current])
            descendants[source] = seen
        for node in workflow.nodes:
            input_from = node.arguments.get("input_from")
            if not isinstance(input_from, str):
                continue
            if input_from not in ids:
                issues.append(
                    ValidationIssue(
                        code="dangling_input",
                        level="error",
                        message=f"输入节点不存在：{input_from}",
                        node_id=node.id,
                    )
                )
            elif node.id not in descendants[input_from]:
                issues.append(
                    ValidationIssue(
                        code="non_upstream_input",
                        level="error",
                        message=f"输入节点不是当前节点的上游：{input_from}",
                        node_id=node.id,
                    )
                )

    roots = [node.id for node in workflow.nodes if not node.depends_on]
    reachable = set(roots)
    pending = list(roots)
    while pending:
        for nxt in adjacency[pending.pop()]:
            if nxt not in reachable:
                reachable.add(nxt)
                pending.append(nxt)
    for node_id in ids - reachable:
        issues.append(
            ValidationIssue(
                code="unreachable_node",
                level="error",
                message="节点不可从入口到达",
                node_id=node_id,
            )
        )

    has_error = any(issue.level == "error" for issue in issues)
    return workflow, ValidationResult(
        valid=not has_error,
        schema_valid=True,
        dag_valid=dag_valid,
        issues=issues,
        topological_order=order if dag_valid else [],
    )


def repair_workflow(
    payload: dict[str, Any], issues: list[ValidationIssue]
) -> tuple[dict[str, Any], list[str]]:
    repaired = dict(payload)
    logs: list[str] = []
    if not isinstance(repaired.get("nodes"), list) and repaired.get("id") and repaired.get("tool"):
        flat_node_keys = {
            "id",
            "tool",
            "arguments",
            "depends_on",
            "when",
            "requires_approval",
            "retry",
            "on_failure",
        }
        flat_node = {key: repaired.get(key) for key in flat_node_keys if key in repaired}
        repaired = {
            "schema_version": repaired.get("schema_version", "1.0"),
            "name": repaired.get("name") or repaired.get("id") or "generated_workflow",
            "description": repaired.get("description") or "模型生成的工作流",
            "trigger": repaired.get("trigger")
            if isinstance(repaired.get("trigger"), dict)
            else {"type": "manual"},
            "nodes": [flat_node],
        }
        logs.append("将扁平节点包装为 WorkflowSpec")
    if "schema_version" not in repaired:
        repaired["schema_version"] = "1.0"
        logs.append("补充 schema_version=1.0")
    nodes = [dict(node) for node in repaired.get("nodes", []) if isinstance(node, dict)]
    referenced = {
        dependency
        for node in nodes
        for dependency in (
            node.get("depends_on", []) if isinstance(node.get("depends_on"), list) else []
        )
    }
    filtered_nodes = []
    for node in nodes:
        if node.get("tool") == "manual" and node.get("id") not in referenced:
            logs.append(f"移除误作为节点输出的触发器：{node.get('id')}")
            continue
        tool = TOOL_ALIASES.get(node.get("tool"), node.get("tool"))
        if tool != node.get("tool"):
            logs.append(f"规范化工具名称：{node.get('tool')} → {tool}")
            node["tool"] = tool
        filtered_nodes.append(node)
    nodes = filtered_nodes
    used_ids: set[str] = set()
    id_map: dict[Any, str] = {}
    for index, node in enumerate(nodes, start=1):
        old_id = node.get("id")
        new_id = _safe_node_id(old_id, f"step_{index}", used_ids)
        id_map[old_id] = new_id
        if old_id != new_id:
            logs.append(f"规范化节点 ID：{old_id} → {new_id}")
        node["id"] = new_id
    valid_ids = set(id_map.values())
    for node in nodes:
        arguments = node.get("arguments")
        node["arguments"] = (
            {key: value for key, value in arguments.items() if value is not None}
            if isinstance(arguments, dict)
            else {}
        )
        raw_dependencies = node.get("depends_on")
        before = list(raw_dependencies) if isinstance(raw_dependencies, list) else []
        mapped_dependencies = [id_map.get(dependency, dependency) for dependency in before]
        node["depends_on"] = [
            dependency
            for dependency in mapped_dependencies
            if dependency in valid_ids and dependency != node.get("id")
        ]
        if before != node["depends_on"]:
            logs.append(f"移除 {node.get('id')} 的悬空或自引用依赖")
        retry = node.get("retry")
        if isinstance(retry, int):
            node["retry"] = {"max_attempts": min(max(retry, 0), 3), "backoff_seconds": 0}
            logs.append(f"规范化 {node.get('id')} 的重试策略")
        elif not isinstance(retry, dict):
            node["retry"] = {"max_attempts": 0, "backoff_seconds": 0}
        failure_handler = _normalize_failure_handler(node.get("on_failure"))
        if node.get("on_failure") != failure_handler:
            logs.append(f"规范化 {node.get('id')} 的失败处理")
        if (
            failure_handler
            and failure_handler.get("tool") == "admin.notify"
            and not failure_handler.get("arguments", {}).get("message")
        ):
            failure_handler.setdefault("arguments", {})["message"] = "workflow failed"
            logs.append(f"补充 {node.get('id')} 的失败通知内容")
        node["on_failure"] = failure_handler
        _normalize_arguments(node, logs)
    repaired["nodes"] = nodes
    return repaired, logs

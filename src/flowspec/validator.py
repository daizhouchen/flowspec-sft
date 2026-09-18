from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

from pydantic import ValidationError

from .schema import ValidationIssue, ValidationResult, WorkflowSpec
from .tools import TOOL_MAP


def validate_workflow(payload: dict[str, Any] | WorkflowSpec) -> tuple[WorkflowSpec | None, ValidationResult]:
    issues: list[ValidationIssue] = []
    try:
        workflow = payload if isinstance(payload, WorkflowSpec) else WorkflowSpec.model_validate(payload)
    except ValidationError as error:
        for item in error.errors():
            issues.append(ValidationIssue(code="schema_error", level="error", message=item["msg"]))
        return None, ValidationResult(valid=False, schema_valid=False, dag_valid=False, issues=issues)

    ids = {node.id for node in workflow.nodes}
    adjacency: dict[str, list[str]] = defaultdict(list)
    indegree = {node.id: 0 for node in workflow.nodes}
    for node in workflow.nodes:
        tool = TOOL_MAP.get(node.tool)
        if not tool:
            issues.append(ValidationIssue(code="unknown_tool", level="error", message=f"未知工具：{node.tool}", node_id=node.id))
        else:
            for name, parameter in tool.parameters.items():
                if parameter.required and name not in node.arguments:
                    issues.append(ValidationIssue(code="missing_argument", level="error", message=f"缺少必填参数：{name}", node_id=node.id))
            if tool.risk == "notify" and not node.requires_approval:
                issues.append(ValidationIssue(code="approval_recommended", level="warning", message="通知类操作建议显式确认", node_id=node.id))
        for dependency in node.depends_on:
            if dependency not in ids:
                issues.append(ValidationIssue(code="dangling_dependency", level="error", message=f"依赖节点不存在：{dependency}", node_id=node.id))
                continue
            adjacency[dependency].append(node.id)
            indegree[node.id] += 1
        if node.id in node.depends_on:
            issues.append(ValidationIssue(code="self_dependency", level="error", message="节点不能依赖自身", node_id=node.id))
        if node.when and not node.depends_on:
            issues.append(ValidationIssue(code="condition_without_source", level="error", message="条件节点必须依赖上游节点", node_id=node.id))

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

    roots = [node.id for node in workflow.nodes if not node.depends_on]
    reachable = set(roots)
    pending = list(roots)
    while pending:
        for nxt in adjacency[pending.pop()]:
            if nxt not in reachable:
                reachable.add(nxt)
                pending.append(nxt)
    for node_id in ids - reachable:
        issues.append(ValidationIssue(code="unreachable_node", level="error", message="节点不可从入口到达", node_id=node_id))

    has_error = any(issue.level == "error" for issue in issues)
    return workflow, ValidationResult(
        valid=not has_error,
        schema_valid=True,
        dag_valid=dag_valid,
        issues=issues,
        topological_order=order if dag_valid else [],
    )


def repair_workflow(payload: dict[str, Any], issues: list[ValidationIssue]) -> tuple[dict[str, Any], list[str]]:
    repaired = dict(payload)
    logs: list[str] = []
    if "schema_version" not in repaired:
        repaired["schema_version"] = "1.0"
        logs.append("补充 schema_version=1.0")
    nodes = [dict(node) for node in repaired.get("nodes", []) if isinstance(node, dict)]
    valid_ids = {node.get("id") for node in nodes}
    for node in nodes:
        before = list(node.get("depends_on", []))
        node["depends_on"] = [dep for dep in before if dep in valid_ids and dep != node.get("id")]
        if before != node["depends_on"]:
            logs.append(f"移除 {node.get('id')} 的悬空或自引用依赖")
    repaired["nodes"] = nodes
    return repaired, logs


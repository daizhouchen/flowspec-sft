from __future__ import annotations

import re
import time
import uuid

from .schema import CompileRequest, CompileResponse, RetryPolicy, WorkflowNode, WorkflowSpec
from .validator import repair_workflow, validate_workflow


def _slug(text: str) -> str:
    mapping = {"反馈": "feedback", "周报": "weekly_report", "知识": "knowledge", "风险": "risk", "翻译": "translation"}
    for key, value in mapping.items():
        if key in text:
            return value
    return "generated_workflow"


class HeuristicCompiler:
    name = "heuristic-v1"

    def compile(self, instruction: str) -> dict:
        nodes: list[WorkflowNode] = []
        if "反馈" in instruction:
            nodes.append(WorkflowNode(id="collect", tool="feedback.search", arguments={"date_range": "last_week"}))
        else:
            nodes.append(WorkflowNode(id="search", tool="knowledge.search", arguments={"query": instruction, "top_k": 8}))
        source = nodes[-1].id
        if "分类" in instruction or "模块" in instruction:
            nodes.append(WorkflowNode(id="classify", tool="text.classify", arguments={"labels": ["产品", "服务", "其他"], "input_from": source}, depends_on=[source]))
            source = "classify"
        if "风险" in instruction:
            nodes.append(WorkflowNode(id="risk", tool="risk.classify", arguments={"input_from": source, "threshold": "high"}, depends_on=[source]))
            source = "risk"
        if "确认" in instruction or "审批" in instruction:
            nodes.append(WorkflowNode(id="approve", tool="human.approval", arguments={"input_from": source, "assignee": "owner"}, depends_on=[source], when="risk == high" if "风险" in instruction else None, requires_approval=True))
            approval = "approve"
        else:
            approval = None
        if "周报" in instruction or "报告" in instruction:
            dependencies = [source] + ([approval] if approval else [])
            nodes.append(WorkflowNode(id="report", tool="report.generate", arguments={"input_from": source, "template": "weekly"}, depends_on=dependencies))
            source = "report"
        if "发" in instruction or "通知" in instruction:
            tool = "email.send" if "邮件" in instruction else "message.send"
            arguments = {"input_from": source, "recipient": "team@example.com"} if tool == "email.send" else {"input_from": source, "channel": "product-team"}
            nodes.append(WorkflowNode(id="send", tool=tool, arguments=arguments, depends_on=[source], requires_approval=True))
        retry_match = re.search(r"重试([一二两三\d]+)次", instruction)
        retry_count = 2 if retry_match else 0
        if retry_count:
            for node in nodes:
                node.retry = RetryPolicy(max_attempts=retry_count, backoff_seconds=2)
        return WorkflowSpec(
            name=_slug(instruction),
            description=instruction[:300],
            nodes=nodes,
        ).model_dump()


def compile_request(request: CompileRequest, compiler=None) -> CompileResponse:
    started = time.perf_counter()
    compiler = compiler or HeuristicCompiler()
    raw = compiler.compile(request.instruction)
    workflow, validation = validate_workflow(raw)
    repair_log: list[str] = []
    if not validation.valid and request.repair_once:
        repaired, repair_log = repair_workflow(raw, validation.issues)
        workflow, validation = validate_workflow(repaired)
        raw = repaired
    return CompileResponse(
        request_id=str(uuid.uuid4()),
        elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
        raw_output=raw,
        workflow=workflow if validation.valid else None,
        validation=validation,
        repair_log=repair_log,
        compiler=compiler.name,
        error_type=None if validation.valid else "validation_failed",
    )


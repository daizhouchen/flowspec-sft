from __future__ import annotations

import time
import uuid

from .schema import SimulateResponse, TraceStep, WorkflowSpec
from .tools import TOOL_MAP
from .validator import validate_workflow


def simulate(workflow: WorkflowSpec, approve_human_steps: bool = True) -> SimulateResponse:
    started = time.perf_counter()
    _, validation = validate_workflow(workflow)
    if not validation.valid:
        return SimulateResponse(request_id=str(uuid.uuid4()), elapsed_ms=0, status="failed", trace=[])
    nodes = {node.id: node for node in workflow.nodes}
    trace: list[TraceStep] = []
    for node_id in validation.topological_order:
        node = nodes[node_id]
        tool = TOOL_MAP[node.tool]
        if tool.category == "approval" and not approve_human_steps:
            trace.append(TraceStep(node_id=node.id, tool=node.tool, status="waiting_approval", message="等待人工确认"))
            return SimulateResponse(request_id=str(uuid.uuid4()), elapsed_ms=round((time.perf_counter() - started) * 1000, 2), status="waiting_approval", trace=trace)
        trace.append(TraceStep(node_id=node.id, tool=node.tool, status="succeeded", message="沙箱模拟完成；未执行真实外部操作"))
    return SimulateResponse(request_id=str(uuid.uuid4()), elapsed_ms=round((time.perf_counter() - started) * 1000, 2), status="completed", trace=trace)


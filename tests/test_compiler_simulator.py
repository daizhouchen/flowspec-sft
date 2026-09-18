from flowspec.compiler import compile_request
from flowspec.schema import CompileRequest
from flowspec.simulator import simulate


def test_compile_business_instruction():
    result = compile_request(CompileRequest(instruction="汇总上周客户反馈，分类并生成周报，确认后发到产品群。"))
    assert result.validation.valid
    assert result.workflow is not None
    assert {node.tool for node in result.workflow.nodes} >= {"feedback.search", "text.classify", "report.generate", "message.send"}


def test_simulator_stops_for_approval():
    result = compile_request(CompileRequest(instruction="搜索知识，确认后发到产品群。"))
    simulation = simulate(result.workflow, approve_human_steps=False)
    assert simulation.status == "waiting_approval"
    assert simulation.trace[-1].status == "waiting_approval"


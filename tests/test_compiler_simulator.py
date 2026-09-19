from flowspec.compiler import compile_request
from flowspec.schema import CompileRequest
from flowspec.simulator import simulate


def test_compile_business_instruction():
    result = compile_request(
        CompileRequest(instruction="汇总上周客户反馈，分类并生成周报，确认后发到产品群。")
    )
    assert result.validation.valid
    assert result.workflow is not None
    assert {node.tool for node in result.workflow.nodes} >= {
        "feedback.search",
        "text.classify",
        "report.generate",
        "message.send",
    }


def test_simulator_stops_for_approval():
    result = compile_request(CompileRequest(instruction="搜索知识，确认后发到产品群。"))
    simulation = simulate(result.workflow, approve_human_steps=False)
    assert simulation.status == "waiting_approval"
    assert simulation.trace[-1].status == "waiting_approval"


def test_model_compiler_gets_only_one_semantic_repair():
    class RepairingCompiler:
        name = "test-model"

        def __init__(self):
            self.repair_calls = 0

        def compile(self, _instruction):
            return {
                "schema_version": "1.0",
                "name": "broken",
                "description": "missing required arguments",
                "trigger": {"type": "manual"},
                "nodes": [
                    {
                        "id": "send",
                        "tool": "message.send",
                        "arguments": {},
                        "depends_on": [],
                        "requires_approval": True,
                        "retry": {"max_attempts": 0, "backoff_seconds": 0},
                    }
                ],
            }

        def repair(self, _instruction, payload, _issues):
            self.repair_calls += 1
            payload["nodes"] = [
                {
                    "id": "search",
                    "tool": "knowledge.search",
                    "arguments": {"query": "消息内容"},
                    "depends_on": [],
                },
                {
                    "id": "send",
                    "tool": "message.send",
                    "arguments": {
                        "input_from": "search",
                        "channel": "product-team",
                    },
                    "depends_on": ["search"],
                    "requires_approval": True,
                },
            ]
            return payload

    compiler = RepairingCompiler()
    response = compile_request(
        CompileRequest(instruction="发送消息", repair_once=True), compiler=compiler
    )
    assert compiler.repair_calls == 1
    assert response.validation.valid
    assert response.workflow is not None
    assert "模型根据校验错误完成一次语义修复" in response.repair_log

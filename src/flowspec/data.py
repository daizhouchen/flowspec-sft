from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from .schema import RetryPolicy, Trigger, WorkflowNode, WorkflowSpec
from .validator import validate_workflow

DOMAINS = ["客户反馈", "产品缺陷", "合同记录", "用户研究", "市场情报", "知识库"]
CHANNELS = ["产品群", "项目群", "管理群", "研究群"]


def wording(index: int, options: list[str]) -> str:
    """Select deterministic paraphrases without changing workflow semantics."""
    return options[(index // len(DOMAINS)) % len(options)]


def node(id_: str, tool: str, args: dict, deps=None, **kwargs) -> WorkflowNode:
    return WorkflowNode(id=id_, tool=tool, arguments=args, depends_on=deps or [], **kwargs)


def build(family: str, index: int) -> tuple[str, WorkflowSpec]:
    domain = DOMAINS[index % len(DOMAINS)]
    channel = CHANNELS[index % len(CHANNELS)]
    suffix = f"case_{index:04d}"
    trigger = Trigger(type="cron", expression="0 9 * * 1") if index % 3 == 0 else Trigger()
    retry = RetryPolicy(max_attempts=2, backoff_seconds=2) if index % 4 == 0 else RetryPolicy()

    if family == "collect_classify_report":
        prompt = wording(
            index,
            [
                f"汇总最近一周的{domain}，按模块分类后生成周报，任务编号{index}。",
                f"拉取{domain}近一周反馈，完成分类并整理为周报，编号{index}。",
                f"查找过去七天的{domain}反馈，分类后输出周报，编号{index}。",
                f"把上周{domain}反馈按类别归纳成报告，任务{index}。",
            ],
        )
        nodes = [
            node(
                "collect",
                "feedback.search",
                {"date_range": "last_week", "product": domain},
                retry=retry,
            ),
            node(
                "classify",
                "text.classify",
                {"labels": ["体验", "性能", "功能"], "input_from": "collect"},
                ["collect"],
            ),
            node(
                "report",
                "report.generate",
                {"input_from": "classify", "template": "weekly"},
                ["classify"],
            ),
        ]
    elif family == "search_summarize_notify":
        prompt = wording(
            index,
            [
                f"搜索{domain}资料并压缩成200字摘要，确认后发到{channel}，编号{index}。",
                f"检索{domain}，生成不超过200字的摘要；人工确认后通知{channel}，编号{index}。",
                f"从知识库查找{domain}并做200字简报，经确认发至{channel}，任务{index}。",
                f"整理{domain}检索结果为200字摘要，审批后同步到{channel}，编号{index}。",
            ],
        )
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 8}),
            node(
                "summary", "text.summarize", {"input_from": "search", "max_words": 200}, ["search"]
            ),
            node(
                "approve",
                "human.approval",
                {"input_from": "summary", "assignee": "owner"},
                ["summary"],
                requires_approval=True,
            ),
            node(
                "send",
                "message.send",
                {"input_from": "summary", "channel": channel},
                ["approve"],
                requires_approval=True,
            ),
        ]
    elif family == "aggregate_chart_email":
        prompt = wording(
            index,
            [
                f"查询{domain}记录，按负责人聚合并画柱状图，然后邮件发送，编号{index}。",
                f"读取{domain}业务记录，按负责人汇总成柱状图并邮件发送，任务{index}。",
                f"查找{domain}记录并按负责人统计，绘制柱状图后发邮件，编号{index}。",
                f"将{domain}记录按 owner 聚合，生成柱状图并通过邮件通知，任务{index}。",
            ],
        )
        nodes = [
            node(
                "lookup", "records.lookup", {"record_type": domain, "filter": {"period": "month"}}
            ),
            node(
                "aggregate",
                "data.aggregate",
                {"input_from": "lookup", "group_by": "owner"},
                ["lookup"],
            ),
            node(
                "chart",
                "chart.render",
                {"input_from": "aggregate", "chart_type": "bar"},
                ["aggregate"],
            ),
            node(
                "email",
                "email.send",
                {"input_from": "chart", "recipient": "team@example.com"},
                ["chart"],
                requires_approval=True,
            ),
        ]
    elif family == "risk_approval_report":
        prompt = wording(
            index,
            [
                f"检索{domain}并识别高风险项，高风险先审批，再生成报告；失败重试两次，编号{index}。",
                f"查找{domain}资料并做风险分级，高风险经负责人审批后出报告，失败最多重试两次，任务{index}。",
                f"对{domain}检索结果识别高风险内容，审批通过后生成风险报告，允许重试两次，编号{index}。",
                f"搜索{domain}、判断风险，高风险先交负责人确认再形成报告；失败重试两次，任务{index}。",
            ],
        )
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 10}, retry=retry),
            node(
                "risk",
                "risk.classify",
                {"input_from": "search", "threshold": "high"},
                ["search"],
                retry=retry,
            ),
            node(
                "approve",
                "manager.approval",
                {"input_from": "risk", "role": "product_owner"},
                ["risk"],
                when="risk == high",
                requires_approval=True,
            ),
            node(
                "report",
                "report.generate",
                {"input_from": "risk", "template": "risk"},
                ["risk", "approve"],
            ),
        ]
    elif family == "sentiment_digest":
        prompt = wording(
            index,
            [
                f"检索近一月{domain}反馈，分析情感并生成150字摘要，编号{index}。",
                f"拉取{domain}最近一个月的反馈，做情感分析后压缩为150字，任务{index}。",
                f"查找上月{domain}反馈并判断情绪倾向，最后输出150字摘要，编号{index}。",
            ],
        )
        nodes = [
            node("feedback", "feedback.search", {"date_range": "last_month", "product": domain}),
            node("sentiment", "sentiment.analyze", {"input_from": "feedback"}, ["feedback"]),
            node(
                "summary",
                "text.summarize",
                {"input_from": "sentiment", "max_words": 150},
                ["sentiment"],
            ),
        ]
    elif family == "feedback_risk_escalate":
        prompt = wording(
            index,
            [
                f"读取本周{domain}反馈并识别风险，高风险时请人工确认，编号{index}。",
                f"检索{domain}近一周反馈，做高风险判断；命中后交风险负责人确认，任务{index}。",
                f"查找过去七天的{domain}反馈，风险达到高等级时发起人工确认，编号{index}。",
            ],
        )
        nodes = [
            node("feedback", "feedback.search", {"date_range": "last_week", "product": domain}),
            node(
                "risk",
                "risk.classify",
                {"input_from": "feedback", "threshold": "high"},
                ["feedback"],
            ),
            node(
                "confirm",
                "human.approval",
                {"input_from": "risk", "assignee": "risk_owner"},
                ["risk"],
                when="risk == high",
                requires_approval=True,
            ),
        ]
    elif family == "parallel_classify_translate":
        prompt = wording(
            index,
            [
                f"检索{domain}资料，同时完成分类和英文翻译，再生成报告，编号{index}。",
                f"查找{domain}内容，并行做主题分类与英译，汇总成报告，任务{index}。",
                f"从知识库读取{domain}，分别分类、翻译成英文，然后输出报告，编号{index}。",
            ],
        )
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 7}),
            node(
                "classify",
                "text.classify",
                {"labels": ["产品", "市场"], "input_from": "search"},
                ["search"],
            ),
            node(
                "translate",
                "content.translate",
                {"input_from": "search", "target_language": "en"},
                ["search"],
            ),
            node(
                "report",
                "report.generate",
                {"input_from": "translate", "template": "brief"},
                ["classify", "translate"],
            ),
        ]
    elif family == "lookup_legal_notify":
        prompt = wording(
            index,
            [
                f"查询有效的{domain}记录，交法务审核后通知{channel}，编号{index}。",
                f"读取{domain}有效记录，法务复核通过后同步到{channel}，任务{index}。",
                f"查找状态有效的{domain}业务记录，经法务审核后发到{channel}，编号{index}。",
            ],
        )
        nodes = [
            node(
                "lookup", "records.lookup", {"record_type": domain, "filter": {"status": "active"}}
            ),
            node(
                "legal",
                "legal.review",
                {"input_from": "lookup"},
                ["lookup"],
                requires_approval=True,
            ),
            node(
                "send",
                "message.send",
                {"input_from": "lookup", "channel": channel},
                ["legal"],
                requires_approval=True,
            ),
        ]
    elif family == "aggregate_report_export":
        prompt = wording(
            index,
            [
                f"查询{domain}记录，按负责人聚合，生成报告并导出PDF，编号{index}。",
                f"读取{domain}业务记录并按 owner 汇总，形成报告后导出 PDF，任务{index}。",
                f"查找{domain}记录，按负责人统计并输出PDF报告，编号{index}。",
            ],
        )
        nodes = [
            node(
                "lookup", "records.lookup", {"record_type": domain, "filter": {"period": "month"}}
            ),
            node(
                "aggregate",
                "data.aggregate",
                {"input_from": "lookup", "group_by": "owner"},
                ["lookup"],
            ),
            node(
                "report",
                "report.generate",
                {"input_from": "aggregate", "template": "monthly"},
                ["aggregate"],
            ),
            node(
                "export", "document.export", {"input_from": "report", "format": "pdf"}, ["report"]
            ),
        ]
    elif family == "translate_summary_email":
        prompt = wording(
            index,
            [
                f"检索{domain}资料，翻译为英文并生成100字摘要，再邮件发送，编号{index}。",
                f"查找{domain}，完成英文翻译和100字摘要后发邮件，任务{index}。",
                f"从知识库读取{domain}内容，译成英文、压缩为100字并邮件通知，编号{index}。",
            ],
        )
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 6}),
            node(
                "translate",
                "content.translate",
                {"input_from": "search", "target_language": "en"},
                ["search"],
            ),
            node(
                "summary",
                "text.summarize",
                {"input_from": "translate", "max_words": 100},
                ["translate"],
            ),
            node(
                "email",
                "email.send",
                {"input_from": "summary", "recipient": "team@example.com"},
                ["summary"],
                requires_approval=True,
            ),
        ]
    elif family == "approval_notify":
        prompt = wording(
            index,
            [
                f"检索{domain}资料，交负责人审批后通知{channel}，编号{index}。",
                f"查找{domain}内容，经产品负责人确认后同步到{channel}，任务{index}。",
                f"从知识库读取{domain}，审批通过后发送至{channel}，编号{index}。",
            ],
        )
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 5}),
            node(
                "approve",
                "manager.approval",
                {"input_from": "search", "role": "product_owner"},
                ["search"],
                requires_approval=True,
            ),
            node(
                "send",
                "message.send",
                {"input_from": "search", "channel": channel},
                ["approve"],
                requires_approval=True,
            ),
        ]
    elif family == "failure_handling_search":
        prompt = wording(
            index,
            [
                f"检索{domain}并生成摘要；检索失败时通知管理员，编号{index}。",
                f"查找{domain}资料后做摘要，如果搜索失败就提醒管理员，任务{index}。",
                f"从知识库读取{domain}并归纳，失败时通知系统管理员，编号{index}。",
            ],
        )
        nodes = [
            node(
                "search",
                "knowledge.search",
                {"query": domain, "top_k": 8},
                on_failure={"tool": "admin.notify", "arguments": {"message": "search failed"}},
            ),
            node(
                "summary", "text.summarize", {"input_from": "search", "max_words": 120}, ["search"]
            ),
        ]
    elif family == "translate_approval_email":
        prompt = f"找到{domain}文档，翻译成英文，经负责人确认后发邮件，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 6}),
            node(
                "translate",
                "content.translate",
                {"input_from": "search", "target_language": "en"},
                ["search"],
            ),
            node(
                "approve",
                "manager.approval",
                {"input_from": "translate", "role": "owner"},
                ["translate"],
                requires_approval=True,
            ),
            node(
                "email",
                "email.send",
                {"input_from": "translate", "recipient": "overseas@example.com"},
                ["approve"],
                requires_approval=True,
            ),
        ]
    elif family == "records_legal_export":
        prompt = f"查询{domain}，交法务复核后导出PDF，编号{index}。"
        nodes = [
            node(
                "lookup", "records.lookup", {"record_type": domain, "filter": {"status": "active"}}
            ),
            node(
                "legal",
                "legal.review",
                {"input_from": "lookup"},
                ["lookup"],
                requires_approval=True,
            ),
            node("export", "document.export", {"input_from": "lookup", "format": "pdf"}, ["legal"]),
        ]
    elif family == "sentiment_report_message":
        prompt = f"检索{domain}反馈，同时做情感与风险分析，汇总成报告并通知{channel}，编号{index}。"
        nodes = [
            node("collect", "feedback.search", {"date_range": "last_month", "product": domain}),
            node("sentiment", "sentiment.analyze", {"input_from": "collect"}, ["collect"]),
            node(
                "risk",
                "risk.classify",
                {"input_from": "collect", "threshold": "medium"},
                ["collect"],
            ),
            node(
                "report",
                "report.generate",
                {"input_from": "collect", "template": "insight"},
                ["sentiment", "risk"],
            ),
            node(
                "send",
                "message.send",
                {"input_from": "report", "channel": channel},
                ["report"],
                requires_approval=True,
            ),
        ]
    elif family == "search_risk_approval":
        prompt = f"搜索{domain}，只对高风险结果请求人工确认，并在失败时通知管理员，编号{index}。"
        nodes = [
            node(
                "search",
                "knowledge.search",
                {"query": domain, "top_k": 12},
                on_failure={"tool": "admin.notify", "arguments": {"message": "search failed"}},
            ),
            node(
                "risk", "risk.classify", {"input_from": "search", "threshold": "high"}, ["search"]
            ),
            node(
                "approve",
                "human.approval",
                {"input_from": "risk", "assignee": "risk_owner"},
                ["risk"],
                when="risk == high",
                requires_approval=True,
            ),
        ]
    else:  # unseen composition challenge
        prompt = f"把{domain}检索结果并行做情感分析和翻译，审批后同时导出文档并通知{channel}，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 7}),
            node("sentiment", "sentiment.analyze", {"input_from": "search"}, ["search"]),
            node(
                "translate",
                "content.translate",
                {"input_from": "search", "target_language": "en"},
                ["search"],
            ),
            node(
                "approve",
                "manager.approval",
                {"input_from": "translate", "role": "owner"},
                ["sentiment", "translate"],
                requires_approval=True,
            ),
            node(
                "export",
                "document.export",
                {"input_from": "translate", "format": "pdf"},
                ["approve"],
            ),
            node(
                "send",
                "message.send",
                {"input_from": "export", "channel": channel},
                ["approve"],
                requires_approval=True,
            ),
        ]
    workflow = WorkflowSpec(
        name=f"{family}_{suffix}", description=prompt, trigger=trigger, nodes=nodes
    )
    return prompt, workflow


def write_split(path: Path, split: str, count: int, families: list[str], offset: int) -> None:
    rows = []
    for position in range(count):
        family = families[position % len(families)]
        prompt, workflow = build(family, offset + position)
        _, validation = validate_workflow(workflow)
        if not validation.valid:
            raise RuntimeError(f"invalid generated workflow: {family} {validation.model_dump()}")
        rows.append(
            {
                "id": f"{split}-{position:04d}",
                "instruction": prompt,
                "output": workflow.model_dump(),
                "template_family": family,
                "split": split,
                "review_status": "pending_user_review"
                if split in {"test", "challenge"}
                else "auto_validated",
            }
        )
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8"
    )


def generate(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    split_plan = {
        "train": (
            1600,
            [
                "collect_classify_report",
                "search_summarize_notify",
                "aggregate_chart_email",
                "risk_approval_report",
                "sentiment_digest",
                "feedback_risk_escalate",
                "parallel_classify_translate",
                "lookup_legal_notify",
                "aggregate_report_export",
                "translate_summary_email",
                "approval_notify",
                "failure_handling_search",
            ],
            0,
        ),
        "dev": (250, ["translate_approval_email", "records_legal_export"], 2000),
        "test": (250, ["sentiment_report_message", "search_risk_approval"], 3000),
        "challenge": (100, ["challenge_composition"], 4000),
    }
    for split, (count, families, offset) in split_plan.items():
        write_split(root / f"{split}.jsonl", split, count, families, offset)
    status = {
        "total": 2200,
        "train": 1600,
        "dev": 250,
        "test": 250,
        "challenge": 100,
        "test_review": "pending_user_review",
        "challenge_review": "pending_user_review",
        "seed": 20260918,
    }
    (root / "REVIEW_STATUS.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/generated"))
    args = parser.parse_args()
    random.seed(20260918)
    generate(args.output)


if __name__ == "__main__":
    main()

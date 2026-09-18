from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from .schema import RetryPolicy, Trigger, WorkflowNode, WorkflowSpec
from .validator import validate_workflow

DOMAINS = ["客户反馈", "产品缺陷", "合同记录", "用户研究", "市场情报", "知识库"]
CHANNELS = ["产品群", "项目群", "管理群", "研究群"]


def node(id_: str, tool: str, args: dict, deps=None, **kwargs) -> WorkflowNode:
    return WorkflowNode(id=id_, tool=tool, arguments=args, depends_on=deps or [], **kwargs)


def build(family: str, index: int) -> tuple[str, WorkflowSpec]:
    domain = DOMAINS[index % len(DOMAINS)]
    channel = CHANNELS[index % len(CHANNELS)]
    suffix = f"case_{index:04d}"
    trigger = Trigger(type="cron", expression="0 9 * * 1") if index % 3 == 0 else Trigger()
    retry = RetryPolicy(max_attempts=2, backoff_seconds=2) if index % 4 == 0 else RetryPolicy()

    if family == "collect_classify_report":
        prompt = f"汇总最近一周的{domain}，按模块分类后生成周报，任务编号{index}。"
        nodes = [
            node("collect", "feedback.search", {"date_range": "last_week", "product": domain}, retry=retry),
            node("classify", "text.classify", {"labels": ["体验", "性能", "功能"], "input_from": "collect"}, ["collect"]),
            node("report", "report.generate", {"input_from": "classify", "template": "weekly"}, ["classify"]),
        ]
    elif family == "search_summarize_notify":
        prompt = f"搜索{domain}资料并压缩成200字摘要，确认后发到{channel}，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 8}),
            node("summary", "text.summarize", {"input_from": "search", "max_words": 200}, ["search"]),
            node("approve", "human.approval", {"input_from": "summary", "assignee": "owner"}, ["summary"], requires_approval=True),
            node("send", "message.send", {"input_from": "summary", "channel": channel}, ["approve"], requires_approval=True),
        ]
    elif family == "aggregate_chart_email":
        prompt = f"查询{domain}记录，按负责人聚合并画柱状图，然后邮件发送，编号{index}。"
        nodes = [
            node("lookup", "records.lookup", {"record_type": domain, "filter": {"period": "month"}}),
            node("aggregate", "data.aggregate", {"input_from": "lookup", "group_by": "owner"}, ["lookup"]),
            node("chart", "chart.render", {"input_from": "aggregate", "chart_type": "bar"}, ["aggregate"]),
            node("email", "email.send", {"input_from": "chart", "recipient": "team@example.com"}, ["chart"], requires_approval=True),
        ]
    elif family == "risk_approval_report":
        prompt = f"检索{domain}并识别高风险项，高风险先审批，再生成报告；失败重试两次，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 10}, retry=retry),
            node("risk", "risk.classify", {"input_from": "search", "threshold": "high"}, ["search"], retry=retry),
            node("approve", "manager.approval", {"input_from": "risk", "role": "product_owner"}, ["risk"], when="risk == high", requires_approval=True),
            node("report", "report.generate", {"input_from": "risk", "template": "risk"}, ["risk", "approve"]),
        ]
    elif family == "translate_approval_email":
        prompt = f"找到{domain}文档，翻译成英文，经负责人确认后发邮件，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 6}),
            node("translate", "content.translate", {"input_from": "search", "target_language": "en"}, ["search"]),
            node("approve", "manager.approval", {"input_from": "translate", "role": "owner"}, ["translate"], requires_approval=True),
            node("email", "email.send", {"input_from": "translate", "recipient": "overseas@example.com"}, ["approve"], requires_approval=True),
        ]
    elif family == "records_legal_export":
        prompt = f"查询{domain}，交法务复核后导出PDF，编号{index}。"
        nodes = [
            node("lookup", "records.lookup", {"record_type": domain, "filter": {"status": "active"}}),
            node("legal", "legal.review", {"input_from": "lookup"}, ["lookup"], requires_approval=True),
            node("export", "document.export", {"input_from": "lookup", "format": "pdf"}, ["legal"]),
        ]
    elif family == "sentiment_report_message":
        prompt = f"检索{domain}反馈，同时做情感与风险分析，汇总成报告并通知{channel}，编号{index}。"
        nodes = [
            node("collect", "feedback.search", {"date_range": "last_month", "product": domain}),
            node("sentiment", "sentiment.analyze", {"input_from": "collect"}, ["collect"]),
            node("risk", "risk.classify", {"input_from": "collect", "threshold": "medium"}, ["collect"]),
            node("report", "report.generate", {"input_from": "collect", "template": "insight"}, ["sentiment", "risk"]),
            node("send", "message.send", {"input_from": "report", "channel": channel}, ["report"], requires_approval=True),
        ]
    elif family == "search_risk_approval":
        prompt = f"搜索{domain}，只对高风险结果请求人工确认，并在失败时通知管理员，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 12}, on_failure={"tool": "admin.notify", "arguments": {"message": "search failed"}}),
            node("risk", "risk.classify", {"input_from": "search", "threshold": "high"}, ["search"]),
            node("approve", "human.approval", {"input_from": "risk", "assignee": "risk_owner"}, ["risk"], when="risk == high", requires_approval=True),
        ]
    else:  # unseen composition challenge
        prompt = f"把{domain}检索结果并行做情感分析和翻译，审批后同时导出文档并通知{channel}，编号{index}。"
        nodes = [
            node("search", "knowledge.search", {"query": domain, "top_k": 7}),
            node("sentiment", "sentiment.analyze", {"input_from": "search"}, ["search"]),
            node("translate", "content.translate", {"input_from": "search", "target_language": "en"}, ["search"]),
            node("approve", "manager.approval", {"input_from": "translate", "role": "owner"}, ["sentiment", "translate"], requires_approval=True),
            node("export", "document.export", {"input_from": "translate", "format": "pdf"}, ["approve"]),
            node("send", "message.send", {"input_from": "export", "channel": channel}, ["approve"], requires_approval=True),
        ]
    workflow = WorkflowSpec(name=f"{family}_{suffix}", description=prompt, trigger=trigger, nodes=nodes)
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
                "review_status": "pending_user_review" if split in {"test", "challenge"} else "auto_validated",
            }
        )
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")


def generate(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    split_plan = {
        "train": (1600, ["collect_classify_report", "search_summarize_notify", "aggregate_chart_email", "risk_approval_report"], 0),
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
    (root / "REVIEW_STATUS.json").write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("data/generated"))
    args = parser.parse_args()
    random.seed(20260918)
    generate(args.output)


if __name__ == "__main__":
    main()


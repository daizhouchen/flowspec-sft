from __future__ import annotations

from .schema import ToolDefinition, ToolParameter


def p(type_: str, description: str, required: bool = False) -> ToolParameter:
    return ToolParameter(type=type_, description=description, required=required)


TOOL_REGISTRY = [
    ToolDefinition(name="knowledge.search", category="retrieval", description="检索知识库", risk="read", parameters={"query": p("string", "检索问题", True), "top_k": p("integer", "返回数量")}),
    ToolDefinition(name="feedback.search", category="retrieval", description="检索客户反馈", risk="read", parameters={"date_range": p("string", "日期范围", True), "product": p("string", "产品模块")}),
    ToolDefinition(name="records.lookup", category="retrieval", description="查询业务记录", risk="read", parameters={"record_type": p("string", "记录类型", True), "filter": p("object", "筛选条件")}),
    ToolDefinition(name="text.classify", category="classification", description="文本分类", risk="compute", parameters={"labels": p("array", "分类标签", True), "input_from": p("string", "上游节点", True)}),
    ToolDefinition(name="risk.classify", category="classification", description="识别风险等级", risk="compute", parameters={"input_from": p("string", "上游节点", True), "threshold": p("string", "风险阈值")}),
    ToolDefinition(name="sentiment.analyze", category="classification", description="情感分析", risk="compute", parameters={"input_from": p("string", "上游节点", True)}),
    ToolDefinition(name="text.summarize", category="transformation", description="生成摘要", risk="compute", parameters={"input_from": p("string", "上游节点", True), "max_words": p("integer", "最大字数")}),
    ToolDefinition(name="data.aggregate", category="transformation", description="聚合结构化数据", risk="compute", parameters={"input_from": p("string", "上游节点", True), "group_by": p("string", "分组字段")}),
    ToolDefinition(name="content.translate", category="transformation", description="翻译内容", risk="compute", parameters={"input_from": p("string", "上游节点", True), "target_language": p("string", "目标语言", True)}),
    ToolDefinition(name="report.generate", category="reporting", description="生成报告", risk="compute", parameters={"input_from": p("string", "上游节点", True), "template": p("string", "报告模板")}),
    ToolDefinition(name="chart.render", category="reporting", description="生成图表", risk="compute", parameters={"input_from": p("string", "上游节点", True), "chart_type": p("string", "图表类型", True)}),
    ToolDefinition(name="document.export", category="reporting", description="导出文档", risk="compute", parameters={"input_from": p("string", "上游节点", True), "format": p("string", "文档格式", True)}),
    ToolDefinition(name="human.approval", category="approval", description="请求人工确认", risk="approval", parameters={"input_from": p("string", "上游节点", True), "assignee": p("string", "确认人")}),
    ToolDefinition(name="legal.review", category="approval", description="请求法务审核", risk="approval", parameters={"input_from": p("string", "上游节点", True)}),
    ToolDefinition(name="manager.approval", category="approval", description="请求负责人审批", risk="approval", parameters={"input_from": p("string", "上游节点", True), "role": p("string", "负责人角色")}),
    ToolDefinition(name="message.send", category="notification", description="发送群消息", risk="notify", parameters={"input_from": p("string", "上游节点", True), "channel": p("string", "目标群", True)}),
    ToolDefinition(name="email.send", category="notification", description="发送邮件", risk="notify", parameters={"input_from": p("string", "上游节点", True), "recipient": p("string", "收件人", True)}),
    ToolDefinition(name="admin.notify", category="notification", description="通知管理员", risk="notify", parameters={"message": p("string", "通知内容", True)}),
]

TOOL_MAP = {tool.name: tool for tool in TOOL_REGISTRY}


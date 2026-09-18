from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class Trigger(BaseModel):
    type: Literal["manual", "cron", "event"] = "manual"
    expression: str | None = None
    event: str | None = None


class RetryPolicy(BaseModel):
    max_attempts: int = Field(default=0, ge=0, le=3)
    backoff_seconds: int = Field(default=0, ge=0, le=300)


class FailureHandler(BaseModel):
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class WorkflowNode(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    when: str | None = None
    requires_approval: bool = False
    retry: RetryPolicy = Field(default_factory=RetryPolicy)
    on_failure: FailureHandler | None = None


class WorkflowSpec(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    name: str = Field(min_length=3, max_length=80, pattern=r"^[a-z][a-z0-9_]+$")
    description: str = Field(min_length=2, max_length=300)
    trigger: Trigger = Field(default_factory=Trigger)
    nodes: list[WorkflowNode] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def node_ids_are_unique(self):
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate_node_id")
        return self


class ToolParameter(BaseModel):
    type: Literal["string", "integer", "boolean", "array", "object"]
    required: bool = False
    description: str


class ToolDefinition(BaseModel):
    name: str
    category: Literal["retrieval", "classification", "transformation", "reporting", "approval", "notification"]
    description: str
    parameters: dict[str, ToolParameter]
    risk: Literal["read", "compute", "notify", "approval"]


class ValidationIssue(BaseModel):
    code: str
    level: Literal["error", "warning"]
    message: str
    node_id: str | None = None


class ValidationResult(BaseModel):
    valid: bool
    schema_valid: bool
    dag_valid: bool
    issues: list[ValidationIssue]
    topological_order: list[str] = Field(default_factory=list)


class CompileRequest(BaseModel):
    instruction: str = Field(min_length=4, max_length=600)
    repair_once: bool = True


class CompileResponse(BaseModel):
    request_id: str
    elapsed_ms: float
    error_type: str | None = None
    raw_output: dict[str, Any] | None
    workflow: WorkflowSpec | None
    validation: ValidationResult
    repair_log: list[str]
    compiler: str


class ValidateRequest(BaseModel):
    workflow: dict[str, Any]


class SimulateRequest(BaseModel):
    workflow: WorkflowSpec
    approve_human_steps: bool = True


class TraceStep(BaseModel):
    node_id: str
    tool: str
    status: Literal["succeeded", "waiting_approval", "skipped", "failed"]
    message: str


class SimulateResponse(BaseModel):
    request_id: str
    elapsed_ms: float
    status: Literal["completed", "waiting_approval", "failed"]
    trace: list[TraceStep]


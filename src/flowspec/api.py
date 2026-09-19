from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .compiler import compile_request
from .model_compiler import configured_compiler_name, get_compiler
from .schema import (
    CompileRequest,
    CompileResponse,
    SimulateRequest,
    SimulateResponse,
    ToolDefinition,
    ValidateRequest,
    ValidationResult,
)
from .simulator import simulate
from .tools import TOOL_REGISTRY
from .validator import validate_workflow

app = FastAPI(title="FlowSpec API", version="0.1.0", description="Natural-language workflow compiler and sandbox")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("FLOWSPEC_CORS", "http://localhost:5174").split(","),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "mode": os.getenv("FLOWSPEC_MODE", "demo"),
        "compiler": configured_compiler_name(),
    }


@app.get("/api/tools", response_model=list[ToolDefinition])
def tools() -> list[ToolDefinition]:
    return TOOL_REGISTRY


@app.post("/api/compile", response_model=CompileResponse)
def compile_endpoint(request: CompileRequest) -> CompileResponse:
    return compile_request(request, get_compiler())


@app.post("/api/validate", response_model=ValidationResult)
def validate_endpoint(request: ValidateRequest) -> ValidationResult:
    return validate_workflow(request.workflow)[1]


@app.post("/api/simulate", response_model=SimulateResponse)
def simulate_endpoint(request: SimulateRequest) -> SimulateResponse:
    return simulate(request.workflow, request.approve_human_steps)


STATIC_DIR = Path(__file__).resolve().parents[2] / "static"
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

"""Optional model-backed compilers used by the FastAPI service."""
from __future__ import annotations

import json
import os
import urllib.request
from functools import lru_cache
from typing import Any

from .json_utils import extract_json
from .prompt import SYSTEM_PROMPT


def repair_prompt(instruction: str, payload: dict[str, Any], issues: list[Any]) -> str:
    errors = [f"{issue.code}: {issue.message}" for issue in issues if issue.level == "error"]
    return (
        f"原始任务：{instruction}\n"
        f"无效工作流：{json.dumps(payload, ensure_ascii=False)}\n"
        f"校验错误：{json.dumps(errors, ensure_ascii=False)}\n"
        "请修正错误并重新输出完整 WorkflowSpec v1 JSON。"
    )


class TransformersCompiler:
    name = "qwen3-transformers"

    def __init__(self) -> None:
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        model_id = os.getenv("FLOWSPEC_MODEL", "Qwen/Qwen3-1.7B")
        adapter = os.getenv("FLOWSPEC_ADAPTER")
        self.max_new_tokens = int(os.getenv("FLOWSPEC_MAX_NEW_TOKENS", "1200"))
        self.tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype="auto",
            device_map=os.getenv("FLOWSPEC_DEVICE", "auto"),
            trust_remote_code=True,
        )
        if adapter:
            self.model = PeftModel.from_pretrained(self.model, adapter)
        self.model.eval()

    def _generate(self, user_content: str) -> dict[str, Any]:
        import torch

        prompt = self.tokenizer.apply_chat_template(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.model.device)
        with torch.inference_mode():
            generated = self.model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,
                temperature=None,
                top_p=None,
                top_k=None,
                pad_token_id=self.tokenizer.eos_token_id,
            )
        text = self.tokenizer.decode(
            generated[0, inputs.input_ids.shape[1] :],
            skip_special_tokens=True,
        )
        return extract_json(text) or {}

    def compile(self, instruction: str) -> dict[str, Any]:
        return self._generate(instruction)

    def repair(
        self, instruction: str, payload: dict[str, Any], issues: list[Any]
    ) -> dict[str, Any]:
        return self._generate(repair_prompt(instruction, payload, issues))


class LlamaCppCompiler:
    name = "qwen3-gguf-llama-cpp"

    def __init__(self) -> None:
        base = os.getenv("FLOWSPEC_LLAMA_URL", "http://127.0.0.1:8080").rstrip("/")
        self.url = f"{base}/v1/chat/completions"
        self.max_new_tokens = int(os.getenv("FLOWSPEC_MAX_NEW_TOKENS", "1200"))

    def _generate(self, user_content: str) -> dict[str, Any]:
        body = json.dumps(
            {
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                "temperature": 0,
                "max_tokens": self.max_new_tokens,
            }
        ).encode()
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.load(response)
        return extract_json(result["choices"][0]["message"]["content"]) or {}

    def compile(self, instruction: str) -> dict[str, Any]:
        return self._generate(instruction)

    def repair(
        self, instruction: str, payload: dict[str, Any], issues: list[Any]
    ) -> dict[str, Any]:
        return self._generate(repair_prompt(instruction, payload, issues))


def configured_compiler_name() -> str:
    return os.getenv("FLOWSPEC_COMPILER", "heuristic").strip().lower()


@lru_cache(maxsize=1)
def get_compiler():
    backend = configured_compiler_name()
    if backend == "transformers":
        return TransformersCompiler()
    if backend in {"llama", "llama_cpp", "gguf"}:
        return LlamaCppCompiler()
    from .compiler import HeuristicCompiler

    return HeuristicCompiler()

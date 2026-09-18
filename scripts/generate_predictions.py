"""Generate zero-shot, few-shot or adapter predictions for a fixed FlowSpec split."""
from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

SYSTEM = """你是 WorkflowSpec v1 编译器，只输出一个 JSON 对象，不得输出解释或 Markdown。
schema_version 固定为 "1.0"。节点只使用以下工具 ID：
knowledge.search、feedback.search、records.lookup、text.classify、risk.classify、
sentiment.analyze、text.summarize、data.aggregate、content.translate、report.generate、
chart.render、document.export、human.approval、legal.review、manager.approval、
message.send、email.send、admin.notify。
arguments 只保留对应工具实际需要的参数，禁止虚构参数，禁止输出值为 null 的字段。
节点包含 id、tool、arguments、depends_on、requires_approval、retry；when 与 on_failure 仅在需要时输出。"""


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def extract_json(text: str) -> dict | None:
    text = text.strip().removeprefix("```json").removesuffix("```").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            return None
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen3-0.6B")
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--mode", choices=["zero-shot", "few-shot", "sft"], default="zero-shot")
    parser.add_argument("--input", type=Path, default=Path("data/generated/test.jsonl"))
    parser.add_argument("--few-shot-source", type=Path, default=Path("data/generated/train.jsonl"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--max-new-tokens", type=int, default=1200)
    args = parser.parse_args()

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        torch_dtype="auto",
        device_map="auto",
        trust_remote_code=True,
    )
    if args.adapter:
        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()

    demonstrations = load_jsonl(args.few_shot_source)[:2] if args.mode == "few-shot" else []
    rows = load_jsonl(args.input)
    if args.limit:
        rows = rows[: args.limit]
    args.output.parent.mkdir(parents=True, exist_ok=True)

    with args.output.open("w", encoding="utf-8") as handle:
        for start in range(0, len(rows), args.batch_size):
            batch = rows[start : start + args.batch_size]
            prompts = []
            for row in batch:
                messages = [{"role": "system", "content": SYSTEM}]
                for demo in demonstrations:
                    messages.extend(
                        [
                            {"role": "user", "content": demo["instruction"]},
                            {
                                "role": "assistant",
                                "content": json.dumps(demo["output"], ensure_ascii=False),
                            },
                        ]
                    )
                messages.append({"role": "user", "content": row["instruction"]})
                prompts.append(
                    tokenizer.apply_chat_template(
                        messages,
                        tokenize=False,
                        add_generation_prompt=True,
                        enable_thinking=False,
                    )
                )
            inputs = tokenizer(prompts, return_tensors="pt", padding=True).to(model.device)
            started = time.perf_counter()
            with torch.inference_mode():
                generated = model.generate(
                    **inputs,
                    max_new_tokens=args.max_new_tokens,
                    do_sample=False,
                    pad_token_id=tokenizer.eos_token_id,
                )
            batch_latency_ms = (time.perf_counter() - started) * 1000
            generated_texts = tokenizer.batch_decode(
                generated[:, inputs.input_ids.shape[1] :],
                skip_special_tokens=True,
            )
            for row, text in zip(batch, generated_texts, strict=True):
                record = {
                    "id": row["id"],
                    "mode": args.mode,
                    "prediction": extract_json(text),
                    "raw_text": text,
                    "latency_ms": round(batch_latency_ms / len(batch), 2),
                }
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()

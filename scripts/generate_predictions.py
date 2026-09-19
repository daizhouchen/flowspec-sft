"""Generate zero-shot, few-shot or adapter predictions for a fixed FlowSpec split."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from flowspec.json_utils import extract_json
from flowspec.prompt import SYSTEM_PROMPT


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


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
    parser.add_argument("--metadata-output", type=Path)
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
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    demonstrations = load_jsonl(args.few_shot_source)[:2] if args.mode == "few-shot" else []
    rows = load_jsonl(args.input)
    if args.limit:
        rows = rows[: args.limit]
    args.output.parent.mkdir(parents=True, exist_ok=True)

    observed_latencies: list[float] = []
    started_all = time.perf_counter()
    with args.output.open("w", encoding="utf-8") as handle:
        for start in range(0, len(rows), args.batch_size):
            batch = rows[start : start + args.batch_size]
            prompts = []
            for row in batch:
                messages = [{"role": "system", "content": SYSTEM_PROMPT}]
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
                    temperature=None,
                    top_p=None,
                    top_k=None,
                    pad_token_id=tokenizer.eos_token_id,
                )
            batch_latency_ms = (time.perf_counter() - started) * 1000
            generated_texts = tokenizer.batch_decode(
                generated[:, inputs.input_ids.shape[1] :],
                skip_special_tokens=True,
            )
            for row, text in zip(batch, generated_texts, strict=True):
                per_item_latency = round(batch_latency_ms / len(batch), 2)
                observed_latencies.append(per_item_latency)
                record = {
                    "id": row["id"],
                    "mode": args.mode,
                    "prediction": extract_json(text),
                    "raw_text": text,
                    "latency_ms": per_item_latency,
                }
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    metadata = {
        "base_model": args.model,
        "adapter": str(args.adapter.resolve()) if args.adapter else None,
        "mode": args.mode,
        "count": len(rows),
        "batch_size": args.batch_size,
        "max_new_tokens": args.max_new_tokens,
        "mean_latency_ms": round(sum(observed_latencies) / max(1, len(rows)), 2),
        "wall_time_seconds": round(time.perf_counter() - started_all, 2),
    }
    if torch.cuda.is_available():
        metadata["peak_allocated_gib"] = round(
            torch.cuda.max_memory_allocated() / (1024**3), 3
        )
        metadata["peak_reserved_gib"] = round(
            torch.cuda.max_memory_reserved() / (1024**3), 3
        )
    metadata_output = args.metadata_output or args.output.with_suffix(".meta.json")
    metadata_output.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

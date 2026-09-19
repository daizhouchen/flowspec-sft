"""Single-GPU QLoRA entrypoint. Run only after the shared-server resource gate passes."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)

SYSTEM = """你是 WorkflowSpec v1 编译器，只输出一个 JSON 对象，不得输出解释或 Markdown。
schema_version 固定为 "1.0"。节点只使用以下工具 ID：
knowledge.search、feedback.search、records.lookup、text.classify、risk.classify、
sentiment.analyze、text.summarize、data.aggregate、content.translate、report.generate、
chart.render、document.export、human.approval、legal.review、manager.approval、
message.send、email.send、admin.notify。
arguments 只保留对应工具实际需要的参数，禁止虚构参数，禁止输出值为 null 的字段。
节点包含 id、tool、arguments、depends_on、requires_approval、retry；when 与 on_failure 仅在需要时输出。"""


def load_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def drop_none(value):
    if isinstance(value, dict):
        return {key: drop_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [drop_none(item) for item in value]
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen3-0.6B")
    parser.add_argument("--train", type=Path, default=Path("data/generated/train.jsonl"))
    parser.add_argument("--dev", type=Path, default=Path("data/generated/dev.jsonl"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--train-limit", type=int, default=0)
    parser.add_argument("--dev-limit", type=int, default=0)
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--max-steps", type=int, default=-1)
    args = parser.parse_args()

    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        quantization_config=quantization,
        device_map="auto",
        trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)
    config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, config)
    model.config.use_cache = False

    def tokenize(item):
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": item["instruction"]},
        ]
        prompt_ids = tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        full_ids = tokenizer.apply_chat_template(
            messages
            + [
                {
                    "role": "assistant",
                    "content": json.dumps(drop_none(item["output"]), ensure_ascii=False),
                }
            ],
            tokenize=True,
            add_generation_prompt=False,
            enable_thinking=False,
        )
        full_ids = full_ids[: args.max_length]
        prompt_length = min(len(prompt_ids), len(full_ids))
        labels = [-100] * prompt_length + full_ids[prompt_length:]
        return {
            "input_ids": full_ids,
            "attention_mask": [1] * len(full_ids),
            "labels": labels,
        }

    train_rows = load_rows(args.train)
    dev_rows = load_rows(args.dev)
    if args.train_limit > 0:
        train_rows = train_rows[: args.train_limit]
    if args.dev_limit > 0:
        dev_rows = dev_rows[: args.dev_limit]
    train = Dataset.from_list(train_rows)
    dev = Dataset.from_list(dev_rows)
    train = train.map(tokenize, remove_columns=train.column_names)
    dev = dev.map(tokenize, remove_columns=dev.column_names)
    collator = DataCollatorForSeq2Seq(
        tokenizer=tokenizer,
        model=model,
        padding=True,
        label_pad_token_id=-100,
    )
    training = TrainingArguments(
        output_dir=str(args.output),
        per_device_train_batch_size=1,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=16,
        learning_rate=2e-4,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=100,
        save_steps=100,
        bf16=True,
        gradient_checkpointing=True,
        report_to="none",
        seed=20260918,
        dataloader_num_workers=0,
        label_names=["labels"],
        save_total_limit=2,
    )
    trainer = Trainer(
        model=model,
        args=training,
        train_dataset=train,
        eval_dataset=dev,
        processing_class=tokenizer,
        data_collator=collator,
    )
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    train_result = trainer.train()
    train_metrics = dict(train_result.metrics)
    if torch.cuda.is_available():
        train_metrics["peak_allocated_gib"] = round(
            torch.cuda.max_memory_allocated() / (1024**3), 3
        )
        train_metrics["peak_reserved_gib"] = round(
            torch.cuda.max_memory_reserved() / (1024**3), 3
        )
    train_metrics.update(
        {
            "base_model": args.model,
            "train_examples": len(train),
            "dev_examples": len(dev),
            "max_length": args.max_length,
        }
    )
    trainer.log_metrics("train", train_metrics)
    trainer.save_metrics("train", train_metrics)
    eval_metrics = trainer.evaluate()
    trainer.log_metrics("eval", eval_metrics)
    trainer.save_metrics("eval", eval_metrics)
    trainer.save_state()
    trainer.save_model()
    tokenizer.save_pretrained(args.output)


if __name__ == "__main__":
    main()

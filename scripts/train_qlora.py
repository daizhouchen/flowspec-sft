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
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)


def load_rows(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        item = json.loads(line)
        rows.append({"text": f"<|user|>\n{item['instruction']}\n<|assistant|>\n{json.dumps(item['output'], ensure_ascii=False)}"})
    return rows


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

    def tokenize(batch):
        return tokenizer(batch["text"], truncation=True, max_length=args.max_length, padding=False)

    train_rows = load_rows(args.train)
    dev_rows = load_rows(args.dev)
    if args.train_limit > 0:
        train_rows = train_rows[: args.train_limit]
    if args.dev_limit > 0:
        dev_rows = dev_rows[: args.dev_limit]
    train = Dataset.from_list(train_rows).map(tokenize, batched=True, remove_columns=["text"])
    dev = Dataset.from_list(dev_rows).map(tokenize, batched=True, remove_columns=["text"])
    collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)
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
    trainer.train()
    trainer.save_model()
    tokenizer.save_pretrained(args.output)


if __name__ == "__main__":
    main()

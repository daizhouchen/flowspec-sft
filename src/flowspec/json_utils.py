"""Deterministic recovery for model-generated JSON objects."""
from __future__ import annotations

import json
import re
from typing import Any


def _raw_decode_object(text: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    start = text.find("{")
    if start < 0:
        return None
    try:
        value, _ = decoder.raw_decode(text[start:])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _balance_delimiters(text: str) -> str:
    output: list[str] = []
    stack: list[str] = []
    in_string = False
    escaped = False
    pairs = {"}": "{", "]": "["}
    closing = {"{": "}", "[": "]"}
    for char in text:
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            output.append(char)
        elif char in closing:
            stack.append(char)
            output.append(char)
        elif char in pairs:
            if not stack:
                continue
            expected = pairs[char]
            opener = stack.pop()
            output.append(char if opener == expected else closing[opener])
        else:
            output.append(char)
    if in_string:
        output.append('"')
    output.extend(closing[item] for item in reversed(stack))
    return "".join(output)


def extract_json(text: str) -> dict[str, Any] | None:
    cleaned = text.strip().removeprefix("```json").removesuffix("```").strip()
    parsed = _raw_decode_object(cleaned)
    if parsed is not None:
        return parsed
    cleaned = re.sub(
        r'\}\]\s*,\s*"(when|on_failure|labels)"\s*:',
        r'}, "\1":',
        cleaned,
    )
    cleaned = re.sub(r'("(?:[^"\\]|\\.)*")\)\s*,', r"\1,", cleaned)
    return _raw_decode_object(_balance_delimiters(cleaned))

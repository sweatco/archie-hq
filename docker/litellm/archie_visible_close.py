"""Ensures every /v1/messages turn ends with non-empty assistant text.

Claude Code re-prompts any turn it judges produced no visible output. GPT-5.6
ends turns emitting an empty text block, which triggers that nudge and makes a
coordinator agent re-post its answer. Injecting is required: the check tests for
the presence of visible text, so deleting the empty block fixes nothing.

Safe for Archie because user-facing output goes through MCP tools, never the
assistant text block, so the injected line never reaches Slack.
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator

from litellm.integrations.custom_logger import CustomLogger

VISIBLE_CLOSE_TEXT = "Done."


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"


def _closing_text_frames(index: int) -> str:
    return (
        _sse("content_block_start", {"type": "content_block_start", "index": index,
                                     "content_block": {"type": "text", "text": ""}})
        + _sse("content_block_delta", {"type": "content_block_delta", "index": index,
                                       "delta": {"type": "text_delta", "text": VISIBLE_CLOSE_TEXT}})
        + _sse("content_block_stop", {"type": "content_block_stop", "index": index})
    )


class ArchieVisibleClose(CustomLogger):
    async def async_post_call_streaming_iterator_hook(
        self,
        user_api_key_dict: Any,
        response: Any,
        request_data: dict,
    ) -> AsyncGenerator[Any, None]:
        saw_visible_text = False
        max_index = -1
        injected = False
        emit_bytes = False

        # Strict pass-through: chunks are yielded as they arrive and frames only
        # appended. Buffering to assemble the stream would stall the client and
        # trip Claude Code's ~300s silence watchdog during thinking pauses.
        async for chunk in response:
            if not isinstance(chunk, (str, bytes)):
                yield chunk
                continue

            if isinstance(chunk, bytes):
                emit_bytes = True
                text = chunk.decode("utf-8", errors="replace")
            else:
                text = chunk

            has_message_delta = False

            for line in text.split("\n"):
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                body = line[len("data:"):].strip()
                if not body or body == "[DONE]":
                    continue
                try:
                    event = json.loads(body)
                except ValueError:
                    # Frame split across chunks; worst case we append a
                    # redundant "Done.", which is inert.
                    continue
                if not isinstance(event, dict):
                    continue

                etype = event.get("type")
                idx = event.get("index")
                if isinstance(idx, int):
                    max_index = max(max_index, idx)

                if etype == "content_block_start":
                    block = event.get("content_block") or {}
                    if block.get("type") == "text" and (block.get("text") or "").strip():
                        saw_visible_text = True
                elif etype == "content_block_delta":
                    delta = event.get("delta") or {}
                    if delta.get("type") == "text_delta" and (delta.get("text") or "").strip():
                        saw_visible_text = True
                elif etype == "message_delta":
                    has_message_delta = True

            if has_message_delta and not saw_visible_text and not injected:
                injected = True
                frames = _closing_text_frames(max_index + 1)
                yield frames.encode("utf-8") if emit_bytes else frames

            yield chunk


instance = ArchieVisibleClose()

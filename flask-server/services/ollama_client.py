from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Iterable

import requests


OLLAMA_BASE_URL = os.getenv(
    "OLLAMA_BASE_URL",
    "http://localhost:11434",
).rstrip("/")

# Default to llama3.1 — it is NOT a reasoning model, so it never leaks a
# chain-of-thought "thinking" block into the answer. qwen3 is faster but only
# stays clean when the local Ollama honors the /no_think switch (recent Ollama).
DEFAULT_OLLAMA_MODEL = os.getenv(
    "BODYMAPS_OLLAMA_MODEL",
    "llama3.1:latest",
).strip()

# Model used when the request carries images (screenshots / attached scans).
DEFAULT_OLLAMA_VISION_MODEL = os.getenv(
    "BODYMAPS_OLLAMA_VISION_MODEL",
    "qwen3-vl:4b",
).strip()

OLLAMA_LIST_TIMEOUT = float(
    os.getenv("OLLAMA_LIST_TIMEOUT_SECONDS", "5")
)

# Local models can take longer than 30 seconds on the first request.
OLLAMA_CHAT_TIMEOUT = float(
    os.getenv("OLLAMA_CHAT_TIMEOUT_SECONDS", "180")
)

OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m").strip() or "30m"

OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))

# Images are expensive in context: a single 768px CT pane costs roughly 700-1200
# tokens for qwen3-vl, so four panes plus a long structured question overflow the
# 8k text window. When that happens Ollama silently drops the OLDEST tokens —
# which is the system prompt carrying every instruction about how to read the
# screenshots. The result looks exactly like "the hidden image prompt did
# nothing". Vision turns therefore get their own, larger window.
OLLAMA_VISION_NUM_CTX = int(
    os.getenv("OLLAMA_VISION_NUM_CTX", "12288")
)

# Hard ceiling on how many images are forwarded in one turn. The viewer's own
# panes are at most four (axial/sagittal/coronal/3D) and the composer stops at
# this many images in all; more only guarantees a context overflow. The AI
# endpoints trim to it first, so the prompt matches what is sent.
OLLAMA_MAX_IMAGES = int(os.getenv("OLLAMA_MAX_IMAGES", "4"))

# Ceiling on generated tokens. -1 means "no cap": the model generates until it
# naturally finishes, so answers are never cut off mid-sentence. Brevity for
# simple questions comes from the prompt, not from a low cap.
OLLAMA_NUM_PREDICT = int(os.getenv("OLLAMA_NUM_PREDICT", "-1"))

# Connect timeout for the streaming call. The READ timeout is intentionally
# unlimited (see chat_stream) so a slow, still-working generation is never
# disconnected before it finishes.
OLLAMA_CONNECT_TIMEOUT = float(os.getenv("OLLAMA_CONNECT_TIMEOUT_SECONDS", "20"))

# Ask the model to emit its private reasoning as a separate "thinking" stream
# (supported by qwen3 / reasoning models). When false, only the answer streams.
OLLAMA_THINK = os.getenv("OLLAMA_THINK", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

# How long the installed-model list is trusted before it is re-fetched. Pulling a
# model mid-session should be picked up without a backend restart, but every
# assistant message must not pay for an extra HTTP round trip either.
_MODEL_LIST_TTL_SECONDS = float(os.getenv("OLLAMA_MODEL_LIST_TTL_SECONDS", "60"))

# A failed probe is remembered only briefly, so the assistant comes back on its
# own within seconds of Ollama being restarted.
_MODEL_LIST_FAILURE_TTL_SECONDS = float(
    os.getenv("OLLAMA_MODEL_LIST_FAILURE_TTL_SECONDS", "10")
)


class OllamaUnavailable(RuntimeError):
    """Raised when the local Ollama server cannot complete a request."""


class OllamaModelMissing(OllamaUnavailable):
    """Raised when Ollama is reachable but the requested model is not pulled.

    A subclass of OllamaUnavailable so existing `except OllamaUnavailable`
    handlers keep working, while callers that can pick a different model (the
    vision path) are able to tell "Ollama is down" apart from "this particular
    model was never downloaded" — two failures that need very different fixes.
    """


class OllamaInvalidResponse(RuntimeError):
    """Raised when Ollama returns a response that cannot be parsed."""


# Model families that accept images. Ollama does not expose a "supports vision"
# flag on /api/tags in every version, so the family name is the reliable signal.
_VISION_MODEL_RE = re.compile(
    r"(?:^|[/_-])(?:"
    r"qwen[\d.]*-?vl|llava|llama[\d.]*-vision|vision|"
    r"minicpm-?v|moondream|bakllava|granite[\d.]*-vision|"
    r"gemma3|mistral-small3|pixtral|internvl|cogvlm|glm-4v"
    r")",
    re.IGNORECASE,
)

# Reasoning families whose output can carry a chain-of-thought. qwen3-vl
# (instruct) is deliberately excluded: it does not reason, and sending it the
# "/no_think" directive just injects stray text into a vision prompt.
_REASONING_MODEL_RE = re.compile(
    r"qwen3(?!-vl)|deepseek-r1|-r1\b|qwq|marco-o1|thinking", re.IGNORECASE
)

_MODEL_CACHE: dict[str, Any] = {"names": [], "fetched_at": 0.0, "ok": False}
_MODEL_CACHE_LOCK = threading.Lock()


def is_vision_model(name: str) -> bool:
    """Whether a model name belongs to a family that accepts images."""
    return bool(_VISION_MODEL_RE.search(str(name or "")))


def is_reasoning_model(name: str) -> bool:
    """Whether a model name belongs to a family that emits chain-of-thought."""
    return bool(_REASONING_MODEL_RE.search(str(name or "")))


def list_ollama_models(
    timeout: float | None = None,
) -> list[dict[str, Any]]:
    """Return installed Ollama models from /api/tags."""

    try:
        response = requests.get(
            f"{OLLAMA_BASE_URL}/api/tags",
            timeout=(
                timeout
                if timeout is not None
                else OLLAMA_LIST_TIMEOUT
            ),
        )
        response.raise_for_status()
        payload = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise OllamaUnavailable(str(exc)) from exc

    models = payload.get("models", [])

    if not isinstance(models, list):
        return []

    result: list[dict[str, Any]] = []

    for model in models:
        if not isinstance(model, dict):
            continue

        name = str(model.get("name") or "").strip()
        if not name:
            continue

        result.append(
            {
                "name": name,
                "size": model.get("size"),
                "modified_at": model.get("modified_at"),
                "details": model.get("details"),
            }
        )

    return result


def installed_model_names(force: bool = False) -> tuple[list[str], bool]:
    """Cached list of installed model names.

    Returns (names, listing_ok). listing_ok is False when Ollama could not be
    reached — callers must then fall back to the configured model rather than
    concluding that nothing is installed, because "the tag listing timed out" is
    not evidence that a model is missing.
    """
    now = time.monotonic()

    with _MODEL_CACHE_LOCK:
        age = now - float(_MODEL_CACHE["fetched_at"])
        # A failed probe is cached too, on a shorter timer. Otherwise every
        # message sent while Ollama is down pays the full list timeout again
        # before the chat call fails for the same reason.
        ttl = _MODEL_LIST_TTL_SECONDS if _MODEL_CACHE["ok"] else _MODEL_LIST_FAILURE_TTL_SECONDS
        if not force and age < ttl:
            return list(_MODEL_CACHE["names"]), bool(_MODEL_CACHE["ok"])

    try:
        names = [model["name"] for model in list_ollama_models()]
        ok = True
    except OllamaUnavailable:
        names, ok = [], False

    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE["fetched_at"] = now
        _MODEL_CACHE["ok"] = ok
        if ok:
            _MODEL_CACHE["names"] = list(names)
        cached = list(_MODEL_CACHE["names"])

    return (names if ok else cached), ok


def _name_matches(candidate: str, installed: str) -> bool:
    """Whether `installed` satisfies a request for `candidate`.

    Ollama reports fully qualified tags ("llama3.1:latest"), while configuration
    and the UI often use the bare name ("llama3.1"). Treat a missing tag as
    ":latest" so the two forms resolve to each other.
    """
    want = str(candidate or "").strip().lower()
    have = str(installed or "").strip().lower()
    if not want or not have:
        return False
    if want == have:
        return True
    if ":" not in want and have == f"{want}:latest":
        return True
    if ":" not in have and want == f"{have}:latest":
        return True
    return False


def model_is_installed(name: str, names: Iterable[str] | None = None) -> bool:
    """Whether a model is present locally (best effort)."""
    if names is None:
        names, ok = installed_model_names()
        if not ok:
            # Unknown, not absent — assume present and let the chat call decide.
            return True
    return any(_name_matches(name, installed) for installed in names)


def resolve_vision_model(preferred: str | None = None) -> str | None:
    """Pick a vision-capable model that is actually installed.

    Order: an explicitly requested vision model, then the configured default,
    then any installed model from a known vision family. Returns None only when
    Ollama is reachable and genuinely has no vision model — the one case where
    the caller must tell the user to pull one instead of silently sending images
    to a text-only model, which answers confidently about an image it never saw.
    """
    names, listing_ok = installed_model_names()

    candidates = [
        preferred,
        DEFAULT_OLLAMA_VISION_MODEL,
    ]
    for candidate in candidates:
        candidate = str(candidate or "").strip()
        if not candidate or not is_vision_model(candidate):
            continue
        if not listing_ok:
            # Cannot verify; trust configuration rather than refusing to try.
            return candidate
        if model_is_installed(candidate, names):
            return candidate

    if not listing_ok:
        return DEFAULT_OLLAMA_VISION_MODEL or None

    for installed in names:
        if is_vision_model(installed):
            return installed

    return None


def resolve_text_model(preferred: str | None = None) -> str:
    """Pick an installed text model, falling back to the configured default."""
    names, listing_ok = installed_model_names()

    for candidate in (preferred, DEFAULT_OLLAMA_MODEL):
        candidate = str(candidate or "").strip()
        if not candidate:
            continue
        if not listing_ok or model_is_installed(candidate, names):
            return candidate

    for installed in names:
        if not is_vision_model(installed):
            return installed

    return str(preferred or DEFAULT_OLLAMA_MODEL).strip()


def _extract_json_object(text: str) -> dict[str, Any]:
    value = (text or "").strip()

    if not value:
        raise OllamaInvalidResponse(
            "Ollama returned an empty response."
        )

    fenced = re.search(
        r"```(?:json)?\s*(\{.*\})\s*```",
        value,
        flags=re.DOTALL | re.IGNORECASE,
    )

    if fenced:
        value = fenced.group(1).strip()
    elif not value.startswith("{"):
        start = value.find("{")
        end = value.rfind("}")

        if start >= 0 and end > start:
            value = value[start : end + 1]

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise OllamaInvalidResponse(
            f"Ollama did not return valid JSON: {exc}"
        ) from exc

    if not isinstance(parsed, dict):
        raise OllamaInvalidResponse(
            "Ollama response JSON was not an object."
        )

    return parsed


def _describes_missing_model(text: str) -> bool:
    lowered = str(text or "").lower()
    return (
        "not found" in lowered
        or "no such model" in lowered
        or "try pulling it first" in lowered
        or "unknown model" in lowered
    )


def _raise_for_chat_error(exc: requests.RequestException) -> None:
    """Translate a failed /api/chat call into the most specific error we can."""
    response = getattr(exc, "response", None)
    detail = ""
    status = None

    if response is not None:
        status = response.status_code
        try:
            payload = response.json()
            detail = str(payload.get("error") or payload)
        except ValueError:
            detail = (response.text or "")[:400]

    message = detail or str(exc)

    if status == 404 or _describes_missing_model(message):
        raise OllamaModelMissing(message) from exc

    raise OllamaUnavailable(message) from exc


def _post_chat(
    payload: dict[str, Any],
    timeout: float,
) -> dict[str, Any]:
    try:
        response = requests.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json=payload,
            timeout=timeout,
        )
        response.raise_for_status()
        data = response.json()
    except requests.Timeout as exc:
        raise OllamaUnavailable(
            "Ollama timed out while generating a response."
        ) from exc
    except requests.RequestException as exc:
        _raise_for_chat_error(exc)
        raise  # unreachable; keeps type checkers happy
    except ValueError as exc:
        raise OllamaUnavailable(str(exc)) from exc

    if not isinstance(data, dict):
        raise OllamaInvalidResponse(
            "Ollama returned an unexpected response."
        )

    return data


def chat_structured_json(
    *,
    model: str,
    messages: list[dict[str, Any]],
    schema: dict[str, Any],
    timeout: float | None = None,
    temperature: float = 0.0,
    seed: int = 42,
) -> dict[str, Any]:
    """Call Ollama with text or image messages and a JSON response schema."""
    selected_model = str(model or "").strip()
    if not selected_model:
        raise ValueError("An Ollama model name is required.")
    if not messages:
        raise ValueError("At least one Ollama message is required.")
    if not isinstance(schema, dict) or schema.get("type") != "object":
        raise ValueError("A JSON object schema is required.")

    payload: dict[str, Any] = {
        "model": selected_model,
        "stream": False,
        "keep_alive": "10m",
        "messages": messages,
        "options": {
            "temperature": temperature,
            "num_ctx": 4096,
            "seed": seed,
        },
        "format": schema,
    }
    data = _post_chat(
        payload,
        timeout if timeout is not None else OLLAMA_CHAT_TIMEOUT,
    )
    content = (((data.get("message") or {}).get("content") or "")).strip()
    return _extract_json_object(content)


def chat_json(
    *,
    model: str | None,
    system_prompt: str,
    user_prompt: str,
    response_schema: dict[str, Any] | None = None,
    timeout: float | None = None,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """
    Call Ollama /api/chat and return one parsed JSON object.

    The response contains conversational text and optional viewer actions.
    """

    selected_model = (
        str(model or DEFAULT_OLLAMA_MODEL).strip()
    )

    if not selected_model:
        raise ValueError("An Ollama model name is required.")

    request_timeout = (
        timeout
        if timeout is not None
        else OLLAMA_CHAT_TIMEOUT
    )

    json_user_prompt = user_prompt
    if not OLLAMA_THINK and is_reasoning_model(selected_model):
        json_user_prompt = f"{json_user_prompt}\n\n/no_think"

    payload: dict[str, Any] = {
        "model": selected_model,
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "messages": [
            {
                "role": "system",
                "content": system_prompt,
            },
            {
                "role": "user",
                "content": json_user_prompt,
            },
        ],
        "options": {
            "temperature": temperature,
            "num_ctx": OLLAMA_NUM_CTX,
            "seed": 42,
        },
        "think": OLLAMA_THINK,
        "format": response_schema or "json",
    }

    data = _post_chat(payload, request_timeout)

    content = (
        ((data.get("message") or {}).get("content") or "")
        .strip()
    )

    try:
        return _extract_json_object(content)
    except OllamaInvalidResponse:
        # Give the model one opportunity to repair malformed JSON.
        repair_payload: dict[str, Any] = {
            "model": selected_model,
            "stream": False,
            "keep_alive": "10m",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Convert the supplied content into one valid JSON "
                        "object with keys reply, actions, and intent. "
                        "Return JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": content,
                },
            ],
            "options": {
                "temperature": 0.0,
                "num_ctx": 4096,
                "seed": 42,
            },
            "format": response_schema or "json",
        }

        repaired = _post_chat(
            repair_payload,
            request_timeout,
        )

        repaired_content = (
            (
                (repaired.get("message") or {})
                .get("content")
                or ""
            )
            .strip()
        )

        return _extract_json_object(repaired_content)


def chat_with_tools(
    *,
    model: str | None,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    timeout: float | None = None,
    temperature: float = 0.1,
) -> dict[str, Any]:
    """One non-streaming /api/chat round with native Ollama tool calling.

    Returns the raw assistant message dict: {"content": str, "tool_calls":
    [...]}. Callers run the agent loop (execute tools, append results, call
    again). Raises OllamaUnavailable on transport errors and on servers too
    old to know the "tools" field, so callers can fall back to the plain
    single-shot path. llama3.1 and qwen3 both support tools; the caller is
    responsible for appending "/no_think" to the user message for qwen3.
    """
    selected_model = str(model or DEFAULT_OLLAMA_MODEL).strip()

    if not selected_model:
        raise ValueError("An Ollama model name is required.")
    if not messages:
        raise ValueError("At least one message is required.")

    payload: dict[str, Any] = {
        "model": selected_model,
        "stream": False,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "messages": messages,
        "tools": tools,
        "options": {
            "temperature": temperature,
            "num_ctx": OLLAMA_NUM_CTX,
        },
        "think": OLLAMA_THINK,
    }

    data = _post_chat(
        payload,
        timeout if timeout is not None else OLLAMA_CHAT_TIMEOUT,
    )

    message = data.get("message")
    if not isinstance(message, dict):
        raise OllamaInvalidResponse("Ollama returned no message for the tool call.")
    return message


def _build_chat_messages(
    *,
    system_prompt: str,
    user_prompt: str,
    history: list[dict[str, Any]] | None,
    images: list[str] | None,
    selected_model: str,
) -> list[dict[str, Any]]:
    """Assemble the /api/chat message list for one streamed turn.

    Prior turns are sent as real assistant/user messages instead of being
    flattened into the prompt text: a model that can see its own last message
    actually continues the conversation, which is what makes "you asked me for
    the bilirubin, here it is" resolve to the right thread instead of restarting.
    """
    content = user_prompt

    # "/no_think" is a qwen3 *reasoning* directive. Sending it to qwen3-vl (an
    # instruct model) just prepends noise to a vision prompt, so it is gated on
    # the reasoning family rather than on the substring "qwen3".
    if not OLLAMA_THINK and is_reasoning_model(selected_model):
        content = f"{content}\n\n/no_think"

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
    ]

    for turn in history or []:
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "").strip()
        text = str(turn.get("content") or "").strip()
        if role in {"user", "assistant"} and text:
            messages.append({"role": role, "content": text})

    user_message: dict[str, Any] = {"role": "user", "content": content}

    if images:
        user_message["images"] = list(images)[:OLLAMA_MAX_IMAGES]

    messages.append(user_message)
    return messages


def chat_stream(
    *,
    model: str | None,
    system_prompt: str,
    user_prompt: str,
    images: list[str] | None = None,
    history: list[dict[str, Any]] | None = None,
    num_ctx: int | None = None,
    timeout: float | None = None,
    temperature: float = 0.2,
    seed: int | None = 42,
):
    """
    Stream a conversational answer from Ollama /api/chat.

    Yields (kind, text) tuples as tokens arrive, where kind is either
    "thinking" (the model's private reasoning) or "content" (the answer the
    user should see). Callers forward these to the browser so the reply
    appears progressively instead of all at once.

    `images` is an optional list of base64-encoded images (no data: prefix);
    when present the caller should pass a vision-capable model, and the context
    window is widened automatically so the system prompt is not evicted by the
    image tokens.

    Raises OllamaModelMissing when the model is not pulled, so the caller can
    say so plainly instead of reporting a generic outage.
    """

    selected_model = str(model or DEFAULT_OLLAMA_MODEL).strip()

    if not selected_model:
        raise ValueError("An Ollama model name is required.")

    if images and not is_vision_model(selected_model):
        raise OllamaModelMissing(
            f"'{selected_model}' cannot read images. Pull a vision model "
            f"(for example: ollama pull {DEFAULT_OLLAMA_VISION_MODEL or 'qwen3-vl:4b'})."
        )

    # (connect, read) timeout. Read is None = unlimited, so a slow but still
    # streaming answer is NEVER disconnected before it finishes — only a failure
    # to connect (Ollama down) errors out quickly. `timeout` (if passed) only
    # overrides the connect timeout.
    connect_timeout = timeout if timeout is not None else OLLAMA_CONNECT_TIMEOUT
    request_timeout = (connect_timeout, None)

    if num_ctx is not None:
        window = int(num_ctx)
    elif images:
        window = max(OLLAMA_NUM_CTX, OLLAMA_VISION_NUM_CTX)
    else:
        window = OLLAMA_NUM_CTX

    messages = _build_chat_messages(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        history=history,
        images=images,
        selected_model=selected_model,
    )

    payload: dict[str, Any] = {
        "model": selected_model,
        "stream": True,
        "keep_alive": OLLAMA_KEEP_ALIVE,
        "messages": messages,
        "options": {
            "temperature": temperature,
            "num_ctx": window,
            "num_predict": OLLAMA_NUM_PREDICT,
            # A fixed seed makes each model reproducible run to run. Combined
            # with a low temperature and an identical fact block, the three
            # models converge on the same substance and differ only in depth —
            # which is the point: they disagreed on findings before this.
            **({"seed": seed} if seed is not None else {}),
        },
        "think": OLLAMA_THINK,
    }

    produced_any = False

    # Older Ollama builds reject the "think" field outright. Retrying once
    # without it keeps those servers working instead of surfacing a hard outage
    # for what is only an optional feature flag.
    for attempt, body in enumerate(
        (payload, {k: v for k, v in payload.items() if k != "think"})
    ):
        try:
            with requests.post(
                f"{OLLAMA_BASE_URL}/api/chat",
                json=body,
                timeout=request_timeout,
                stream=True,
            ) as response:
                response.raise_for_status()

                for line in response.iter_lines(decode_unicode=True):
                    if not line:
                        continue

                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue

                    if not isinstance(chunk, dict):
                        continue

                    if chunk.get("error"):
                        detail = str(chunk.get("error"))
                        if _describes_missing_model(detail):
                            raise OllamaModelMissing(detail)
                        raise OllamaUnavailable(detail)

                    message = chunk.get("message") or {}

                    thinking = message.get("thinking")
                    if thinking:
                        produced_any = True
                        yield ("thinking", thinking)

                    content = message.get("content")
                    if content:
                        produced_any = True
                        yield ("content", content)

                    if chunk.get("done"):
                        return
            return

        except requests.Timeout as exc:
            raise OllamaUnavailable(
                "Ollama timed out while generating a response."
            ) from exc
        except requests.RequestException as exc:
            # Only the "think" retry is safe to attempt: once tokens have been
            # yielded, restarting would duplicate text in the user's reply.
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if attempt == 0 and not produced_any and status == 400:
                continue
            _raise_for_chat_error(exc)
        except ValueError as exc:
            raise OllamaUnavailable(str(exc)) from exc

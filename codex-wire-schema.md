# Codex Responses Wire Contract

This document records the contract implemented by the upstream Codex source
checked out at:

```text
C:\Users\Damas\codex-source
```

Source revision:

```text
d6489472f3c15e87d2d7763a5fde033545c530f8
```

Primary source files:

- `codex-rs/codex-api/src/common.rs`
- `codex-rs/codex-api/src/endpoint/responses.rs`
- `codex-rs/codex-api/src/sse/responses.rs`
- `codex-rs/core/src/client.rs`
- `codex-rs/codex-api/src/requests/headers.rs`
- `codex-rs/protocol/src/openai_models.rs`

## Headless invocation

The supported non-interactive command is:

```powershell
codex exec --ephemeral --skip-git-repo-check --json "prompt"
```

`codex exec --help` confirms that `--json` emits JSONL events, including
`thread.started`, `turn.started`, `item.completed`, `error`, and
`turn.completed`.

## Provider configuration

Codex uses a Responses provider configured in the user-level TOML file:

```toml
model = "deepseek-chat"
model_provider = "deepfree"

[model_providers.deepfree]
name = "DeepFree local proxy"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = false
```

The provider base URL is used for:

```text
GET  /models
POST /responses
```

The proxy must return a native Codex catalog under `models`, not only an
OpenAI Chat Completions-style `data` array.

## Codex request body

`ResponsesApiRequest` is defined in
`codex-rs/codex-api/src/common.rs`:

```json
{
  "model": "deepseek-chat",
  "instructions": "...",
  "input": [],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": {},
  "store": false,
  "stream": true,
  "stream_options": null,
  "include": ["reasoning.encrypted_content"],
  "service_tier": null,
  "prompt_cache_key": "...",
  "text": {},
  "client_metadata": {}
}
```

Important details:

- `instructions` is a string and is omitted when empty.
- `input` is a full `ResponseItem` array, not just a plain string.
- `tools` contains raw Responses API tool definitions.
- `tool_choice` is normally `"auto"`.
- `parallel_tool_calls` is a boolean.
- `reasoning` carries effort/summary/context settings.
- `store` is normally `false`.
- `stream` is normally `true`.
- `include` normally requests `reasoning.encrypted_content`.
- `prompt_cache_key` and `client_metadata` may be present.

Codex builds this request in `core/src/client.rs::build_responses_request`.
For regular Responses API mode, the base system prompt is placed in
`instructions`, and the formatted conversation/tool items are placed in
`input`.

## Thread/session identity

Codex adds these headers from
`codex-rs/codex-api/src/requests/headers.rs`:

```http
session-id: <Codex session id>
thread-id: <Codex thread id>
```

The proxy must use `thread-id` as the primary conversation key. The same
Codex thread can issue multiple HTTP requests while sending the full input
history again. The proxy must not create a new DeepSeek Web session for every
request.

The proxy implementation stores:

```text
deepseek-session:<thread-id>
deepseek-session:<session-id>
deepseek-session:<response-id>
```

Each value contains the DeepSeek `chat_session_id`. The proxy uses the existing
DeepSeek session when any of those identifiers matches.

## Prompt handling

Codex may repeat the system/developer instructions and the complete input
history on every request. DeepSeek Web already stores the conversation server
side, so the proxy sends:

1. On the first request:

   ```text
   System: <instructions>

   <latest user prompt>
   ```

2. On continuation requests:

   ```text
   <latest user prompt>
   ```

The proxy deliberately does not resend the full Codex input history to
DeepSeek. It extracts the newest user item and relies on the DeepSeek session
for prior context.

## Model translation

Codex sends the catalog slug in `model`.

Current DeepSeek Web mapping:

| Codex model | DeepSeek `model_type` | `thinking_enabled` |
|---|---|---|
| `deepseek-chat` | `default` | `false` |
| `deepseek-reasoner` | `expert` | `true` |

Unknown model slugs currently use the chat/default behavior. This is a
deliberate safe fallback and should be changed to a `400` once the supported
model set is finalized.

## Expected SSE response

Codex's parser in `codex-rs/codex-api/src/sse/responses.rs` consumes these
events:

```text
response.created
response.output_item.added
response.content_part.added
response.output_text.delta
response.output_text.done
response.output_item.done
response.completed
```

For reasoning-capable models, Codex also recognizes reasoning events such as:

```text
response.reasoning_text.delta
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
```

The final event must be one of:

```text
response.completed
response.incomplete
response.failed
```

`response.completed` must include a parseable response object with at least:

```json
{
  "id": "resp_...",
  "object": "response",
  "status": "completed",
  "output": []
}
```

Codex treats a stream that closes before `response.completed` as an error.
There is no `data: [DONE]` terminator for Responses mode.

## DeepSeek Web v0 translation

DeepSeek Web v0 does not emit Responses events. It emits delta records with
persistent `p` and `o` fields:

```json
{"p":"response/fragments/-1/content","o":"APPEND","v":"thinking"}
{"p":"response/fragments","o":"APPEND","v":[
  {"type":"RESPONSE","content":"visible answer"}
]}
```

The proxy must:

- ignore `THINK` fragments;
- extract `RESPONSE` fragment content;
- preserve `p` and `o` across records;
- process `BATCH` records recursively;
- emit only visible answer text as `response.output_text.delta`;
- emit `response.output_text.done` with the accumulated answer;
- emit `response.output_item.done`;
- emit `response.completed` with the same accumulated answer in `output`.

## Model catalog

The durable native catalog is:

```text
C:\Users\Damas\.codex\models.json
```

`models_cache.json` is runtime cache and is not a durable configuration file.
The catalog entries must include valid Codex `ModelInfo` metadata, including:

- `slug`
- `display_name`
- `description`
- `default_reasoning_level`
- `supported_reasoning_levels`
- `shell_type`
- `visibility`
- `supported_in_api`
- `priority`
- `model_messages.instructions_template`
- `context_window`
- `truncation_policy`
- `input_modalities`

The proxy's `GET /v1/models` returns the same native metadata under `models`.

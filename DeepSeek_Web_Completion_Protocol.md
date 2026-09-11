# DeepSeek Web Completion Protocol

## Version

```text
contract_version = "1.0"
protocol_target = "DeepSeek Web Chat /api/v0/chat/completion"
runtime_reference = "Cloudflare Workers + TypeScript + Web Streams API"
evidence_basis = "checked-in HAR captures + current branch source; newest functional capture has precedence"
status = "wire-level implementation reference"
```

---

# 1. Purpose

This document is the completion-specific companion to `DeepSeek_Web_Endpoint_Contract.md`.

The existing endpoint contract establishes the completion request shape and the existence of the SSE stream. This document goes one layer deeper and defines how an implementation must interpret the stream byte-by-byte, convert SSE frames into DeepSeek events, interpret DeepSeek data patches, reconstruct the assistant response, and translate that reconstructed response into a web-client-facing streaming schema.

The important distinction is:

```text
HTTP response
    -> SSE framing
        -> DeepSeek event
            -> event-specific JSON
                -> data patch / response object
                    -> reconstructed assistant state
                        -> proxy/web-client schema
```

Do not collapse these layers. In particular:

```text
SSE `event:` is NOT the same thing as a DeepSeek `data.o` operation.
SSE `data:` is NOT automatically the final assistant text.
`response.content` is NOT safe to concatenate when `response.fragments` are present.
`thinking_enabled` is a request flag, NOT a response field containing reasoning.
```

---

# 2. Evidence precedence

Use the following evidence order when maintaining this protocol:

```text
1. Newest functional HAR capture with a successful completion stream
2. Other checked-in HAR captures containing completion traffic
3. Existing DeepSeek_Web_Endpoint_Contract.md sections 14-22
4. Current repository implementation in src/deepssek_completions/*
5. Current low-level protocol implementation in src/deepseek/*
```

The implementation may be newer or simpler than the captures. Source code therefore documents what this repository currently does, while HAR traffic documents what DeepSeek actually sent.

A statement marked `ESTABLISHED` below is directly visible in captured traffic or directly represented by the repository's current protocol types.

A statement marked `IMPLEMENTATION RULE` is the recommended parser behavior needed to safely consume the observed protocol.

A statement marked `NOT ESTABLISHED` must not be promoted to a hard wire contract without another capture.

---

# 3. Capture inventory used for completion analysis

The branch contains these HAR captures:

```text
V4-pro-plus-login.har
 dev-browser-20260910-001517.har
extensive_usage_network_test.har
reload_for_hif.har
retrieve_sessions_messages-history.har
```

They are not equivalent evidence sets.

```text
V4-pro-plus-login.har
    -> functional logged-in traffic
    -> contains a concrete completion SSE stream
    -> strongest directly inspectable example for event ordering and response deltas

extensive_usage_network_test.har
    -> broad network capture
    -> primary current-behavior evidence according to DeepSeek_Web_Endpoint_Contract.md

 dev-browser-20260910-001517.har
    -> browser/login/session/settings traffic
    -> useful for surrounding client state and current UI behavior

reload_for_hif.har
    -> HIF refresh/reload traffic
    -> useful for authentication/anti-abuse lifecycle, not the primary source for response parsing

retrieve_sessions_messages-history.har
    -> session/history/message retrieval traffic
    -> useful for persisted message objects versus the live completion stream
```

The completion SSE examples visible in the checked-in captures establish at least the following event sequence elements:

```text
event: ready

event: update_session
multiple event: data frames
...
event: update_session
possibly event: title
event: close
```

One captured stream has a final data patch setting:

```json
{
  "p": "response/status",
  "o": "SET",
  "v": "FINISHED"
}
```

and also contains a separate `title` event. Therefore completion finalization is represented in more than one protocol layer.

---

# 4. Completion HTTP request

```http
POST https://chat.deepseek.com/api/v0/chat/completion
Accept: text/event-stream
Content-Type: application/json
x-ds-pow-response: <solved-pow>
x-hif-leim: <opaque-hif-leim>
```

The current repository constructs these headers in:

```text
src/deepseek/headers.ts
  buildCompletionHeaders()
```

and sends the request in:

```text
src/deepseek/client.ts
  DeepSeekWebClient.complete()
```

The completion response must be treated as a streaming response. Do not call `response.json()` on it.

The current implementation deliberately returns the raw `Response` from `DeepSeekWebClient.complete()` and leaves SSE parsing to the caller.

---

# 5. Completion request body

The established wire body is:

```json
{
  "chat_session_id": "<string>",
  "parent_message_id": null,
  "model_type": null,
  "prompt": "<string>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

The current low-level request builder is:

```text
src/deepseek/completion.ts
  buildCompletionRequest()
```

The corresponding protocol types are in:

```text
src/deepseek/types.ts
  DeepSeekCompletionRequest
  DeepSeekConversationState
```

The OpenAI-compatibility layer translates its public request into this body in:

```text
src/deepssek_completions/request.ts
  translateToDeepSeekInput()
```

---

# 6. Completion response content type

The response is SSE (`text/event-stream`).

Do not assume one network read equals one event.

The browser may receive any of these cases:

```text
read #1 = half of `event: ready` line
read #2 = remainder of the line + data line
read #3 = several complete events
read #4 = only part of a JSON object
```

Therefore the parser MUST be incremental.

The current repository has an incremental parser in:

```text
src/deepssek_completions/sse.ts
  IncrementalSSEParser
```

This is the correct architectural location for framing logic.

---

# 7. SSE framing model

The outer stream uses normal Server-Sent Events framing.

Conceptually:

```text
event: <event-name>\n
data: <JSON-text>\n
\n
```

A blank line terminates the current SSE event.

A single event can therefore be modeled as:

```ts
interface SSEFrame {
  event: string;
  dataText: string;
}
```

The next layer is DeepSeek JSON parsing:

```ts
const frame: SSEFrame = readNextFrame(stream);
const data = JSON.parse(frame.dataText);
```

Only after that should event-specific interpretation occur.

---

# 8. SSE parser requirements

## 8.1 Preserve partial lines

A byte chunk is not a line boundary.

Incorrect:

```ts
for (const chunk of body) {
  parseSSE(chunk)
}
```

Correct:

```text
bytes
  -> TextDecoder(stream=true)
      -> persistent text buffer
          -> complete lines
              -> complete SSE frames
```

The parser must retain the final incomplete line between `parseChunk()` calls.

The current `IncrementalSSEParser` already follows this general design.

## 8.2 Decode UTF-8 incrementally

Use one persistent `TextDecoder` for the whole stream.

Preferred:

```ts
const decoder = new TextDecoder();
const text = decoder.decode(chunk, { stream: true });
```

Do not create a new decoder for every chunk when arbitrary UTF-8 characters can cross chunk boundaries.

The current implementation creates a decoder inside `parseChunk()`. That is safe for ASCII-only test traffic but should be changed to a persistent decoder for a production-grade parser.

## 8.3 Handle both LF and CRLF

A robust SSE parser should accept:

```text
\n
\r\n
```

The captured streams are line-oriented and commonly represented with `\n`, but the parser should not rely on a single newline convention.

## 8.4 Blank line terminates the event

Do not wait for `event: close` to flush buffered data.

Any blank line following a `data:` field may complete an SSE event.

## 8.5 Unknown fields must not corrupt parsing

The framing parser should safely ignore fields it does not use, for example:

```text
id:
retry:
:
```

The important rule is that an unknown line must not be treated as response content.

## 8.6 Multiple `data:` lines

SSE permits multiple `data:` lines in one event. The framing parser should join them according to SSE rules before JSON parsing.

The current DeepSeek captures show a single JSON payload per event, so multiple `data:` lines are not the normal DeepSeek representation, but supporting them makes the parser correctly layered and future-safe.

---

# 9. DeepSeek event taxonomy

Observed event names are:

```text
ready
update_session
data
close
```

A `title` event is also present in the captured functional stream.

Therefore the actual implementation should treat event names as extensible strings, not as a closed enum that rejects unknown events.

Recommended internal type:

```ts
interface DeepSeekSSEEvent<T = unknown> {
  event: string;
  data: T;
}
```

The event name determines the meaning of the JSON payload.

---

# 10. `ready` event

## 10.1 Wire format

```text
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"expert"}
```

Equivalent TypeScript shape:

```ts
interface ReadyEvent {
  request_message_id: number;
  response_message_id: number;
  model_type: string | null;
}
```

## 10.2 Semantics

`ready` is the authoritative response identity event for the completion.

It establishes:

```text
request_message_id
response_message_id
server-resolved model_type
```

The most important field for conversation continuation is:

```text
ready.data.response_message_id
```

The next turn must use that number as `parent_message_id`.

## 10.3 Model resolution

Do not derive the server model solely from the public client request.

Use:

```text
ready.data.model_type
```

when present.

For example:

```text
request model_type = null
server ready.model_type = default/current default path
```

or historically:

```text
request model_type = "expert"
server ready.model_type = "expert"
```

---

# 11. `update_session` event

Observed form:

```text
event: update_session
data: {"updated_at":1789000146.151181}
```

Type:

```ts
interface UpdateSessionEvent {
  updated_at: number;
}
```

This event is session metadata, not assistant content.

Do not emit it as a text delta.

A proxy may ignore it for an OpenAI-style response while still preserving it internally for a future stateful implementation.

---

# 12. `title` event

A captured completion stream contains:

```text
event: title
data: {"content":"V4 Pro greeting"}
```

This is not the assistant message body.

A web client may use it to update the conversation title, but an OpenAI-style completion translator should not place it into `choices[].delta.content`.

Unknown event names such as `title` must therefore be safely ignored by the content extractor while remaining visible to protocol diagnostics.

---

# 13. `close` event

The completion stream terminates with a `close` event.

The captured stream contains a payload of the form:

```json
{
  "click_behavior": "none",
  "auto_resume": false
}
```

The exact close payload is metadata. The event itself is the stream-level completion signal.

Do not manufacture assistant text from the `close` payload.

For an OpenAI-compatible translator, `close` is the natural point to emit:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {},
      "finish_reason": "stop"
    }
  ]
}
```

followed by:

```text
data: [DONE]

```

provided that the upstream stream has actually completed normally.

---

# 14. `data` event: the actual response payload

`data` events carry the evolving response state.

The current repository models the outer structure as:

```ts
interface DataEvent {
  v: {
    response?: {
      message_id: number;
      parent_id: number;
      role: string;
      fragments?: DataEventFragment[];
      content?: string;
    };
  };
}
```

This is an important distinction:

```text
event.data
    -> { v: ... }
        -> response
            -> fragments / content
```

Do not parse `event.data` as though `p`, `o`, and `v` always exist at the top level.

The repository's observed patch representation also uses `p/o/v`; these forms occur at different points in the live protocol and must be handled without conflating them.

---

# 15. Patch envelope: `p`, `o`, `v`

Observed patch form:

```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": "text"
}
```

Fields:

```text
p = protocol path into the evolving response state
o = operation
v = operation value
```

Observed operation names:

```text
SET
APPEND
BATCH
```

Treat this as a DeepSeek application-level patch protocol layered inside SSE.

It is NOT JSON Patch RFC 6902.

---

# 16. Meaning of `p`

`p` is a DeepSeek path into the logical response object.

Important observed path:

```text
response/fragments/-1/content
```

Another observed finalization path is:

```text
response/status
```

An observed root fragment path is:

```text
response/fragments
```

The `-1` segment is protocol-specific.

Do not treat it as a normal RFC 6901/JSON Pointer array index. In DeepSeek completion traffic it identifies the currently active/latest response fragment used by incremental output patches.

Implementation rule:

```ts
if (path segment === '-1' && parent is a response fragment array) {
  resolve to the currently active/latest fragment;
}
```

Do not silently interpret `-1` as array index `length - 1` unless the surrounding response state actually contains a fragment array and the protocol operation requires the current fragment.

---

# 17. `APPEND`

Observed content delta:

```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": "!"
}
```

Then another event may contain:

```json
{
  "v": " I"
}
```

followed by another content append.

For string content, `APPEND` means:

```text
state[path] = String(state[path] ?? '') + String(v)
```

Example:

```text
previous content = "Hello"
APPEND " world"
APPEND "!"
result = "Hello world!"
```

This is the primary streaming text operation.

---

# 18. `SET`

Observed finalization example:

```json
{
  "p": "response/status",
  "o": "SET",
  "v": "FINISHED"
}
```

For `SET`:

```text
state[path] = v
```

Do not concatenate `SET` values.

`SET` is appropriate for metadata/state fields such as:

```text
response/status
```

and may also occur on content-like paths in other UI states. Always honor the path and replace the current value rather than append.

---

# 19. `BATCH`

`BATCH` is an observed operation name, but the checked-in contract does not establish a universal nested schema sufficiently well to treat one inferred representation as authoritative.

Therefore the parser must preserve the operation rather than silently dropping it.

Recommended representation:

```ts
interface DeepSeekPatch {
  p?: string;
  o?: 'SET' | 'APPEND' | 'BATCH' | string;
  v?: unknown;
}
```

Implementation rule:

```text
If o === "BATCH":
    inspect v structurally
    if v is an array of patch-like objects:
        apply each patch in order
    otherwise:
        preserve the batch as an unhandled protocol event
```

Do NOT convert `BATCH` into text automatically.

A future capture that exposes the exact nested batch shape should extend this section with the observed structure rather than guessing it.

---

# 20. Root fragment creation

The captured protocol also contains an append operation against:

```text
response/fragments
```

whose value is an array of fragment objects. A captured example begins with:

```json
{
  "p": "response/fragments",
  "o": "APPEND",
  "v": [
    {
      "id": 3,
      "type": "RESPONSE",
      "content": "..."
    }
  ]
}
```

This establishes an important ordering rule:

```text
1. A response fragment can be created/added.
2. Later APPEND operations can target response/fragments/-1/content.
3. The active fragment is therefore stateful across events.
```

A stateless extractor that only looks at one `data` event at a time can miss this relationship.

---

# 21. Response object versus patch object

The protocol exposes two related but different representations.

## Representation A: response object

Conceptually:

```json
{
  "v": {
    "response": {
      "message_id": 2,
      "parent_id": 1,
      "role": "assistant",
      "fragments": [
        {
          "id": 3,
          "type": "RESPONSE",
          "content": "..."
        }
      ]
    }
  }
}
```

## Representation B: incremental patch

```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": "..."
}
```

These representations can appear in the same completion stream.

A correct translator must handle both rather than choosing one and ignoring the other.

---

# 22. Why `response.content` must not be blindly concatenated

The current repository code explicitly uses:

```text
prefer fragments[].v over response.content
```

The reason is duplication risk.

When a response object already contains the accumulated content and a fragment also carries the incremental content, doing both:

```ts
fullContent += response.content;
fullContent += fragment.v;
```

will duplicate previously received text.

The current implementation therefore uses this rule:

```text
if fragments exist:
    consume fragment operations
else if direct response.content exists:
    consume response.content as fallback
```

This is the correct direction, but it still needs path-aware and operation-aware extraction for full protocol fidelity.

---

# 23. Reasoning / thinking output

## 23.1 Request-side fact

The completion request has:

```json
{
  "thinking_enabled": true
}
```

as an independent boolean field.

This only means that the request asks the server to enable the thinking feature.

It does NOT prove that the response contains a top-level field called:

```text
reasoning_content
```

or:

```text
thinking_content
```

No such literal field is established by the checked-in completion contract.

## 23.2 Do not invent a reasoning key

The current captures and repository types do not establish a universal JSON field named `reasoning_content`.

Therefore this is WRONG as a protocol implementation:

```ts
const reasoning = data.reasoning_content;
```

unless a future capture directly demonstrates that field.

## 23.3 Correct extraction strategy

Reasoning must be treated as a property of the reconstructed response state, not as a hard-coded top-level JSON field.

The extractor should inspect each response fragment:

```text
fragment.id
fragment.type
fragment.content
other fragment metadata
```

and preserve any fragment that is not ordinary visible `RESPONSE` content.

A safe normalized state is:

```ts
interface ReconstructedCompletion {
  responseMessageId: number | null;
  modelType: string | null;
  visibleContent: string;
  reasoningContent: string;
  rawFragments: unknown[];
  status: string | null;
}
```

Then apply this policy:

```text
fragment representing ordinary assistant response
    -> visibleContent

fragment explicitly identified by a future capture as reasoning/thinking
    -> reasoningContent

unknown fragment type
    -> rawFragments; do not discard
```

## 23.4 Current repository limitation

`src/deepssek_completions/sse.ts` currently extracts only:

```text
APPEND + string v
```

without checking the patch path or fragment type.

Therefore the current code can accidentally classify a non-visible text fragment as ordinary assistant content if DeepSeek later exposes reasoning as a separate fragment type.

This document intentionally keeps the wire contract stricter than the current implementation.

---

# 24. Reasoning-to-web-client translation

Do not translate an unverified DeepSeek reasoning representation into a guessed client field.

The translation layer should first produce an internal representation:

```ts
interface NormalizedDeepSeekOutput {
  id: number | null;
  model: string | null;
  contentDelta?: string;
  reasoningDelta?: string;
  finishReason?: string | null;
  status?: string | null;
}
```

Then map that internal representation to the target web-client schema.

For an OpenAI-compatible streaming client, the currently implemented mapping is:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {
        "content": "text"
      },
      "finish_reason": null
    }
  ]
}
```

Reasoning should only be added to the target schema when the target schema explicitly supports it and the DeepSeek source fragment has been positively classified as reasoning.

---

# 25. Conversation identity and continuation

The completion protocol is stateful even when the outer proxy is stateless.

The DeepSeek-side identity chain is:

```text
chat_session_id
      |
      +--> request_message_id
              |
              +--> ready.response_message_id
                          |
                          +--> next.parent_message_id
```

The critical invariant is:

```text
next.parent_message_id === previous.ready.response_message_id
```

A proxy that creates a new DeepSeek session for every external request is intentionally not maintaining multi-turn DeepSeek conversation state.

That is the current behavior of `CompletionService.processCompletion()`.

---

# 26. Current repository translation path

The current proxy flow is:

```text
POST /v1/chat/completions
        |
        v
validate OpenAI request
        |
        v
extractLatestUserPrompt()
        |
        v
create new DeepSeek session
        |
        v
translateToDeepSeekInput()
        |
        v
DeepSeekWebClient.complete()
        |
        v
DeepSeek SSE stream
        |
        v
IncrementalSSEParser
        |
        v
extract content / model metadata
        |
        v
OpenAI-compatible SSE response
```

The relevant files are:

```text
src/index.ts
src/deepssek_completions/request.ts
src/deepssek_completions/sse.ts
src/deepssek_completions/service.ts
src/deepssek_completions/types.ts
src/deepseek/client.ts
src/deepseek/completion.ts
src/deepseek/types.ts
src/deepseek/headers.ts
```

---

# 27. Current request translation

The public request currently accepts only:

```json
{
  "model": "string",
  "messages": [
    {
      "role": "system|user|assistant",
      "content": "string"
    }
  ],
  "stream": true
}
```

`translateToDeepSeekInput()` currently sets:

```json
{
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

The current public layer therefore does NOT expose reasoning/thinking as a client option even though the underlying DeepSeek wire protocol has `thinking_enabled`.

That is a product-layer limitation, not a DeepSeek wire limitation.

---

# 28. Current model mapping

The current completion service maps:

```text
deepseek-reasoner -> expert
deepseek-chat     -> null
dummy/other       -> null
expert            -> expert
```

The server's `ready.model_type` should still be treated as authoritative for the actual completion result.

This distinction matters because:

```text
public request model name
    != necessarily
raw DeepSeek model_type
```

---

# 29. Streaming translation to the web client

The current implementation emits an OpenAI-compatible SSE stream.

First visible content produces a role chunk:

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion.chunk",
  "created": 0,
  "model": "<server-model-or-request-model>",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant"
      },
      "finish_reason": null
    }
  ]
}
```

Then each extracted content delta becomes:

```json
{
  "id": "chatcmpl-<uuid>",
  "object": "chat.completion.chunk",
  "created": 0,
  "model": "<server-model-or-request-model>",
  "choices": [
    {
      "index": 0,
      "delta": {
        "content": "<delta>"
      },
      "finish_reason": null
    }
  ]
}
```

On normal close:

```json
{
  "choices": [
    {
      "index": 0,
      "delta": {},
      "finish_reason": "stop"
    }
  ]
}
```

then:

```text
data: [DONE]

```

These are proxy output semantics, not DeepSeek wire events.

---

# 30. Critical parser bug in the current implementation

`src/deepssek_completions/service.ts` creates a new `IncrementalSSEParser` inside every `TransformStream.transform()` call:

```ts
transform: (chunk, controller) => {
  const parser = new IncrementalSSEParser()
  const events = parser.parseChunk(chunk)
}
```

This breaks the intended incremental parser contract because incomplete data from one network chunk cannot survive into the next parser instance.

Correct pattern:

```ts
const parser = new IncrementalSSEParser()

const openaiStream = deepSeekBody.pipeThrough(
  new TransformStream({
    transform(chunk, controller) {
      const events = parser.parseChunk(chunk)
      // process events
    },
    flush(controller) {
      const events = parser.finalize()
      // process remaining event(s)
    }
  })
)
```

The parser object must live for the whole response stream.

This is a correctness requirement, not an optimization.

---

# 31. Critical UTF-8 issue in the current parser

`IncrementalSSEParser.parseChunk()` creates a new `TextDecoder` every time.

Current pattern:

```ts
const decoder = new TextDecoder()
this.buffer += decoder.decode(chunk, { stream: true })
```

A production implementation should instead keep the decoder on the parser instance:

```ts
class IncrementalSSEParser {
  private readonly decoder = new TextDecoder()
  private buffer = ''
}
```

and flush it during `finalize()`:

```ts
this.buffer += this.decoder.decode()
```

Otherwise a multi-byte UTF-8 sequence split between network chunks can be decoded incorrectly.

---

# 32. Critical SSE syntax limitation in the current parser

The current parser recognizes only:

```text
event: <value>
data: <value>
```

and otherwise ignores the line.

That is sufficient for the observed happy-path DeepSeek stream, but a complete SSE implementation should:

```text
accept event fields without requiring exactly one space
join multiple data lines
handle CRLF
ignore comment/heartbeat lines
preserve unknown SSE fields
flush a final unterminated event
```

The DeepSeek protocol may currently emit a simple subset, but the framing layer should remain correct independently of current server behavior.

---

# 33. Correct incremental SSE parser reference

The following is the recommended parser shape for this repository:

```ts
export interface ParsedSSEEvent {
  event: string
  data: string
}

export class IncrementalSSEParser {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private eventName: string | undefined
  private dataLines: string[] = []

  push(chunk: Uint8Array): ParsedSSEEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  finish(): ParsedSSEEvent[] {
    this.buffer += this.decoder.decode()

    const events = this.drain(true)

    if (this.eventName !== undefined || this.dataLines.length > 0) {
      const event = this.emitEvent()
      if (event) events.push(event)
    }

    return events
  }

  private drain(flush: boolean): ParsedSSEEvent[] {
    const out: ParsedSSEEvent[] = []

    while (true) {
      const newline = this.findLineEnd()
      if (newline < 0) break

      const raw = this.buffer.slice(0, newline.index)
      this.buffer = this.buffer.slice(newline.nextOffset)

      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

      if (line === '') {
        const event = this.emitEvent()
        if (event) out.push(event)
        continue
      }

      if (line.startsWith(':')) continue

      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      if (field === 'event') {
        this.eventName = value
      } else if (field === 'data') {
        this.dataLines.push(value)
      }
    }

    if (flush && this.buffer.length > 0) {
      const line = this.buffer.endsWith('\r')
        ? this.buffer.slice(0, -1)
        : this.buffer
      this.buffer = ''

      if (line.startsWith('event:')) {
        this.eventName = line.slice(6).trimStart()
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice(5).trimStart())
      }
    }

    return out
  }

  private emitEvent(): ParsedSSEEvent | null {
    if (this.dataLines.length === 0) {
      this.eventName = undefined
      return null
    }

    const event: ParsedSSEEvent = {
      event: this.eventName ?? 'message',
      data: this.dataLines.join('\n'),
    }

    this.eventName = undefined
    this.dataLines = []
    return event
  }

  private findLineEnd(): { index: number; nextOffset: number } | null {
    const lf = this.buffer.indexOf('\n')
    if (lf < 0) return null
    return { index: lf, nextOffset: lf + 1 }
  }
}
```

The core requirement is persistence of parser state across every `ReadableStream` chunk.

---

# 34. DeepSeek event dispatcher

After framing, use a dispatcher like:

```ts
for (const frame of parser.push(chunk)) {
  let payload: unknown

  try {
    payload = JSON.parse(frame.data)
  } catch (error) {
    recordProtocolError('invalid_json', frame, error)
    continue
  }

  switch (frame.event) {
    case 'ready':
      handleReady(payload)
      break

    case 'update_session':
      handleUpdateSession(payload)
      break

    case 'data':
      handleData(payload)
      break

    case 'close':
      handleClose(payload)
      break

    default:
      handleUnknownEvent(frame.event, payload)
      break
  }
}
```

Unknown DeepSeek event names should not terminate a successful completion unless the server explicitly indicates an error.

---

# 35. Reconstructing response state

A robust translator should maintain state for the lifetime of one completion:

```ts
interface CompletionState {
  requestMessageId: number | null
  responseMessageId: number | null
  modelType: string | null

  response: {
    messageId: number | null
    parentId: number | null
    role: string | null
    status: string | null
  }

  fragments: Array<{
    id?: number
    type?: string
    content: string
    [key: string]: unknown
  }>

  title: string | null

  visibleContent: string
  reasoningContent: string

  sawReady: boolean
  sawClose: boolean
}
```

Initialize once per completion; never once per network chunk.

---

# 36. Applying a path-aware patch

Conceptually:

```ts
function applyPatch(state: CompletionState, patch: DeepSeekPatch) {
  if (!patch.o) return

  switch (patch.o) {
    case 'SET':
      setPath(state, patch.p, patch.v)
      return

    case 'APPEND':
      appendPath(state, patch.p, patch.v)
      return

    case 'BATCH':
      for (const nested of normalizeBatch(patch.v)) {
        applyPatch(state, nested)
      }
      return

    default:
      recordProtocolWarning('unknown_operation', patch)
  }
}
```

The important design point is that patch application occurs before final text extraction.

---

# 37. Content extraction algorithm

Use this order:

```text
1. Process all explicit fragments/patches.
2. Track fragment identity and type.
3. Apply APPEND/SET semantics to the relevant state path.
4. Identify the visible response fragment(s).
5. Emit only the newly appended visible text as contentDelta.
6. Preserve non-visible fragment text separately.
7. Never emit accumulated content twice.
```

For the currently established visible response path:

```text
response/fragments/-1/content
```

an `APPEND` string is a content delta.

---

# 38. Avoiding duplicate deltas

Bad:

```ts
if (response.content) emit(response.content)
if (fragment.v) emit(fragment.v)
```

Good:

```ts
if (fragmentPatchIsAuthoritativeForContent(patch)) {
  emitDelta(patch.v)
} else if (!response.fragments?.length && response.content) {
  emitDelta(response.content)
}
```

Even better:

```text
emit deltas at patch-application time
```

and never re-emit an already materialized response snapshot.

---

# 39. Finalization rules

There are multiple completion-complete signals in the protocol:

```text
response/status = FINISHED
close event
```

The translator should use them as complementary signals:

```text
FINISHED patch
    -> upstream response state is complete

close event
    -> stream-level termination
```

Normal completion policy:

```text
if content was emitted:
    emit final web-client finish chunk on close

then emit [DONE]
```

If the stream terminates unexpectedly without `close`, the implementation must not silently claim a successful stop if the caller can distinguish cancellation/error from normal completion.

---

# 40. Error handling

Different failure classes must remain distinguishable:

```text
HTTP failure
SSE framing failure
SSE JSON parsing failure
DeepSeek protocol/event failure
DeepSeek model/HIF rejection
upstream stream cancellation
normal close
```

Examples:

```text
HTTP 4xx/5xx
    -> completion request failed before a valid stream existed

invalid JSON in `data:`
    -> malformed protocol frame

unknown event name
    -> usually non-fatal; preserve for diagnostics

missing ready event
    -> protocol anomaly; continuation identity/model may be unavailable

stream ends before close
    -> incomplete completion unless another authoritative terminal signal exists
```

Do not convert parser failures into empty assistant content.

---

# 41. Non-streaming translation

For `stream=false`, the proxy must still consume the complete DeepSeek SSE stream.

The correct algorithm is:

```text
consume all SSE frames
    |
    +--> remember ready.model_type
    +--> apply all data patches
    +--> collect final visible content
    +--> observe status/close
    |
    v
build one JSON completion response
```

Do not attempt to call the DeepSeek completion endpoint differently merely because the external client requested non-streaming output.

The current `CompletionService.createNonStreamingResponse()` follows this architecture but currently extracts only ordinary text content.

---

# 42. Current source-code references

## Low-level DeepSeek protocol

```text
src/deepseek/completion.ts
    buildCompletionRequest()

src/deepseek/client.ts
    DeepSeekWebClient.complete()
    -> creates HIF/PoW headers
    -> POSTs /api/v0/chat/completion
    -> returns raw Response

src/deepseek/headers.ts
    buildCompletionHeaders()

src/deepseek/types.ts
    DeepSeekCompletionRequest
    DeepSeekConversationState
```

## Public compatibility layer

```text
src/deepssek_completions/request.ts
    validateCompletionRequest()
    extractLatestUserPrompt()
    translateToDeepSeekInput()

src/deepssek_completions/sse.ts
    IncrementalSSEParser
    parseSSELine()
    parseSSEEvents()
    extractResponseMessageId()
    extractContentDeltas()

src/deepssek_completions/service.ts
    CompletionService.processCompletion()
    createStreamingResponse()
    createNonStreamingResponse()
    mapModelToDeepSeek()
```

Repository links:

```text
DeepSeek_Web_Endpoint_Contract.md
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/DeepSeek_Web_Endpoint_Contract.md

src/deepseek/client.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepseek/client.ts

src/deepseek/completion.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepseek/completion.ts

src/deepseek/headers.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepseek/headers.ts

src/deepseek/types.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepseek/types.ts

src/deepssek_completions/sse.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepssek_completions/sse.ts

src/deepssek_completions/service.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepssek_completions/service.ts

src/deepssek_completions/request.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepssek_completions/request.ts

src/deepssek_completions/types.ts
https://github.com/byLasri/codeep-proxy/blob/qwen-code-ae7eb2fe-381a-4c58-9a82-31df210021c6/src/deepssek_completions/types.ts
```

---

# 43. Current implementation gaps

The repository's current basic completion implementation is intentionally lightweight, but the following are protocol-correctness gaps rather than optional architecture work:

```text
1. IncrementalSSEParser is recreated per network chunk in service.ts.
   -> partial SSE frames can be lost.

2. TextDecoder is recreated per parseChunk() call.
   -> multi-byte UTF-8 boundaries are not handled robustly.

3. Fragment extraction looks primarily at `o === APPEND` and string `v`.
   -> patch path is not checked.

4. `SET` and `BATCH` are modeled but not applied by the public extractor.
   -> response reconstruction is incomplete.

5. `response.content` fallback is useful but not a complete state reconstruction.

6. No explicit reasoning/thinking fragment classification exists.
   -> thinking_enabled is currently request-only in the public layer.

7. Unknown DeepSeek events are skipped at the translation layer.
   -> diagnostics should preserve them without exposing them as content.

8. The service uses `close` as a stop signal and also flushes a synthetic final chunk.
   -> the finalization path should avoid double-finalization if both close and stream flush run.

9. Ready/model metadata and response-message identity are parsed, but the stateless public service does not persist them for a future turn.
```

These gaps can be fixed without introducing Durable Objects, message tracking databases, or other state machinery. They are local stream-processing concerns.

---

# 44. Conformance test cases

A protocol implementation should pass these cases before being considered completion-compatible.

## Test A: event split across network chunks

Input chunks:

```text
chunk1 = "event: re"
chunk2 = "ady\\ndata: {\"response_message_id\":2,"
chunk3 = "\"model_type\":\"expert\"}\n\n"
```

Expected:

```json
{
  "event": "ready",
  "data": {
    "response_message_id": 2,
    "model_type": "expert"
  }
}
```

## Test B: UTF-8 split across chunks

The parser must preserve a Unicode character whose UTF-8 bytes are split between chunks.

Expected: reconstructed JSON/string is identical to the original payload.

## Test C: content append

```json
{"p":"response/fragments/-1/content","o":"APPEND","v":"Hello"}
{"p":"response/fragments/-1/content","o":"APPEND","v":" world"}
```

Expected:

```text
visibleContent = "Hello world"
content deltas = ["Hello", " world"]
```

## Test D: status set

```json
{"p":"response/status","o":"SET","v":"FINISHED"}
```

Expected:

```text
status = "FINISHED"
content unchanged
```

## Test E: title event

```text
event: title
data: {"content":"Example"}
```

Expected:

```text
title = "Example"
visibleContent unchanged
```

## Test F: close event

Expected:

```text
sawClose = true
emit final web-client finish signal once
```

## Test G: direct response.content fallback

Given a `data` event with no `fragments` but a string `response.content`, consume that content once.

## Test H: fragments take precedence

Given both:

```text
response.fragments = [...] 
response.content = "already accumulated text"
```

do not emit `response.content` as another delta.

## Test I: unknown event

```text
event: title
```

must not terminate the stream or become assistant text.

## Test J: incomplete final event

A valid event without a trailing blank line should be emitted by `finish()` if its frame is complete enough to parse.

---

# 45. Recommended final architecture

For this repository's current scope, the protocol implementation does not need a durable state engine.

The minimal correct architecture is:

```text
one external /v1/chat/completions request
        |
        +--> one DeepSeek session
        |
        +--> one DeepSeek completion Response
                    |
                    v
             one persistent SSE parser
                    |
                    v
             one completion state
                    |
        +-----------+-----------+
        |                       |
        v                       v
 visible content           metadata/reasoning
        |                       |
        +-----------+-----------+
                    v
          one web-client translator
```

No message database is required to solve the immediate wire-format problem.

No Durable Object is required to solve the immediate stream-parsing problem.

No cross-request tracking is required to correctly parse one completion stream.

Those are separate future concerns.

---

# 46. Conformance rules summary

```text
MUST
----
POST /api/v0/chat/completion with Accept: text/event-stream.
Maintain one SSE parser for the entire response stream.
Maintain one completion state for the entire response stream.
Treat ready as response identity/model metadata.
Use ready.response_message_id for future continuation.
Parse event:data JSON before interpreting DeepSeek fields.
Honor p/o/v operations when reconstructing response state.
Prefer fragment operations over accumulated response.content.
Treat response/fragments/-1/content as a protocol-specific active-fragment path.
Treat close as a stream-level terminal signal.
Preserve unknown events for diagnostics instead of treating them as content.

MUST NOT
--------
Assume one fetch chunk equals one SSE event.
Parse the response as one JSON document.
Concatenate response.content and fragment deltas blindly.
Treat thinking_enabled as proof of a response reasoning_content field.
Assume BATCH has an invented schema without capture evidence.
Treat -1 as a normal JSON array index without checking protocol context.
Convert title/update_session metadata into assistant text.
Emit [DONE] merely because the network socket closed unexpectedly.

SHOULD
------
Use a persistent TextDecoder.
Support LF and CRLF.
Support multiple data lines per SSE event.
Keep raw unknown events for diagnostics.
Keep raw fragment objects so newly observed reasoning/tool fragment types can be mapped later.
Separate DeepSeek wire state from the target web-client schema.
```

---

# 47. Relationship to `DeepSeek_Web_Endpoint_Contract.md`

The existing contract sections 14-22 remain the authoritative high-level completion contract:

```text
14. Completion endpoint
15. Completion request schema
16. Conversation continuation
17. SSE response
18. Ready event
19. Content delta protocol
20. Model/product mapping
21. Reasoning/search/model matrix
22. Current model configuration
```

This document deliberately does not replace those sections.

Instead:

```text
DeepSeek_Web_Endpoint_Contract.md
    = endpoint and field-level contract

DeepSeek_Web_Completion_Protocol.md
    = stream framing + event semantics + reconstruction + translation contract
```

Together they define the completion protocol from HTTP request through the final web-client delta.

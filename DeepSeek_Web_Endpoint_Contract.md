# DeepSeek Web Endpoint Contract — Bible v1

## Purpose

This document defines the technical contract that `codeep-proxy` must maintain with the DeepSeek web application backend.

It is based on:

1. Direct inspection of the DeepSeek browser HAR captures.
2. The V4-Flash/default capture.
3. The V4-Pro capture.
4. The current `codeep-proxy` implementation.
5. The existing `current_diagnose.md` investigation.

The objective is to establish one stable protocol specification before further implementation work.

This document intentionally distinguishes:

- **Observed** — directly demonstrated by captured browser traffic.
- **Established** — sufficiently demonstrated to implement against.
- **Unknown** — not yet proven and must not be guessed.
- **Proxy-defined** — behavior belonging to `codeep-proxy`, not DeepSeek.

---

# 1. High-level architecture

The DeepSeek web application is not talking to a conventional OpenAI-compatible `/chat/completions` API.

The actual architecture is approximately:

```text
Client / Browser
       |
       v
codeep-proxy
       |
       |  DeepSeek Web Protocol
       v
chat.deepseek.com
       |
       +--> authentication/session
       |
       +--> chat session
       |
       +--> PoW challenge
       |
       +--> completion SSE
       |
       +--> message tree
       |
       +--> model/mode selection
       |
       +--> optional search
```

The central DeepSeek completion endpoint is:

```text
POST /api/v0/chat/completion
```

It is an SSE endpoint rather than a normal JSON completion endpoint.

---

# 2. The DeepSeek protocol has five important state domains

The complete contract should be understood as five separate state machines.

```text
1. Authentication state
2. Chat-session state
3. Message-chain state
4. Model/mode state
5. Request/response transport state
```

They must not be conflated.

---

# 3. Authentication contract

The browser communicates with:

```text
https://chat.deepseek.com
```

The captured browser traffic uses normal DeepSeek web authentication and subsequently sends authorization/session information with API requests.

The browser also sends client-identification headers including:

```text
x-client-bundle-id
x-client-platform
x-client-version
x-client-locale
x-client-timezone-offset
```

The current browser capture identifies the web client approximately as:

```text
bundle:   com.deepseek.chat
platform: web
version:  2.4.0
locale:   en_US
```

These are part of the observed web-client contract.

The proxy currently reproduces most of these headers.

---

# 4. Authentication is not the same thing as chat continuity

This distinction is fundamental.

```text
Authentication
    |
    +--> proves/identifies the DeepSeek account/session

Chat session
    |
    +--> identifies one conversation

Message ID
    |
    +--> identifies the current point in that conversation
```

Therefore:

```text
same authentication != same conversation
```

and:

```text
same chat_session_id != sufficient continuation state
```

The conversation additionally requires the current message-chain position.

---

# 5. Chat-session creation

The browser creates a conversation through:

```http
POST /api/v0/chat_session/create
```

with an empty JSON body:

```json
{}
```

The response contains a chat-session object.

Important fields observed include:

```text
id
seq_id
agent
model_type
current_message_id
ttl_seconds
```

The important value for subsequent completion calls is:

```text
chat_session.id
```

The captured session metadata showed:

```text
current_message_id = null
```

at creation time.

The captured TTL was:

```text
259200 seconds
```

which is three days.

Therefore the proxy must treat DeepSeek sessions as expiring server-side objects rather than permanent conversation IDs.

---

# 6. Chat session is the conversation container

The DeepSeek completion request contains:

```json
{
  "chat_session_id": "<uuid>"
}
```

This value remains constant across multiple turns of one browser conversation.

Example conceptual sequence:

```text
turn 1:
chat_session_id = A

turn 2:
chat_session_id = A

turn 3:
chat_session_id = A

turn 4:
chat_session_id = A
```

A new conversation receives another session ID.

Therefore:

```text
chat_session_id = conversation container
```

---

# 7. Message-chain state

DeepSeek additionally uses:

```json
"parent_message_id": ...
```

This is separate from `chat_session_id`.

First message:

```json
"parent_message_id": null
```

Subsequent message:

```json
"parent_message_id": <previous response_message_id>
```

Therefore the minimum continuation state is:

```text
DeepSeekConversationState
{
    chat_session_id,
    parent_message_id
}
```

where:

```text
parent_message_id
=
latest successful assistant response message ID
```

---

# 8. The message tree model

DeepSeek should be thought of as maintaining a message tree.

Conceptually:

```text
session A
   |
   +-- message 1 (user)
          |
          +-- message 2 (assistant)
                 |
                 +-- message 3 (user)
                        |
                        +-- message 4 (assistant)
                               |
                               +-- message 5 (user)
                                      |
                                      +-- message 6 (assistant)
```

The next user message attaches to:

```text
parent_message_id = 6
```

This is why merely preserving the session UUID is insufficient.

---

# 9. Completion endpoint

The primary endpoint is:

```http
POST /api/v0/chat/completion
```

The response is:

```http
Content-Type: text/event-stream
```

not ordinary JSON.

The request body contains the following established fields:

```json
{
  "chat_session_id": "...",
  "parent_message_id": null,
  "model_type": null,
  "prompt": "...",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

This is the core DeepSeek Web Chat completion contract.

---

# 10. Request field contract

## `chat_session_id`

Type:

```text
string
```

Purpose:

```text
identifies the DeepSeek conversation
```

Required for normal completion.

---

## `parent_message_id`

Type:

```text
number | null
```

First request:

```text
null
```

Later requests:

```text
previous response_message_id
```

Important:

```text
DO NOT serialize this as a string.
```

Correct:

```json
"parent_message_id": 4
```

Incorrect:

```json
"parent_message_id": "4"
```

The current proxy has already corrected this type.

---

## `model_type`

Observed values include:

```text
null / default
expert
```

The browser's default/V4-Flash path sends:

```json
"model_type": null
```

and the server identifies it as:

```text
default
```

The V4-Pro capture establishes the corresponding expert path.

Therefore the proxy abstraction is:

```text
DeepSeek default
    -> model_type = null/default

DeepSeek Pro
    -> model_type = expert
```

The exact UI model names are a client-level abstraction and should not be confused with the backend value.

---

# 11. V4-Flash contract

For the V4-Flash/default path:

```text
model_type = null
```

The browser then controls reasoning behavior through:

```text
thinking_enabled
```

Therefore:

```text
V4-Flash + no thinking
    model_type = null
    thinking_enabled = false
```

and:

```text
V4-Flash + thinking
    model_type = null
    thinking_enabled = true
```

The server reports the model as:

```text
default
```

in the response metadata.

---

# 12. V4-Pro contract

The V4-Pro browser capture establishes that Pro is represented at the DeepSeek protocol layer by the expert model path.

Conceptually:

```text
V4-Pro
    |
    v
model_type = expert
```

Reasoning remains an independent dimension:

```text
V4-Pro + non-thinking
    model_type = expert
    thinking_enabled = false
```

versus:

```text
V4-Pro + thinking
    model_type = expert
    thinking_enabled = true
```

This is important.

The protocol does not need four independent backend model identifiers for:

```text
Flash no-think
Flash think
Pro no-think
Pro think
```

It has two principal model families plus a reasoning flag:

```text
model_type
    +
thinking_enabled
```

---

# 13. Reasoning contract

The browser protocol uses:

```json
"thinking_enabled": true
```

or:

```json
"thinking_enabled": false
```

The external proxy may expose:

```text
reasoning.effort
```

because that is convenient for an OpenAI/Codex-compatible interface.

But this is a proxy translation.

For example:

```text
proxy:
reasoning.effort = low
       |
       v
DeepSeek:
thinking_enabled = false
```

and:

```text
proxy:
reasoning.effort = max
       |
       v
DeepSeek:
thinking_enabled = true
```

The exact mapping between all possible OpenAI reasoning levels and DeepSeek UI modes must not be invented until experimentally verified.

The DeepSeek contract itself only establishes the boolean thinking flag from these captures.

---

# 14. Search contract

Search uses the same completion endpoint:

```text
POST /api/v0/chat/completion
```

There is no separate basic completion endpoint required for web search.

The relevant request field is:

```json
"search_enabled": true
```

versus:

```json
"search_enabled": false
```

The browser can therefore be represented as:

```text
normal:
search_enabled = false

search:
search_enabled = true
```

The server response can expose search-related state including:

```text
search_enabled
search_triggered
conversation_mode
```

The observed search flow can enter:

```text
DEEP_SEARCH
```

---

# 15. Search and thinking are independent dimensions

The protocol model should therefore be:

```text
                    thinking
                       |
                 +-----+-----+
                 |           |
              false        true
                 |
                 |
model ---------- + ----------------
                 |
          search_enabled
                 |
            +----+----+
            |         |
          false      true
```

In implementation terms:

```json
{
  "model_type": null,
  "thinking_enabled": true,
  "search_enabled": true
}
```

is a valid conceptual combination.

The proxy must not model search as a different model.

---

# 16. PoW contract

Before completion, the browser obtains a proof-of-work challenge:

```http
POST /api/v0/chat/create_pow_challenge
```

Request:

```json
{
  "target_path": "/api/v0/chat/completion"
}
```

The challenge includes fields such as:

```text
algorithm
challenge
salt
signature
difficulty
expire_at
expire_after
target_path
```

Observed algorithm:

```text
DeepSeekHashV1
```

The browser solves the challenge and sends the result through:

```text
x-ds-pow-response
```

The current `src/pow.ts` implementation already implements the DeepSeekHashV1 solver.

Therefore PoW is an established mandatory part of the completion pipeline.

---

# 17. PoW lifecycle

The correct sequence is:

```text
completion requested
        |
        v
create_pow_challenge
        |
        v
receive challenge
        |
        v
solve challenge
        |
        v
encode result
        |
        v
x-ds-pow-response
        |
        v
POST /chat/completion
```

The proxy should not reuse an expired challenge.

The safest implementation is:

```text
one completion request
    ->
one fresh PoW challenge
```

unless future captures prove that reuse is supported.

---

# 18. SSE protocol

The DeepSeek completion response is an SSE stream.

The most important event for state management is:

```text
event: ready
```

Its payload contains:

```json
{
  "request_message_id": N,
  "response_message_id": N+1,
  "model_type": "..."
}
```

This event is authoritative for obtaining the new response message ID.

---

# 19. The `ready` event is a state-transition event

The proxy must treat:

```text
event: ready
```

as more than metadata.

It is effectively:

```text
DeepSeek has accepted the new message
        |
        v
here is the new user message ID
        +
here is the new assistant response ID
```

Therefore:

```text
response_message_id
```

becomes the continuation cursor.

The state transition is:

```text
OLD:
lastMessageId = N

completion

READY:
response_message_id = N+2

NEW:
lastMessageId = N+2
```

---

# 20. Correct continuation algorithm

The authoritative algorithm is:

```text
load proxy conversation state

if no DeepSeek session:
    create chat session

parent = state.lastMessageId

create PoW

POST completion:
    chat_session_id = state.session
    parent_message_id = parent

receive SSE

on "ready":
    responseMessageId =
        data.response_message_id

stream response

after successful completion:
    persist:
        chat_session_id = same session
        lastMessageId = responseMessageId
```

The proxy must never intentionally replace a successful new message ID with:

```text
null
```

---

# 21. Current proxy continuity defect

The current `codeep-proxy` has the right state structure:

```ts
interface SessionState {
  deepSeekSessionId: string
  lastMessageId: number | null
  instructionsApplied: boolean
}
```

but the state lifecycle is currently wrong.

The streaming path saves:

```text
lastMessageId = null
```

after the response.

Therefore the next request cannot correctly use:

```text
parent_message_id = previous response_message_id
```

This is one of the principal reasons the proxy does not maintain browser-equivalent continuity. 

---

# 22. Second continuity defect: proxy conversation identity

The current proxy attempts to identify a conversation using:

```text
thread-id
session-id
```

from the incoming request.

If neither is supplied, there is no stable external key.

Then the proxy can do:

```text
request 1
    -> create DeepSeek session A

request 2
    -> create DeepSeek session B
```

even if the client considers both requests part of one conversation.

Therefore the proxy needs a clearly defined external conversation identity mechanism.

This is a **proxy contract problem**, not a DeepSeek API problem.

---

# 23. Required proxy state model

The proxy should maintain:

```ts
interface DeepSeekConversationState {
    deepSeekSessionId: string
    lastMessageId: number | null
    modelType?: 'default' | 'expert'
    thinkingEnabled?: boolean
    searchEnabled?: boolean
    createdAt?: number
    lastUsedAt?: number
}
```

The minimum mandatory fields are:

```text
deepSeekSessionId
lastMessageId
```

Everything else is optional cached metadata.

---

# 24. Proxy identity model

The proxy must define one canonical external conversation key.

For example:

```text
proxyConversationId
```

Then:

```text
proxyConversationId
        |
        v
KV
        |
        +--> deepSeekSessionId
        +--> lastMessageId
```

Incoming transport-specific identifiers such as:

```text
thread-id
session-id
previous_response_id
```

can be aliases.

They should not each independently define different conversation semantics.

---

# 25. OpenAI/Codex compatibility layer

The proxy has two worlds:

```text
External:
OpenAI/Codex-style API

Internal:
DeepSeek Web API
```

Therefore the mapping must be explicit.

Example:

```text
OpenAI/Codex model
        |
        v
proxy model mapping
        |
        +--> DeepSeek model_type
        |
        +--> thinking_enabled
        |
        +--> search_enabled
```

Similarly:

```text
OpenAI previous_response_id
        |
        v
proxy KV state
        |
        +--> DeepSeek parent_message_id
```

The proxy must never assume that the identifiers are interchangeable.

---

# 26. Prompt contract

The DeepSeek completion request uses:

```json
"prompt": "..."
```

The browser sends the actual new user prompt rather than replaying the entire previous conversation.

Conversation history is held server-side through:

```text
chat_session_id
+
parent_message_id
```

Therefore the proxy does not need to resend the entire historical conversation to DeepSeek for ordinary continuation.

This is a major simplification.

---

# 27. `ref_file_ids`

The browser request includes:

```json
"ref_file_ids": []
```

For plain text conversations this is:

```text
empty array
```

The proxy currently sends exactly that.

Therefore:

```text
ref_file_ids
```

is part of the completion contract, even when unused.

File/attachment semantics remain a separate contract and should not be invented from the text-only captures.

---

# 28. `action`

Observed request shape:

```json
"action": null
```

The proxy currently reproduces this.

The meaning and supported non-null action values have not yet been established.

Therefore:

```text
action = null
```

is established.

Non-null `action` semantics are:

```text
UNKNOWN
```

and must be investigated separately before implementation.

---

# 29. `preempt`

Observed request shape:

```json
"preempt": false
```

The proxy currently reproduces this.

The exact semantics of `preempt=true` have not been established.

Therefore:

```text
preempt=false
```

is established.

Do not invent behavior for `true`.

---

# 30. SSE response structure

The response stream contains a mixture of:

```text
ready
update_session
data deltas
close
```

The content itself is represented through DeepSeek's delta protocol.

A typical delta contains:

```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": "text"
}
```

where:

```text
p = path
o = operation
v = value
```

Operations observed include:

```text
SET
APPEND
BATCH
```

The current proxy's delta parser is already designed around this structure.

---

# 31. Do not use response text parsing to determine message identity

Message identity and content streaming are separate concerns.

Wrong design:

```text
parse response text
    |
    +--> guess message ID
```

Correct design:

```text
SSE event: ready
    |
    +--> response_message_id
```

and independently:

```text
SSE data deltas
    |
    +--> assistant text
```

This separation should be preserved permanently.

---

# 32. Response completion lifecycle

A correct proxy should treat the completion as:

```text
START
  |
  v
PoW obtained
  |
  v
DeepSeek request accepted
  |
  v
READY
  |
  +--> capture response_message_id
  |
  v
CONTENT STREAM
  |
  v
CLOSE / successful completion
  |
  v
COMMIT conversation state
```

The state commit must occur only after the proxy has obtained a valid:

```text
response_message_id
```

and the request is considered successfully established.

---

# 33. State commit must be atomic from the proxy's perspective

The proxy must avoid:

```text
request starts
    |
    v
overwrite lastMessageId
    |
    v
DeepSeek request fails
```

because that can corrupt conversation state.

Safer:

```text
old state
   |
   v
request
   |
   v
ready -> newMessageId
   |
   v
successful completion
   |
   v
commit new state
```

If the completion fails before a valid new message ID exists:

```text
preserve old lastMessageId
```

unless DeepSeek explicitly indicates that the message was committed.

---

# 34. Retries are dangerous

Because DeepSeek has a message-chain model, blindly retrying a completion can create:

```text
duplicate user messages
```

or branch the conversation.

Therefore:

```text
retry completion
```

must not automatically mean:

```text
send identical prompt again
```

The proxy should distinguish:

```text
transport failure before request accepted
```

from:

```text
request accepted but stream failed
```

The `ready` event is particularly important here because it establishes that DeepSeek assigned message IDs.

---

# 35. Concurrency contract

Conversation state is mutable:

```text
lastMessageId
```

Therefore two simultaneous requests for the same proxy conversation are unsafe.

Example:

```text
request A:
parent = 10

request B:
parent = 10

A -> response 12
B -> response 14
```

The result can branch unexpectedly.

Therefore the proxy should eventually enforce:

```text
one active completion per conversation
```

or implement explicit serialization/locking.

This is a proxy-level requirement derived from the DeepSeek message-tree design.

---

# 36. Model switching inside a session

The captured protocol indicates that model/mode information is part of each completion request.

The proxy should therefore not assume:

```text
one DeepSeek session = one permanently fixed proxy model
```

unless future captures prove otherwise.

Instead:

```text
session
    |
    +-- turn 1: default
    +-- turn 2: default + thinking
    +-- turn 3: default + search
```

is demonstrably possible in the Flash/default capture.

The V4-Pro capture establishes the expert path.

Whether switching:

```text
default <-> expert
```

inside the same existing session is fully supported must be treated as a separately verified question unless the capture contains such a transition.

Do not assume it.

---

# 37. Browser client headers

The browser consistently identifies itself through headers in the `x-client-*` family.

The established values from the captures include:

```text
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.4.0
x-client-locale: en_US
```

The proxy already reproduces these.

---

# 38. Timezone header

The browser sends a timezone offset such as:

```text
x-client-timezone-offset: 3600
```

The current proxy uses:

```ts
new Date().getTimezoneOffset()
```

which has a different sign convention.

Therefore the proxy should not use the raw JavaScript `getTimezoneOffset()` result as a browser-equivalent value.

This should be corrected according to the exact DeepSeek/browser convention.

---

# 39. `x-hif-leim`

The browser sends:

```text
x-hif-leim
```

on relevant DeepSeek requests.

The current proxy does not reproduce it.

The exact semantics of this header are not established by the captures alone.

Therefore the correct status is:

```text
Observed: YES
Meaning: UNKNOWN
Proxy currently sends: NO
```

We should not invent a value.

The next protocol experiment should determine whether:

```text
missing
```

versus:

```text
browser-equivalent
```

changes endpoint behavior.

---

# 40. Cookies and Authorization

The browser uses authenticated state.

The proxy currently supports:

```text
Authorization
Cookie
```

through configured authentication state.

This is sufficient for the current architecture.

The proxy should centralize credentials rather than embedding them in individual request functions.

The current `credentials()` abstraction is directionally correct.

---

# 41. Login endpoint is not part of the normal proxy contract

The V4-Pro HAR contains a browser login sequence.

However, the proxy's intended architecture does not need to reproduce interactive DeepSeek login.

The proxy should instead receive/store already authenticated state.

Therefore:

```text
DeepSeek login UI
```

and:

```text
DeepSeek chat API contract
```

should remain separate specifications.

The login HAR is useful for understanding authentication, but should not become part of the completion implementation unless there is a specific requirement to automate login.

---

# 42. Authentication security requirement

HAR captures containing:

```text
email
password
authorization tokens
cookies
device/session identifiers
```

must never be treated as ordinary test fixtures.

They are secrets.

Therefore:

```text
HAR with credentials
```

must not be used as a permanent production artifact.

The repository should eventually contain:

```text
sanitized HAR
```

with:

```text
password -> REDACTED
authorization -> REDACTED
cookies -> REDACTED
session secrets -> REDACTED
```

while preserving protocol structure.

---

# 43. Current `codeep-proxy` status

The current implementation already has the basic DeepSeek pipeline:

```text
create session
      |
      v
create PoW
      |
      v
solve PoW
      |
      v
completion
      |
      v
SSE parser
      |
      v
OpenAI-compatible output
```

This architecture should be preserved.

The problem is not that the project needs to be rewritten.

The problem is that the protocol state machine needs to become exact.

---

# 44. Current implementation versus contract

| Contract | Current proxy |
|---|---|
| DeepSeek origin | Correct |
| Session creation | Implemented |
| Session ID | Implemented |
| PoW challenge | Implemented |
| DeepSeekHashV1 | Implemented |
| PoW response header | Implemented |
| Completion endpoint | Correct |
| `chat_session_id` | Correct |
| `parent_message_id: number|null` | Correct type |
| Default model mapping | Implemented |
| Expert model mapping | Implemented |
| Thinking flag | Implemented |
| Search flag | Missing |
| `ref_file_ids` | Correct empty array |
| `action:null` | Correct |
| `preempt:false` | Correct |
| SSE streaming | Implemented |
| `ready` message-ID extraction | Incorrect/incomplete |
| Persistent latest message ID | Broken |
| Stable proxy conversation identity | Incomplete |
| `x-hif-leim` | Missing |
| Browser timezone convention | Incorrect |
| Concurrency protection | Missing |
| Retry semantics | Not yet robust |
| Secret-safe capture | Needs improvement |

---

# 45. The canonical DeepSeek request

For the normal default/no-search/no-thinking path:

```http
POST /api/v0/chat/completion
Content-Type: application/json
Authorization: Bearer <authenticated-token>
x-ds-pow-response: <fresh-pow>
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.4.0
x-client-locale: en_US
x-client-timezone-offset: <browser-compatible-offset>
```

Body:

```json
{
  "chat_session_id": "<session>",
  "parent_message_id": null,
  "model_type": null,
  "prompt": "<prompt>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

For continuation:

```json
{
  "chat_session_id": "<same-session>",
  "parent_message_id": 42,
  "model_type": null,
  "prompt": "<next-prompt>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

For Pro:

```json
{
  "chat_session_id": "<session>",
  "parent_message_id": 42,
  "model_type": "expert",
  "prompt": "<prompt>",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

For search:

```json
{
  "chat_session_id": "<session>",
  "parent_message_id": 42,
  "model_type": null,
  "prompt": "<prompt>",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": true,
  "action": null,
  "preempt": false
}
```

The exact allowed combinations should be tested rather than assumed beyond what the captures establish.

---

# 46. The canonical DeepSeek response contract

The first state-bearing SSE event:

```text
event: ready
```

contains:

```json
{
  "request_message_id": <number>,
  "response_message_id": <number>,
  "model_type": "<server-model-type>"
}
```

The proxy must extract:

```text
request_message_id
response_message_id
```

The most important value is:

```text
response_message_id
```

because it becomes:

```text
parent_message_id
```

for the next turn.

---

# 47. Canonical state machine

The entire protocol can now be represented as:

```text
                    ┌─────────────────────┐
                    │ No proxy conversation│
                    └──────────┬──────────┘
                               │
                               │ create session
                               v
                    ┌─────────────────────┐
                    │ DeepSeek session A  │
                    │ parent = null       │
                    └──────────┬──────────┘
                               │
                               │ completion
                               v
                    ┌─────────────────────┐
                    │ SSE READY           │
                    │ response_id = 2     │
                    └──────────┬──────────┘
                               │
                               │ persist 2
                               v
                    ┌─────────────────────┐
                    │ Session A            │
                    │ parent = 2           │
                    └──────────┬──────────┘
                               │
                               │ completion
                               v
                    ┌─────────────────────┐
                    │ SSE READY           │
                    │ response_id = 4     │
                    └──────────┬──────────┘
                               │
                               │ persist 4
                               v
                    ┌─────────────────────┐
                    │ Session A            │
                    │ parent = 4           │
                    └─────────────────────┘
```

This is the central state machine of the project.

---

# 48. What is now proven

The following should be treated as **established protocol facts**:

```text
/api/v0/chat_session/create
/api/v0/chat/create_pow_challenge
/api/v0/chat/completion

chat_session_id
parent_message_id

model_type
thinking_enabled
search_enabled

ref_file_ids
action
preempt

DeepSeekHashV1
x-ds-pow-response

SSE
event: ready
request_message_id
response_message_id

DeepSeek delta p/o/v structure
```

---

# 49. What remains explicitly unknown

The following should remain marked UNKNOWN until directly tested:

```text
exact meaning of x-hif-leim

all valid model_type values

all valid action values

meaning of preempt=true

file-upload/ref_file_ids contract

exact behavior of model switching within an existing session

session behavior after TTL expiration

exact retry semantics after partial SSE failure

whether concurrent messages are accepted safely

all search modes/variants

all thinking-level variants

whether browser-specific headers are mandatory or merely metadata
```

This is important.

Unknown does not mean unsupported.

It means:

```text
do not guess
```

---

# 50. Required future investigation method

For every unknown protocol feature, use the same process:

```text
1. Capture browser behavior.
2. Identify the exact request.
3. Identify the exact response.
4. Compare first request versus continuation.
5. Change only one variable.
6. Capture again.
7. Compare request body.
8. Compare headers.
9. Compare SSE ready event.
10. Compare response metadata.
11. Record the result in the contract.
12. Only then implement it.
```

This prevents the project from accumulating assumptions.

---

# 51. Protocol invariants

These are the invariants the proxy must never violate.

### Invariant 1

```text
Every completion belongs to exactly one DeepSeek chat session.
```

### Invariant 2

```text
First turn:
parent_message_id = null
```

### Invariant 3

```text
Continuation:
parent_message_id =
previous successful response_message_id
```

### Invariant 4

```text
response_message_id comes from SSE ready.
```

### Invariant 5

```text
A successful completion must preserve its new response ID.
```

### Invariant 6

```text
PoW is generated for the completion request.
```

### Invariant 7

```text
model_type and thinking_enabled are separate dimensions.
```

### Invariant 8

```text
search_enabled is independent of the basic completion endpoint.
```

### Invariant 9

```text
Proxy identifiers and DeepSeek identifiers are not interchangeable.
```

### Invariant 10

```text
Unknown DeepSeek fields must not be invented.
```

---

# 52. The implementation target

The target is **not**:

```text
"make DeepSeek respond"
```

That already works.

The target is:

```text
make codeep-proxy behave as a deterministic translation layer
between an OpenAI/Codex client and the DeepSeek Web Chat protocol.
```

That means:

```text
External API
    |
    v
Normalize request
    |
    v
Resolve proxy conversation
    |
    v
Resolve DeepSeek session/message state
    |
    v
Generate PoW
    |
    v
Construct exact DeepSeek request
    |
    v
Parse SSE
    |
    +--> extract response_message_id
    |
    +--> translate response
    |
    v
Commit state
```

---

# 53. Final architecture

The correct final architecture should look like:

```text
                 CODEEP PROXY
                 ────────────

        ┌─────────────────────────┐
        │ OpenAI/Codex Interface  │
        └────────────┬────────────┘
                     │
                     v
        ┌─────────────────────────┐
        │ Request Normalizer      │
        │                         │
        │ model                   │
        │ reasoning               │
        │ search                  │
        │ messages                │
        └────────────┬────────────┘
                     │
                     v
        ┌─────────────────────────┐
        │ Conversation Resolver   │
        │                         │
        │ proxyConversationId     │
        │ DeepSeek session        │
        │ lastMessageId           │
        └────────────┬────────────┘
                     │
                     v
        ┌─────────────────────────┐
        │ DeepSeek Request        │
        │ Builder                 │
        │                         │
        │ session                 │
        │ parent                  │
        │ model_type              │
        │ thinking                │
        │ search                  │
        │ prompt                  │
        └────────────┬────────────┘
                     │
                     v
        ┌─────────────────────────┐
        │ PoW                     │
        └────────────┬────────────┘
                     │
                     v
        ┌─────────────────────────┐
        │ DeepSeek /completion    │
        └────────────┬────────────┘
                     │
                     │ SSE
                     v
        ┌─────────────────────────┐
        │ SSE State Parser        │
        │                         │
        │ ready                   │
        │ response_message_id    │
        │ deltas                  │
        │ close                   │
        └────────────┬────────────┘
                     │
                     ├───────────────> Client response
                     │
                     v
        ┌─────────────────────────┐
        │ State Commit            │
        │                         │
        │ lastMessageId = new ID  │
        └─────────────────────────┘
```

---

# 54. Definition of "DeepSeek Web Contract v1 complete"

We should consider the DeepSeek Web Contract fully established only when:

```text
[✓] Authentication transport understood
[✓] Session creation understood
[✓] PoW understood
[✓] Completion request understood
[✓] Default/Flash understood
[✓] Expert/Pro understood
[✓] Thinking flag understood
[✓] Search flag understood
[✓] SSE ready event understood
[✓] Message continuation understood
[✓] Delta format understood

[ ] x-hif-leim experimentally classified
[ ] timezone convention corrected
[ ] all relevant model/mode combinations captured
[ ] model switching tested
[ ] search variants fully captured
[ ] file/ref_file_ids behavior investigated
[ ] action behavior investigated
[ ] preempt behavior investigated
[ ] failure/retry behavior tested
[ ] session expiry behavior tested
[ ] concurrency behavior tested
```

The first group is the **core contract**.

The second group is the **extended contract**.

---

# 55. Implementation priority

The next implementation work should happen in this order.

## Phase 1 — continuity

Fix:

```text
stable proxy conversation identity
+
ready.response_message_id
+
persistent lastMessageId
```

This is the most important issue.

## Phase 2 — exact request parity

Fix:

```text
timezone convention
x-hif-leim investigation
```

## Phase 3 — search

Implement:

```text
search_enabled
```

while preserving the same session/message chain.

## Phase 4 — mode matrix

Validate:

```text
Flash no-thinking
Flash thinking
Pro no-thinking
Pro thinking
Flash search
Pro search
thinking + search
```

rather than assuming combinations.

## Phase 5 — extended protocol

Investigate:

```text
action
preempt
ref_file_ids
attachments
failure/retry
expiry
concurrency
```

---

# 56. Final contract statement

The DeepSeek Web Chat protocol can now be reduced to this core contract:

```text
AUTHENTICATED DEEPSEEK SESSION
            |
            v
CREATE CHAT SESSION
            |
            v
chat_session_id
            |
            v
CREATE POW CHALLENGE
            |
            v
SOLVE POW
            |
            v
POST /api/v0/chat/completion
            |
            +--> chat_session_id
            +--> parent_message_id
            +--> model_type
            +--> prompt
            +--> ref_file_ids
            +--> thinking_enabled
            +--> search_enabled
            +--> action
            +--> preempt
            |
            v
SSE
            |
            +--> ready
            |      |
            |      +--> request_message_id
            |      +--> response_message_id
            |      +--> model_type
            |
            +--> response deltas
            |
            +--> close
            |
            v
PERSIST response_message_id
            |
            v
NEXT TURN:
parent_message_id =
previous response_message_id
```

That is the fundamental DeepSeek Web contract.

Everything else in `codeep-proxy` should be built around this state machine.

The single most important implementation rule is:

```text
DeepSeek conversation continuity =
chat_session_id
+
latest successful response_message_id
```

Not:

```text
chat_session_id alone
```

and not:

```text
client thread ID alone
```

The proxy's job is to preserve that relationship reliably while translating the external OpenAI/Codex interface into DeepSeek's native Web Chat protocol.

---

# 57. Status of Bible v1

**Core protocol: sufficiently established for implementation.**

**Extended protocol: intentionally incomplete where the HAR does not provide enough evidence.**

This distinction is deliberate.

We should never again treat an unobserved DeepSeek field or behavior as known simply because it appears plausible.

Every future addition to this contract should carry one of three labels:

```text
OBSERVED
INFERRED
UNKNOWN
```

Only `OBSERVED` should be promoted directly into the implementation contract.

`INFERRED` requires a targeted test.

`UNKNOWN` requires a new browser capture.
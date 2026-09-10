DeepSeek Chat v4-Flash Browser Protocol — Technical Investigation

1. Executive conclusion

The important discovery is that DeepSeek Chat does not use the model name "V4-Flash" as the wire-level model selector.

For the browser's default/Instant/V4-Flash path, the actual "/api/v0/chat/completion" request is built around:

- "chat_session_id"
- "parent_message_id"
- "model_type"
- "prompt"
- "thinking_enabled"
- "search_enabled"
- "ref_file_ids"
- "action"
- "preempt"

The browser uses "model_type: null" in the captured V4-Flash requests, while the server returns "model_type: "default"" in the SSE "ready" event. The first request uses "parent_message_id: null"; every subsequent turn uses the previous assistant response message ID as "parent_message_id".

This means conversation continuity is not achieved merely by retaining the DeepSeek session UUID. There are two pieces of state:

DeepSeek conversation:
    chat_session_id
          +
    current parent_message_id

The current "codeep-proxy" implementation has both concepts, but its state-update logic does not match what the browser actually receives.

The most important defects are:

1. The proxy depends on the incoming client providing "thread-id" or "session-id". If neither exists, it creates a new DeepSeek session on every request.
2. The proxy's streaming path deliberately saves "lastMessageId: null".
3. Even its non-streaming parser looks for "p === "response/id"", but the HAR shows the authoritative new message ID arrives in the "event: ready" SSE event as "response_message_id".
4. Web search is explicitly disabled in the proxy with "search_enabled: false".
5. The browser sends an "x-hif-leim" header which the proxy currently omits.
6. The browser's timezone header is "3600"; the proxy currently derives it from JavaScript "getTimezoneOffset()", which does not produce the same representation.

So the current implementation is close enough to talk to DeepSeek, but it is not yet protocol-equivalent to the browser.

---

2. Actual DeepSeek browser flow

The V4-Flash browser flow can be reduced to this:

Browser
  |
  | POST /api/v0/chat_session/create
  | body: {}
  v
DeepSeek
  |
  | returns chat_session.id
  v
Browser stores chat_session_id
  |
  | POST /api/v0/chat/create_pow_challenge
  | body:
  | {
  |   "target_path": "/api/v0/chat/completion"
  | }
  v
DeepSeek
  |
  | returns DeepSeekHashV1 challenge
  v
Browser solves PoW
  |
  | POST /api/v0/chat/completion
  | headers:
  |   x-ds-pow-response
  |   x-hif-leim
  |   Authorization
  |   x-client-*
  |
  | body:
  | {
  |   "chat_session_id": "...",
  |   "parent_message_id": null,
  |   "model_type": null,
  |   "prompt": "...",
  |   "ref_file_ids": [],
  |   "thinking_enabled": false,
  |   "search_enabled": false,
  |   "action": null,
  |   "preempt": false
  | }
  v
DeepSeek
  |
  | SSE
  | event: ready
  | data: {
  |   "request_message_id": 1,
  |   "response_message_id": 2,
  |   "model_type": "default"
  | }
  |
  | event: update_session
  |
  | data: response snapshot/deltas
  |
  | event: close
  v
Browser stores:
    last assistant message = 2

The next turn does not create a new chat session:

{
  "chat_session_id": "same-session",
  "parent_message_id": 2,
  "model_type": null,
  "prompt": "second turn",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}

The server then returns:

request_message_id = 3
response_message_id = 4

The next request therefore uses:

"parent_message_id": 4

The HAR demonstrates exactly this sequence:

turn 1:
parent_message_id = null
request_message_id = 1
response_message_id = 2

turn 2:
parent_message_id = 2
request_message_id = 3
response_message_id = 4

turn 3:
parent_message_id = 4
request_message_id = 5
response_message_id = 6

turn 4:
parent_message_id = 6
request_message_id = 7
response_message_id = 8

This is the core continuity mechanism.

---

3. "chat_session_id" versus "parent_message_id"

These two values have different purposes.

"chat_session_id"

This identifies the conversation container.

Example:

aca37dbb-b52c-4abf-a5d6-144f63328342

Creating a session returns metadata including:

{
  "id": "...",
  "seq_id": 211158511,
  "agent": "chat",
  "model_type": "default",
  "current_message_id": null,
  "ttl_seconds": 259200
}

The captured response shows a three-day session TTL.

"parent_message_id"

This identifies where in that conversation tree the new user message should be attached.

First message:

"parent_message_id": null

Second message:

"parent_message_id": 2

Third:

"parent_message_id": 4

This means DeepSeek is effectively maintaining a message tree, not simply treating "chat_session_id" as sufficient context.

This distinction explains why "same session" and "conversation continuity" are not the same thing.

---

4. Model selection is simpler than expected

For the captured V4-Flash/default browser requests, the request body contains:

"model_type": null

The server's "ready" event then says:

"model_type": "default"

The same session remains "default" while switching between thinking and search variants.

Therefore:

V4-Flash / Instant
        |
        v
model_type = null/default
        |
        +-- thinking_enabled = false
        |       -> no thinking
        |
        +-- thinking_enabled = true
                -> thinking/deep-think mode

The browser does not transmit a parameter such as:

effort = low
effort = high
effort = max

in these captured requests.

The words "low", "high", "deepthink", etc. are therefore UI-level terminology in this capture. At the DeepSeek API layer, the important flag is simply:

"thinking_enabled": true

or

"thinking_enabled": false

The HAR shows the same default model session being used for both states.

---

5. Web search is also just a request flag

The search variant does not use a different completion endpoint.

It still calls:

POST /api/v0/chat/completion

with the same:

"model_type": null

but changes:

"thinking_enabled": true,
"search_enabled": true

The resulting response reports:

search_enabled = true
search_triggered = true
conversation_mode = DEEP_SEARCH

The following message, ""In english"", remains in the same DeepSeek session and continues from the previous assistant message.

Therefore web search is not a separate model and does not require a separate basic completion API.

The protocol distinction is primarily:

search_enabled = false

versus:

search_enabled = true

with the server determining the resulting conversation mode.

---

6. PoW flow

Before each completion request, the browser requests a challenge:

POST /api/v0/chat/create_pow_challenge

with:

{
  "target_path": "/api/v0/chat/completion"
}

The challenge contains:

algorithm
challenge
salt
signature
difficulty
expire_at
expire_after
target_path

The captured browser uses:

algorithm = DeepSeekHashV1

and a difficulty of:

144000

The browser then solves the challenge and places the result into:

x-ds-pow-response

as a base64-encoded JSON structure.

The current proxy correctly reproduces this portion:

const challenge = await createChallenge(env)
const pow = btoa(JSON.stringify(solvePow(challenge as PowChallenge)))

and then:

'x-ds-pow-response': pow

The implementation in "src/pow.ts" also implements the "DeepSeekHashV1" solver.

So the PoW portion is one of the strongest parts of the current implementation.

---

7. SSE response format

DeepSeek does not return ordinary JSON from "/chat/completion".

It returns:

Content-Type: text/event-stream; charset=utf-8

The important initial event is:

event: ready
data: {
  "request_message_id": 1,
  "response_message_id": 2,
  "model_type": "default"
}

Then:

event: update_session
data: {
  "updated_at": ...
}

Then the response stream consists of "data:" JSON messages.

The first response snapshot contains a full response structure including:

{
  "response": {
    "message_id": 2,
    "parent_id": 1,
    "role": "ASSISTANT",
    "thinking_enabled": false,
    "search_enabled": false,
    "fragments": [...]
  }
}

After that, DeepSeek sends incremental patches such as:

{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": " again"
}

and subsequent chunks can omit "p" and simply provide:

{
  "v": "!"
}

The current "createDeepSeekDeltaParser()" is therefore directionally correct: it understands the "p/o/v" delta system and "APPEND" semantics.

---

8. Important mistake in the current message-ID extraction

This is one of the most important implementation mismatches.

Current code searches for:

if (event.p === 'response/id' && typeof event.v === 'number') {
    newMessageId = event.v
}

But the HAR does not expose the new message ID that way.

The message ID is explicitly supplied in:

event: ready

as:

{
  "request_message_id": 3,
  "response_message_id": 4,
  "model_type": "default"
}

Therefore the current parser is looking in the wrong place.

This explains why the code has difficulty maintaining "lastMessageId": it is attempting to discover the ID from a delta path which the captured protocol does not use for this purpose.

The correct conceptual parser should be:

if event == "ready":
    requestMessageId = data.request_message_id
    responseMessageId = data.response_message_id

Then:

state.lastMessageId = responseMessageId

not a search for:

response/id

---

9. Why the current proxy loses continuity

There are actually two independent continuity failures.

Failure A — no stable external session key

Current code does:

const threadId = request.headers.get('thread-id')
const sessionHeader = request.headers.get('session-id')

const existingState = await loadSession(
    env,
    [threadId, sessionHeader]
)

Then:

const sessionId =
    existingState?.deepSeekSessionId ||
    await createSession(env)

Therefore:

request 1
thread-id = absent
session-id = absent
        |
        v
create DeepSeek session A

request 2
thread-id = absent
session-id = absent
        |
        v
create DeepSeek session B

request 3
        |
        v
create DeepSeek session C

There is no persistent lookup key.

So if the upstream client does not send one of those headers, the proxy has no way to know that request 2 belongs to the conversation from request 1.

That directly explains the "new conversation session every turn" behavior.

---

10. Failure B — streaming responses erase the parent ID

The streaming branch currently saves:

await saveSession(env, sessionIdentifiers, {
    deepSeekSessionId: sessionId,
    lastMessageId: null,
    instructionsApplied: ...
})

So even when the DeepSeek session itself is reused, the proxy stores:

lastMessageId = null

after every streamed answer.

The next call therefore becomes:

"parent_message_id": null

instead of:

"parent_message_id": 2

or:

"parent_message_id": 4

or whatever the latest assistant response ID actually is.

For an SSE-based API, this is a fundamental continuity bug.

---

11. The non-streaming branch has the same ID problem

The non-streaming branch attempts to extract:

if (event.p === 'response/id' && typeof event.v === 'number') {
    newMessageId = event.v
}

But as shown above, the actual browser protocol exposes:

event: ready

with:

response_message_id

Therefore "newMessageId" can remain "null".

The code then only saves state when:

if (newMessageId !== null)

So the state frequently remains without the required parent message ID.

---

12. Current proxy's model mapping

Current code maps the proxy's local model aliases:

deepseek-v4-flash
deepseek-v4-pro

to DeepSeek's internal model types.

The current implementation says:

const isExpert = normalized === 'deepseek-v4-pro'

return {
    model_type: isExpert ? 'expert' : 'default',
    thinking_enabled: effort === 'max'
}

That means:

deepseek-v4-flash
    low -> default + thinking false
    max -> default + thinking true

deepseek-v4-pro
    low -> expert + thinking false
    max -> expert + thinking true

This is a reasonable proxy abstraction.

However, it should be understood as:

Codex model name
       |
       v
proxy translation
       |
       +--> DeepSeek model_type
       |
       +--> thinking_enabled

The original model string itself is not what DeepSeek's "/chat/completion" endpoint uses.

The proxy model names are local compatibility aliases.

---

13. Web-search comparison

The current code contains:

search_enabled: false,

inside "requestDeepSeek()".

That means every request generated by the proxy is explicitly:

"search_enabled": false

Even when the browser would have sent:

"search_enabled": true

Therefore web search cannot work with the current request builder.

This is not a DeepSeek session problem.

It is simply a missing request parameter in the proxy.

The HAR confirms that search is implemented on the same completion endpoint and changes the resulting server-side conversation mode.

---

14. Header comparison

Browser

The captured completion requests contain:

x-ds-pow-response
x-hif-leim
x-client-bundle-id
x-client-platform
x-client-version
x-client-locale
x-client-timezone-offset
authorization
content-type
accept

Current proxy

The proxy sends:

Accept
Content-Type
Origin
Referer
x-client-bundle-id
x-client-platform
x-client-version
x-client-locale
x-client-timezone-offset
Authorization
Cookie
x-ds-pow-response

The main missing protocol header visible in the HAR is:

x-hif-leim

The HAR shows it repeatedly on completion requests.

The capture does not establish exactly what "x-hif-leim" means, so it should not be reverse-engineered by assumption. The safe conclusion is simply:

browser sends it
proxy currently does not

and this should be tested rather than ignored.

---

15. Timezone-header mismatch

The browser capture sends:

x-client-timezone-offset: 3600

The proxy currently computes:

String(new Date().getTimezoneOffset())

These are not equivalent representations.

For example, JavaScript "getTimezoneOffset()" returns an offset in minutes and uses the opposite sign convention from the browser's captured value.

Therefore the current proxy is not reproducing that browser header correctly.

This probably does not affect basic completions, but it is another protocol-level difference.

---

16. What the current proxy gets right

The implementation already has a substantial amount of the real protocol correct.

Area| Status
DeepSeek origin| Correct
"/api/v0/chat_session/create"| Correct
"/api/v0/chat/create_pow_challenge"| Correct
PoW solver| Correct implementation direction
"x-ds-pow-response"| Correct
"/api/v0/chat/completion"| Correct
"chat_session_id"| Correct
"parent_message_id" type| Correctly changed to number/null
"model_type" default/expert mapping| Reasonable
"thinking_enabled"| Correct concept
"ref_file_ids: []"| Correct for current text tests
SSE handling| Generally correct architecture
DeepSeek delta parser| Substantially aligned
OpenAI-compatible output translation| Implemented
Responses API adapter| Implemented
Web search| Missing
Streaming continuity| Broken
Reliable message-ID extraction| Broken
Session identity when client gives no key| Broken

The core transport is therefore not fundamentally wrong. The problem is primarily state management and exact protocol handling, not the basic DeepSeek connection.

---

17. Best mental model for codeep-proxy

The proxy should be viewed as three separate layers.

Layer 1 — Codex/OpenAI compatibility

The external client sends something like:

{
  "model": "deepseek-v4-flash",
  "messages": [...],
  "stream": true,
  "reasoning": {
    "effort": "low"
  }
}

The proxy owns this API.

Layer 2 — proxy conversation state

The proxy must maintain:

proxy conversation key
    |
    +--> deepSeekSessionId
    |
    +--> lastMessageId

This state belongs to the proxy.

Layer 3 — DeepSeek protocol

The proxy translates it into:

{
  "chat_session_id": "...",
  "parent_message_id": 4,
  "model_type": null,
  "prompt": "...",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}

That is the actual DeepSeek conversation protocol.

---

18. Correct continuity algorithm

The correct algorithm is:

Incoming request
      |
      v
Find stable proxy conversation key
      |
      +-- existing state?
      |       |
      |       +-- yes --> reuse:
      |       |            deepSeekSessionId
      |       |            lastMessageId
      |       |
      |       +-- no ---> create DeepSeek session
      |                  parent = null
      |
      v
Create PoW challenge
      |
      v
Send completion
      |
      v
Read SSE "ready"
      |
      +--> response_message_id = NEW_PARENT
      |
      v
Stream/translate answer
      |
      v
Persist:
    deepSeekSessionId = same session
    lastMessageId = response_message_id
      |
      v
Next turn
      |
      v
parent_message_id = previous response_message_id

The crucial invariant is:

lastMessageId = latest assistant response_message_id

It must never be reset to "null" after a successful streamed completion.

---

19. Important distinction: session continuity versus context replay

The browser does not send the whole previous conversation back inside each completion request.

It sends only the new:

prompt

plus:

chat_session_id
parent_message_id

DeepSeek therefore owns the conversation history.

That is important for the proxy architecture.

We do not need to reconstruct the complete message history ourselves merely to achieve normal DeepSeek chat continuity.

We mainly need to preserve the correct DeepSeek session and message-chain state.

---

20. Why "previous_response_id" should not be confused with DeepSeek's parent ID

The proxy's "/v1/responses" implementation accepts:

previous_response_id

but that is an OpenAI/Codex-facing identifier.

It is not the same thing as DeepSeek's:

parent_message_id

The proxy can map:

previous_response_id
      |
      v
proxy KV state
      |
      +--> deepSeekSessionId
      +--> lastMessageId

but the actual request to DeepSeek must still contain the numeric:

"parent_message_id": 4

The two identifiers should remain conceptually separate.

---

21. Security finding

There is also a serious issue in the current repository state.

The HAR contains captured authentication material, including a login credential and authorization bearer token.

Those values should not remain valid after this investigation.

They should be considered compromised and rotated/revoked.

There is a second related issue: "wrangler.toml" currently has:

CAPTURE_LOG = "true"

and "captureToR2()" records request headers.

The proxy's DeepSeek capture therefore has the capability to write authentication headers and request information to R2.

For protocol debugging this is useful, but it should not be left enabled in a production deployment, and authentication headers should be explicitly redacted before persistence.

---

22. Overall assessment of main branch

I would rate the current implementation as:

DeepSeek connectivity:          GOOD
PoW implementation:             GOOD
Basic model translation:        GOOD
SSE translation:                GOOD
Protocol understanding:        PARTIAL
Conversation state design:      PARTIAL
Conversation continuity:        BROKEN
Web search support:             MISSING
Exact browser parity:           NOT YET

The important point is that this does not require rewriting the proxy.

The existing architecture is usable.

The main work is to make the state machine match the real browser protocol:

stable conversation key
        +
chat_session_id
        +
ready.response_message_id
        +
parent_message_id

Once that is implemented correctly, normal multi-turn DeepSeek continuity should be achievable without replaying the entire conversation manually.

---

23. Minimal protocol specification for future implementation

For the V4-Flash/default path, the DeepSeek completion contract discovered from the HAR is:

Session creation

POST /api/v0/chat_session/create
Content-Type: application/json

{}

Returns a session object containing:

chat_session.id
chat_session.model_type
chat_session.current_message_id
ttl_seconds

PoW challenge

POST /api/v0/chat/create_pow_challenge
Content-Type: application/json

{
  "target_path": "/api/v0/chat/completion"
}

Completion

POST /api/v0/chat/completion
Content-Type: application/json
Authorization: Bearer <token>
x-ds-pow-response: <base64-json>

Body:

{
  "chat_session_id": "<uuid>",
  "parent_message_id": null,
  "model_type": null,
  "prompt": "<new user message>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}

For the next turn:

{
  "chat_session_id": "<same uuid>",
  "parent_message_id": 2,
  "model_type": null,
  "prompt": "<next user message>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}

For thinking:

"thinking_enabled": true

For search:

"search_enabled": true

The DeepSeek response is SSE. The "ready" event is authoritative for the new message IDs:

event: ready

data: {
  "request_message_id": N,
  "response_message_id": N+1,
  "model_type": "default"
}

The proxy should persist:

lastMessageId = response_message_id

after the completion succeeds.

---

24. Final diagnosis

The HAR removes most of the ambiguity we had before.

The DeepSeek browser protocol is actually fairly small:

create session
    ↓
create PoW
    ↓
completion
    ↓
SSE ready → get response_message_id
    ↓
store response_message_id
    ↓
next completion uses it as parent_message_id

Thinking and search are simply flags on the same completion endpoint.

The current proxy already implements most of the transport correctly. Its main architectural problem is that it does not yet treat the DeepSeek SSE "ready.response_message_id" as the authoritative continuation cursor.

That is the key fix.

The next implementation should therefore focus on session-key selection + "ready.response_message_id" extraction + persistent parent tracking, before touching anything else.
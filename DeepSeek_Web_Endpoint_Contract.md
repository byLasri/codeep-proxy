# DeepSeek Web Endpoint Contract

## Version

```text
contract_version = "2.3"
protocol_target = "DeepSeek Web Chat"
runtime_reference = "Cloudflare Workers + TypeScript + Wrangler"
evidence_basis = "checked-in HAR captures; newest capture has precedence for current behavior"
```

---

# 1. Evidence precedence

This document is a wire contract derived from the repository's recorded network traffic.

The evidence order is deterministic:

```text
1. extensive_usage_network_test.har
2. other checked-in HAR captures
3. existing repository documentation
4. implementation source comments/templates
```

The newest HAR defines current endpoint behavior. Older HARs remain valid historical evidence for behavior no longer exposed by the current UI, including the historical expert wire path and its enforcement.

A value marked `ESTABLISHED` is directly present in captured traffic or directly represented by a captured server response. Product naming sourced from current official DeepSeek documentation is identified separately from raw wire evidence.

---

# 2. Origin

```json
{
  "name": "DeepSeek Web API origin",
  "value": "https://chat.deepseek.com",
  "status": "ESTABLISHED"
}
```

HIF acquisition uses separate DeepSeek origins:

```text
https://hif-leim.deepseek.com/query
https://hif-dliq.deepseek.com/query
```

---

# 3. Browser client identity

The current browser capture sends:

```json
{
  "x-client-bundle-id": "com.deepseek.chat",
  "x-client-platform": "web",
  "x-client-version": "2.4.0",
  "x-client-locale": "en_US",
  "x-client-timezone-offset": "3600"
}
```

These are the exact captured client values.

---

# 4. Core endpoints

```json
{
  "session_create": "POST /api/v0/chat_session/create",
  "pow_create": "POST /api/v0/chat/create_pow_challenge",
  "completion": "POST /api/v0/chat/completion"
}
```

The normal browser sequence is:

```text
chat_session/create
        |
        +--> create_pow_challenge
        |
        +--> HIF side-channel acquisition
        |
        +--> chat/completion
```

HIF acquisition is independent of session creation and PoW generation.

---

# 5. Chat-session creation

```http
POST https://chat.deepseek.com/api/v0/chat_session/create
Content-Type: application/json

{}
```

Observed response fields include:

```json
{
  "id": "<chat_session_id>",
  "seq_id": 0,
  "agent": "chat",
  "model_type": "default",
  "current_message_id": null,
  "ttl_seconds": 259200
}
```

`id` is the authoritative `chat_session_id` used by completion requests.

---

# 6. Session lifetime

```json
{
  "ttl_seconds": 259200,
  "equivalent": "3 days",
  "status": "OBSERVED"
}
```

---

# 7. Proof-of-work challenge

```http
POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge
Content-Type: application/json

{"target_path":"/api/v0/chat/completion"}
```

Observed response schema:

```json
{
  "algorithm": "DeepSeekHashV1",
  "challenge": "<challenge>",
  "salt": "<salt>",
  "signature": "<signature>",
  "difficulty": 144000,
  "expire_after": 300000,
  "target_path": "/api/v0/chat/completion"
}
```

The challenge values are per-response values and MUST NOT be copied from a HAR into an implementation.

The exact observed current difficulty is `144000` and the observed relative expiry is `300000` milliseconds.

---

# 8. Proof-of-work transport

A solved challenge is transmitted on completion as:

```text
x-ds-pow-response: <solved-pow-result>
```

The PoW layer and HIF layer are separate protocol components.

---

# 9. HIF-LEIM acquisition

The current browser obtains the LEIM value from:

```http
GET https://hif-leim.deepseek.com/query
```

The captured request contains:

```http
accept: */*
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.4.0
x-client-locale: en_US
x-client-timezone-offset: 3600
```

The current capture does NOT send `Authorization`, `Cookie`, `Origin`, or `Referer` on this HIF-LEIM GET.

That is the current wire contract.

---

# 10. HIF-LEIM response

A successful current response has this exact shape:

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "value": "<hif_leim_value>"
    }
  }
}
```

The client extracts:

```text
data.biz_data.value
```

and places the resulting opaque value into:

```text
x-hif-leim
```

---

# 11. HIF-LEIM token format

The current captured value is an opaque two-segment dot-delimited string.

It is NOT a standard three-segment JWT.

Implementation rule:

```text
Treat data.biz_data.value as opaque bytes/text.
Do not decode it as a JWT.
Do not reconstruct it locally.
Do not transform it before header injection.
```

---

# 12. HIF-LEIM lifetime and refresh

Current client telemetry reports:

```json
{
  "ds_ttl": 600
}
```

The client configuration also contains:

```json
{
  "hif_max_retry_interval_secs": 600
}
```

The operational HIF lifetime is therefore 600 seconds in the current browser implementation.

A headless client MUST refresh the value rather than assuming indefinite validity.

---

# 13. HIF-DLIQ acquisition

The current browser also probes:

```http
GET https://hif-dliq.deepseek.com/query
```

with the same client identity headers.

In the newest HAR, these requests fail as network/XHR requests and no successful DLIQ value is captured.

Therefore v2.3 does NOT define a successful current DLIQ acquisition flow.

A client MUST NOT fabricate `x-hif-dliq`.

---

# 14. Completion endpoint

```http
POST https://chat.deepseek.com/api/v0/chat/completion
Accept: text/event-stream
Content-Type: application/json
```

The completion request carries the observed anti-abuse headers:

```text
x-ds-pow-response: <solved-pow>
x-hif-leim: <opaque-hif-leim>
```

Older captures also contain `x-hif-dliq` in completion requests. Current newest traffic establishes LEIM; current successful DLIQ acquisition is not established.

---

# 15. Completion request schema

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

Field definitions:

```json
{
  "chat_session_id": {
    "type": "string",
    "required": true
  },
  "parent_message_id": {
    "type": "number|null",
    "required": true
  },
  "model_type": {
    "type": "string|null",
    "required": true,
    "observed_completion_values": [
      null,
      "expert"
    ],
    "current_server_and_settings_value": "default",
    "note": "The current settings/session payload uses 'default'; the checked-in completion HAR evidence directly establishes null and expert as completion request values. Do not promote 'default' to a completion request value solely from settings/session output."
  },
  "prompt": {
    "type": "string",
    "required": true
  },
  "ref_file_ids": {
    "type": "array",
    "required": true
  },
  "thinking_enabled": {
    "type": "boolean",
    "required": true
  },
  "search_enabled": {
    "type": "boolean",
    "required": true
  },
  "action": {
    "type": "null|unknown",
    "required": true
  },
  "preempt": {
    "type": "boolean",
    "required": true
  }
}
```

The request schema therefore distinguishes the current `default` product/settings value from the raw completion representations directly established by the HARs.

---

# 16. Conversation continuation

The first turn uses:

```json
{"parent_message_id":null}
```

Each subsequent turn uses the previous assistant `response_message_id`:

```json
{"parent_message_id":<previous_response_message_id>}
```

Invariant:

```text
next.parent_message_id === previous.ready.response_message_id
```

---

# 17. SSE response

Completion is an SSE stream.

The established event classes are:

```text
ready
update_session
data
close
```

The `ready` event is authoritative for both response identity and server-reported model resolution:

```text
event: ready
data: {"request_message_id":<n>,"response_message_id":<n>,"model_type":"<type>"}
```

The next completion uses that `response_message_id` as `parent_message_id`.

---

# 18. Ready event and server model confirmation

```json
{
  "event": "ready",
  "data": {
    "request_message_id": "number",
    "response_message_id": "number",
    "model_type": "string"
  },
  "status": "ESTABLISHED"
}
```

The `model_type` value in `ready.data` is the authoritative server-reported model path for that completion response.

For the historical expert path the checked-in HAR contains:

```text
model_type = "expert"
```

For the default path the server/session representation uses `default` while completion requests in the captured protocol use `null`.

A client MUST use `ready.response_message_id` as the continuation cursor and SHOULD use `ready.model_type` to verify the server-resolved model path.

---

# 19. Content delta protocol

Observed deltas contain:

```json
{
  "p": "response/fragments/-1/content",
  "o": "APPEND",
  "v": "text"
}
```

Observed operations include:

```text
SET
APPEND
BATCH
```

---

# 20. Model type and product mapping

The wire protocol and the current product names are separate layers.

Wire values established directly by the checked-in completion captures:

```text
null
expert
```

Current settings/session output also uses:

```text
default
```

The current settings payload identifies `default` as the enabled default web model and `expert` as the Expert model. The current official DeepSeek product documentation identifies the current Flash family as V4.1-Flash and the current Pro family as V4-Pro; these product names are external product mapping, not literal values of the web completion `model_type` field.

```text
Wire null       -> current default/Instant product path
Wire expert     -> Expert product path
Settings default -> enabled default/Instant identifier
```

The contract does NOT claim that the string `"default"` has been observed as a completion request value unless a future HAR directly captures that request body.

---

# 21. Model/reasoning/search matrix

The following matrix records what is established by capture rather than extrapolating unobserved combinations:

| Request `model_type` | Product path | `thinking_enabled` | `search_enabled` | Contract status |
|---|---|---:|---:|---|
| `null` | Default / Instant | `false` or `true` where directly captured | `false` or `true` where directly captured | ESTABLISHED request dimension |
| `"expert"` | Expert / Pro | `false` or `true` only where directly captured | Captured expert requests use `false` | ESTABLISHED historical wire path |
| `"default"` | Current default settings/session identifier | boolean field exists | boolean field exists | ESTABLISHED as settings/session value; NOT established as completion input |

The HARs establish `thinking_enabled` and `search_enabled` as independent boolean completion fields. They do not provide exhaustive proof that every boolean/model combination is accepted by every server version.

In particular, the repository does not contain sufficient negative-response evidence to promote `expert + search_enabled:true` into a universal server rejection rule. The captured expert requests use `search_enabled:false`, so a conforming implementation should preserve that observed combination.

Vision is disabled in the newest model settings and remains outside the current successful DLIQ contract.

---

# 22. Current model configuration

The newest `/api/v0/client/settings?did=<redacted>&scope=model` response reports:

```json
[
  {
    "model_type": "default",
    "name": "Instant",
    "is_default": true,
    "enabled": true,
    "switchable": true
  },
  {
    "model_type": "expert",
    "name": "Expert",
    "is_default": false,
    "enabled": false,
    "switchable": false
  },
  {
    "model_type": "vision",
    "name": "Vision",
    "is_default": false,
    "enabled": false,
    "switchable": false
  }
]
```

This is the current UI/model gate. It does not rewrite older HAR evidence.

---

# 23. Historical model switching

Older functional captures establish that an existing chat session can transmit:

```json
{
  "model_type": "expert"
}
```

and return a `ready` event reporting:

```json
{"model_type":"expert"}
```

The same protocol transmits:

```json
{"model_type":null}
```

for the default path.

Therefore model selection is a request-level protocol field, not a field encoded into `chat_session_id`.

The current UI has the expert/vision switches disabled; this does not erase the historical wire behavior recorded in the older HARs.

---

# 24. HIF and model enforcement

Older captures establish HIF-sensitive completion enforcement for model-sensitive traffic.

Operational rule:

```text
A completion request that requires HIF client proof MUST carry the corresponding x-hif-leim value.
```

The recorded historical failure surface includes:

```text
unsupported_client_by_model
```

Treat that code as a server rejection of the client/model combination, not as a local parser error.

For current v2.3 implementations:

```text
1. Acquire fresh LEIM from hif-leim.deepseek.com/query.
2. Put data.biz_data.value in x-hif-leim.
3. Create a fresh PoW challenge for /api/v0/chat/completion.
4. Solve the challenge.
5. Send x-hif-leim and x-ds-pow-response on completion.
```

---

# 25. Client settings

The newest capture exposes `/api/v0/client/settings` with at least:

```text
scope=main
scope=model
```

Current `scope=main` values include:

```json
{
  "hif_max_retry_interval_secs": 600,
  "completion_timeout_ms": 60000,
  "edit_timeout_ms": 60000,
  "regenerate_timeout_ms": 60000,
  "continue_timeout_ms": 60000,
  "resume_timeout_ms": 60000,
  "auto_resume_ms": 3000,
  "pow_prefetch": true,
  "pow_prefetch_count": 1,
  "x-fetch-after-sec": 300
}
```

The client therefore prefetches one PoW challenge and uses a 60-second completion timeout.

---

# 26. Header matrix

| Header | Session create | PoW create | HIF-LEIM GET | Completion |
|---|---:|---:|---:|---:|
| `x-client-bundle-id` | YES | YES | YES | YES |
| `x-client-platform` | YES | YES | YES | YES |
| `x-client-version` | YES | YES | YES | YES |
| `x-client-locale` | YES | YES | YES | YES |
| `x-client-timezone-offset` | YES | YES | YES | YES |
| `Authorization` | authenticated web traffic | authenticated web traffic | NOT IN NEWEST CAPTURE | authenticated web traffic |
| `Cookie` | authenticated web traffic | authenticated web traffic | NOT IN NEWEST CAPTURE | authenticated web traffic |
| `x-ds-pow-response` | NO | NO | NO | YES |
| `x-hif-leim` | NO | NO | NO | YES |
| `x-hif-dliq` | NO | NO | NO | HISTORICALLY YES |
| `Content-Type: application/json` | YES | YES | NO | YES |
| `Accept: text/event-stream` | NO | NO | NO | YES |

The table records observed transport composition, not an assertion that every header is a hard server requirement on every endpoint.

---

# 27. Headless reproduction

A browser UI is not required to acquire the current LEIM value. The side-channel is a normal HTTP GET and the completion endpoint is a normal HTTP POST.

Canonical LEIM acquisition outside the browser:

```bash
curl 'https://hif-leim.deepseek.com/query' \
  -H 'accept: */*' \
  -H 'x-client-bundle-id: com.deepseek.chat' \
  -H 'x-client-platform: web' \
  -H 'x-client-version: 2.4.0' \
  -H 'x-client-locale: en_US' \
  -H 'x-client-timezone-offset: 3600'
```

Extract:

```text
data.biz_data.value
```

Do not add browser-only `Origin`, `Referer`, or authentication headers to this reproduction merely because older notes mentioned them; they are absent from the newest captured HIF-LEIM request.

Then send the extracted value as:

```http
x-hif-leim: <data.biz_data.value>
```

The completion request still requires normal authenticated web state and a fresh valid PoW result.

---

# 28. Deterministic headless sequence

```text
A. Authenticate normally.
B. POST /api/v0/chat_session/create with {}.
C. GET https://hif-leim.deepseek.com/query using the captured client headers.
D. Extract data.biz_data.value.
E. POST /api/v0/chat/create_pow_challenge with target_path=/api/v0/chat/completion.
F. Solve DeepSeekHashV1.
G. POST /api/v0/chat/completion as SSE.
H. Include x-hif-leim and x-ds-pow-response.
I. Parse ready.
J. Persist ready.response_message_id as the next parent_message_id.
K. Refresh LEIM after its 600-second client lifetime.
```

This is the complete current protocol flow required to reproduce the browser's HIF-assisted completion path outside the web UI.

---

# 29. HIF caching rule

Cache the opaque LEIM value for no longer than the captured 600-second lifetime.

A safe implementation may refresh earlier. It MUST NOT continue indefinitely using a value that has passed the client TTL.

Concurrent requests should share one in-flight refresh rather than issuing redundant HIF GETs.

---

# 30. HIF/DLIQ failure rules

If the HIF-LEIM GET fails:

```text
DO NOT fabricate a token.
DO NOT reuse an expired token.
DO NOT mark the request authenticated by UI state alone.
```

`x-hif-dliq` is part of historical traffic, but the newest HAR does not contain a successful DLIQ acquisition.

Therefore:

```text
Current LEIM reproduction: ESTABLISHED
Current DLIQ reproduction: NOT ESTABLISHED
Historical DLIQ use in completion: ESTABLISHED
```

---

# 31. Security boundary

The protocol requires authenticated web state for authenticated DeepSeek API calls.

Credentials, cookies, bearer values, PoW challenge contents, and captured HIF values MUST remain redacted in source-controlled documentation.

This document records protocol behavior, not reusable live credentials.

---

# 32. Conformance requirements

A v2.3-conformant implementation MUST:

```text
use /api/v0/chat_session/create for session creation
use /api/v0/chat/create_pow_challenge for PoW
send the exact target_path /api/v0/chat/completion in the PoW request
solve DeepSeekHashV1
send x-ds-pow-response on completion
acquire x-hif-leim from the HIF-LEIM GET
send x-hif-leim on HIF-protected completion
send the completion body fields exactly as documented
process completion as SSE
use ready.response_message_id as the next parent_message_id
use ready.model_type as the server-reported model-path confirmation
refresh HIF-LEIM on the 600-second client lifetime
```

---

# 33. Protocol status

```json
{
  "overall_status": "ESTABLISHED_FOR_CAPTURED_WEB_FLOW",
  "session_create": "ESTABLISHED",
  "completion": "ESTABLISHED",
  "conversation_continuation": "ESTABLISHED",
  "pow": "ESTABLISHED",
  "hif_leim_acquisition": "ESTABLISHED",
  "hif_leim_600s_lifetime": "ESTABLISHED",
  "hif_dliq_current_success": "NOT_ESTABLISHED",
  "historical_expert_wire_path": "ESTABLISHED",
  "current_default_settings_value": "ESTABLISHED",
  "current_expert_ui_switch": "DISABLED",
  "current_vision_ui_switch": "DISABLED",
  "historical_hif_model_enforcement": "ESTABLISHED",
  "ready_server_model_confirmation": "ESTABLISHED",
  "completion_input_default_string_value": "NOT_ESTABLISHED",
  "expert_search_true_acceptance": "NOT_ESTABLISHED",
  "non_null_action_schema": "UNSPECIFIED",
  "preempt_true_semantics": "UNSPECIFIED",
  "full_file_attachment_protocol": "UNSPECIFIED"
}
```

---

# 34. Normative interpretation

The browser is only one HTTP client for this protocol.

The HIF mechanism is a server-issued side-channel value delivered over HTTP and then copied into the completion header.

The protocol does not require DOM automation, JavaScript execution inside the DeepSeek page, or a browser extension to reproduce the captured HIF transport.

The required browser-equivalent behavior is HTTP-level behavior:

```text
GET HIF-LEIM
-> extract value
-> POST completion with x-hif-leim
```

The model contract is equally HTTP-level:

```text
completion request
-> requested wire model value
-> ready event
-> authoritative server-reported model path
```

This is the v2.3 interpretation of the captured DeepSeek Web endpoint.
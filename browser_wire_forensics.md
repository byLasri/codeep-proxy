# DeepSeek Browser Wire Forensics

## 1. SCOPE

This report analyzes the browser network traffic captured in `deepseek_network_basics.har` for the DeepSeek web application conversation flow. The HAR contains **68 total entries**, of which **10 are DeepSeek chat API requests** (the rest are telemetry/analytics to `gator.volces.com` and static resource loads).

The analyzed flow covers:
- Initial session creation
- First user message submission
- Message edit/continuation
- Follow-up continuation message

All sensitive credential values have been redacted with `<REDACTED>` placeholders.

---

## 2. BROWSER REQUEST SEQUENCE

| Step | Method | URL | Purpose | Depends On | Important Response Data |
|------|--------|-----|---------|------------|------------------------|
| 0 | POST | `/api/v0/chat/create_pow_challenge` | Obtain PoW challenge for completion | None | `challenge`, `salt`, `signature`, `difficulty`, `target_path` |
| 1 | POST | `/api/v0/chat_session/create` | Create new chat session | None | `chat_session.id`, `chat_session.seq_id` |
| 2 | POST | `/api/v0/chat/completion` | First user message | Steps 0, 1 | Streaming SSE with `request_message_id`, `response_message_id` |
| 3 | POST | `/api/v0/chat/create_pow_challenge` | Obtain PoW challenge for edit | None | New challenge set |
| 4 | POST | `/api/v0/chat/edit_message` | Edit first message | Step 3 | Streaming SSE, updates `parent_message_id` |
| 5 | POST | `/api/v0/chat/create_pow_challenge` | Obtain PoW challenge for continuation | None | New challenge set |
| 6 | POST | `/api/v0/chat/completion` | Continuation message | Steps 4, 5 | Streaming SSE with new `parent_message_id` |
| 7-10 | GET | `/api/v0/client/settings` | Client settings fetches | None | Various scope settings |

**Key observation:** Each completion/edit operation is preceded by a fresh PoW challenge request. The browser does NOT reuse PoW challenges.

---

## 3. SESSION CREATION

### Request

```
POST /api/v0/chat_session/create
Host: chat.deepseek.com
Content-Type: application/json
Content-Length: 2
Authorization: Bearer <REDACTED>
Cookie: aws-waf-token=<REDACTED>; smidV2=<REDACTED>; .thumbcache_...=<REDACTED>; ds_session_id=<REDACTED>
Origin: https://chat.deepseek.com
Referer: https://chat.deepseek.com/a/chat/s/<session-id>
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.5.0
x-client-locale: en_GB
x-client-timezone-offset: -25200
x-device-id: <device-id>
x-device-model: (empty)
```

**Request Body:**
```json
{}
```

### Response

```
Status: 200
Content-Type: application/json
```

**Response Body:**
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "chat_session": {
        "id": "<uuid>",
        "seq_id": 211696375,
        "agent": "chat",
        "model_type": "default",
        "title": null,
        "title_type": "WIP",
        "version": 0,
        "current_message_id": null,
        "pinned": false,
        "inserted_at": <timestamp>,
        "updated_at": <timestamp>
      },
      "ttl_seconds": 259200
    }
  }
}
```

**Key fields extracted:**
- `chat_session.id` → used as `chat_session_id` in subsequent requests
- `chat_session.seq_id` → internal sequence identifier
- `chat_session.current_message_id` → initially `null`

---

## 4. FIRST MESSAGE

### Prerequisites

Before the first completion request, the browser:
1. Creates a PoW challenge (Step 0)
2. Creates a session (Step 1)

### Request

```
POST /api/v0/chat/completion
Host: chat.deepseek.com
Content-Type: application/json
Authorization: Bearer <REDACTED>
Cookie: aws-waf-token=<REDACTED>; smidV2=<REDACTED>; .thumbcache_...=<REDACTED>; ds_session_id=<REDACTED>
Origin: https://chat.deepseek.com
Referer: https://chat.deepseek.com/a/chat/s/<session-id>
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.5.0
x-client-locale: en_GB
x-client-timezone-offset: -25200
x-device-id: <device-id>
x-device-model: (empty)
x-ds-pow-response: <base64-encoded PoW solution>
```

**Request Body:**
```json
{
  "chat_session_id": "<session-id-from-step-1>",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "hello, I want to code jforex platform strategy, can you help ? do not code yet",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

### Response

```
Status: 200
Content-Type: text/event-stream; charset=utf-8
```

**Streaming Response Structure:**
```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

event: update_session
data: {"updated_at":<timestamp>}

data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT",...}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":"We need answer..."}
... (streaming content fragments)

data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":<n>},{"p":"quasi_status","v":"FINISHED"}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: update_session
data: {"updated_at":<timestamp>}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

**Key observations:**
- `request_message_id`: The ID of the user's request message (1)
- `response_message_id`: The ID of the assistant's response message (2)
- `parent_id`: References the parent message (1 = the user's message)
- After this response, `parent_message_id` for continuation should be `2` (the last assistant message)

---

## 5. FIRST EDIT / CONTINUATION

### Edit Message Request

When the user edits the first message, the browser sends:

```
POST /api/v0/chat/edit_message
Host: chat.deepseek.com
Content-Type: application/json
Authorization: Bearer <REDACTED>
Cookie: aws-waf-token=<REDACTED>; smidV2=<REDACTED>; .thumbcache_...=<REDACTED>; ds_session_id=<REDACTED>
Origin: https://chat.deepseek.com
Referer: https://chat.deepseek.com/a/chat/s/<session-id>
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.5.0
x-client-locale: en_GB
x-client-timezone-offset: -25200
x-device-id: <device-id>
x-device-model: (empty)
x-ds-pow-response: <base64-encoded PoW solution for edit>
```

**Request Body:**
```json
{
  "chat_session_id": "<same-session-id>",
  "message_id": 1,
  "ref_file_ids": [],
  "prompt": "hello, I want to code jforex platform strategy in java, can you help ? do not code yet",
  "search_enabled": false,
  "thinking_enabled": true,
  "action": null
}
```

**Key fields:**
- `message_id`: The ID of the message being edited (1 = first user message)
- `prompt`: The new/edited prompt content
- No `parent_message_id` field in edit request

### Edit Response

Similar streaming structure to completion, returning:
- `request_message_id`: 3 (new edit request message)
- `response_message_id`: 4 (new assistant response to edit)

After the edit, the conversation state has:
- Last user message ID: 3
- Last assistant message ID: 4

### Continuation Completion Request

After the edit, when the user sends a follow-up message:

```
POST /api/v0/chat/completion
Host: chat.deepseek.com
Content-Type: application/json
Authorization: Bearer <REDACTED>
Cookie: aws-waf-token=<REDACTED>; smidV2=<REDACTED>; .thumbcache_...=<REDACTED>; ds_session_id=<REDACTED>
Origin: https://chat.deepseek.com
Referer: https://chat.deepseek.com/a/chat/s/<session-id>
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.5.0
x-client-locale: en_GB
x-client-timezone-offset: -25200
x-device-id: <device-id>
x-device-model: (empty)
x-ds-pow-response: <base64-encoded PoW solution for continuation>
```

**Request Body:**
```json
{
  "chat_session_id": "<same-session-id>",
  "parent_message_id": 4,
  "model_type": null,
  "prompt": "I want trendline breakout strategy, you know it ?",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

**Critical observation:**
- `parent_message_id: 4` → This is the **last assistant message ID** from the previous turn
- `model_type: null` → For continuation, model_type can be null (inherits from session)
- The `prompt` is the NEW user message, NOT a repetition of previous content

---

## 6. HEADER MATRIX

| Header | Session Create | PoW Challenge | First Completion | Edit Message | Continuation | Browser Origin | Notes |
|--------|----------------|---------------|------------------|--------------|--------------|----------------|-------|
| `authorization` | YES | YES | YES | YES | YES | Browser auth token | Bearer token present on all requests |
| `cookie` | YES | YES | YES | YES | YES | Browser cookies | Same cookie set on all |
| `origin` | YES | YES | YES | YES | YES | `https://chat.deepseek.com` | Always same-origin |
| `referer` | YES | YES | YES | YES | YES | `https://chat.deepseek.com/a/chat/s/<session>` | Includes session ID |
| `x-client-bundle-id` | YES | YES | YES | YES | YES | `com.deepseek.chat` | Constant |
| `x-client-platform` | YES | YES | YES | YES | YES | `web` | Constant |
| `x-client-version` | YES | YES | YES | YES | YES | `2.5.0` | Constant |
| `x-client-locale` | YES | YES | YES | YES | YES | `en_GB` | From browser settings |
| `x-client-timezone-offset` | YES | YES | YES | YES | YES | `-25200` | Seconds offset |
| `x-device-id` | YES | YES | YES | YES | YES | `<uuid>` | Persistent device ID |
| `x-device-model` | YES | YES | YES | YES | YES | (empty) | Empty string |
| `x-ds-pow-response` | NO | NO | YES | YES | YES | Computed PoW solution | Only on completion/edit |
| `accept` | `*/*` | `*/*` | `*/*` | `*/*` | `*/*` | Browser default | All use wildcard |
| `content-type` | `application/json` | `application/json` | `application/json` | `application/json` | `application/json` | Always JSON |

**Notes:**
- All DeepSeek API requests include the same authentication headers
- `x-ds-pow-response` is ONLY present on completion and edit requests (not on session create or PoW challenge)
- The `referer` header includes the session ID, linking requests to the specific conversation

---

## 7. COOKIE MATRIX

| Cookie Name | Session Create | PoW Challenge | First Completion | Edit Message | Continuation | Notes |
|-------------|----------------|---------------|------------------|--------------|--------------|-------|
| `aws-waf-token` | YES | YES | YES | YES | YES | AWS WAF protection token |
| `smidV2` | YES | YES | YES | YES | YES | Session/marketing ID |
| `.thumbcache_<hash>` | YES | YES | YES | YES | YES | Thumbnail cache cookie |
| `ds_session_id` | YES | YES | YES | YES | YES | DeepSeek session cookie |

**Observations:**
- All four cookies are present on every DeepSeek API request
- Cookies appear to be set before the observed sequence begins (likely during login/page load)
- No new cookies are set during the observed conversation flow
- Cookie VALUES must never be committed to repository (use `<REDACTED>`)

---

## 8. BODY FIELD MATRIX

| Field | Session Create | PoW Challenge | First Completion | Edit Message | Continuation | Value/Type | Notes |
|-------|----------------|---------------|------------------|--------------|--------------|------------|-------|
| `chat_session_id` | N/A | N/A | string (UUID) | string (UUID) | string (UUID) | From session create response | Required for completion/edit |
| `parent_message_id` | N/A | N/A | `null` | N/A | number | `null` for first turn, message ID for continuation | Critical for conversation threading |
| `message_id` | N/A | N/A | N/A | number | N/A | ID of message being edited | Edit-only field |
| `model_type` | N/A | N/A | `"default"` | N/A | `null` | `"default"`, `"expert"`, or `null` | Null allowed for continuation |
| `prompt` | N/A | N/A | string | string | string | User message content | Required for completion/edit |
| `ref_file_ids` | N/A | N/A | `[]` | `[]` | `[]` | Empty array | Fixed protocol constant |
| `thinking_enabled` | N/A | N/A | `true` | `true` | `true` | Boolean | User setting |
| `search_enabled` | N/A | N/A | `false` | `false` | `false` | Boolean | User setting |
| `action` | N/A | N/A | `null` | `null` | `null` | `null` | Fixed protocol constant |
| `preempt` | N/A | N/A | `false` | N/A | `false` | `false` | Fixed protocol constant |
| `target_path` | N/A | `"/api/v0/chat/completion"` | N/A | N/A | N/A | Target endpoint for PoW | PoW challenge only |

**Critical protocol constants:**
- `action`: ALWAYS `null` (never omitted, always explicit null)
- `preempt`: ALWAYS `false`
- `ref_file_ids`: ALWAYS `[]` (empty array, never omitted)
- `parent_message_id`: `null` for first turn, numeric message ID for continuation

---

## 9. CURRENT PROXY VS BROWSER

| Area | Browser | Current Proxy | Status | Evidence |
|------|---------|---------------|--------|----------|
| **Session Creation** | POST `{}` to `/api/v0/chat_session/create` | Matches | MATCH | HAR entry 1, `src/deepseek_api/session.ts` |
| **PoW Challenge** | POST `{"target_path":"/api/v0/chat/completion"}` | Matches | MATCH | HAR entry 0, `src/deepseek_api/pow-challenge.ts` |
| **Completion Headers** | Includes `x-ds-pow-response`, all client headers | Uses `buildCompletionHeaders` with PoW | MATCH | HAR entry 2, `src/deepseek_api/headers.ts` |
| **Completion Body - action** | Explicit `null` | Fixed `FIXED_ACTION = null` | MATCH | HAR entry 2, `src/deepseek_api/completion.ts:31` |
| **Completion Body - preempt** | Explicit `false` | Fixed `FIXED_PREEMPT = false` | MATCH | HAR entry 2, `src/deepseek_api/completion.ts:32` |
| **Completion Body - ref_file_ids** | Explicit `[]` | Fixed `FIXED_REF_FILE_IDS: []` | MATCH | HAR entry 2, `src/deepseek_api/completion.ts:33` |
| **Completion Body - parent_message_id** | `null` (first), number (continuation) | From `state.parent_message_id` | MATCH | HAR entries 2 & 6, `src/deepseek_api/completion.ts:37` |
| **Completion Body - model_type** | `"default"` (first), `null` (continuation) | Required field from options | PARTIAL | HAR shows `null` allowed for continuation; proxy requires explicit value |
| **Edit Message Endpoint** | POST to `/api/v0/chat/edit_message` | NOT IMPLEMENTED | MISSING | HAR entry 4, no corresponding proxy implementation |
| **Edit Message Body** | `{"chat_session_id", "message_id", "prompt", ...}` | N/A | MISSING | HAR entry 4 |
| **HIF-LEIM Header** | NOT PRESENT in observed HAR | Required in `buildCompletionHeaders` | PARTIAL | HAR shows no `x-hif-leim` header; proxy adds it |
| **Timezone Offset** | `-25200` (PST/PDT) | `DEFAULT_TIMEZONE_OFFSET` (`"3600"`) | MISMATCH | HAR shows browser-specific offset; proxy uses fixed value |
| **PoW Per-Request** | Fresh PoW for each completion/edit | Cached PoW solution | PARTIAL | HAR shows new PoW challenge before each operation |

---

## 10. SECURITY / FINGERPRINT GAPS

### Gap 1: HIF-LEIM Header Presence
- **Browser:** Does NOT send `x-hif-leim` header in the observed HAR
- **Proxy:** Currently adds `x-hif-leim` header via `buildCompletionHeaders`
- **Impact:** May cause request rejection if DeepSeek validates HIF-LEIM presence/timing
- **Evidence:** HAR entries 2, 4, 6 show no `x-hif-leim` header in request headers list

### Gap 2: Timezone Offset Hardcoding
- **Browser:** Sends `-25200` (Pacific Daylight Time, UTC-7)
- **Proxy:** Uses hardcoded `"3600"` (Central European Time, UTC+1)
- **Impact:** Fingerprint mismatch; timezone is part of device fingerprinting
- **Evidence:** HAR header analysis shows `x-client-timezone-offset: -25200`

### Gap 3: Device ID Persistence
- **Browser:** Uses persistent `x-device-id` across all requests
- **Proxy:** Implementation unclear; may generate per-session
- **Impact:** Missing device continuity for fingerprinting
- **Evidence:** HAR shows identical `x-device-id` on all requests

### Gap 4: PoW Challenge Freshness
- **Browser:** Fetches fresh PoW challenge before EACH completion/edit
- **Proxy:** Caches PoW solution
- **Impact:** Stale PoW may be rejected if expiration window passed
- **Evidence:** HAR shows three separate PoW challenge requests (entries 0, 3, 5)

---

## 11. PROTOCOL GAPS

### Gap 1: Edit Message Endpoint Not Implemented
- **Browser:** Uses `POST /api/v0/chat/edit_message` for message edits
- **Proxy:** No implementation found for edit endpoint
- **Impact:** Cannot replicate browser edit behavior
- **Evidence:** HAR entry 4, no matching `src/deepseek_api/*.ts` file

### Gap 2: Edit-to-Continuation Flow
- **Browser:** After edit, continuation uses `parent_message_id` from edit response
- **Proxy:** Unclear how edit affects conversation state tracking
- **Impact:** Continuation after edit may use wrong `parent_message_id`
- **Evidence:** HAR shows edit returns `response_message_id: 4`, next completion uses `parent_message_id: 4`

### Gap 3: Model Type Handling
- **Browser:** Uses `null` for `model_type` in continuation requests
- **Proxy:** Requires explicit `model_type` in `buildCompletionRequest` options
- **Impact:** May send non-null `model_type` where browser sends `null`
- **Evidence:** HAR entry 6 shows `"model_type": null`

### Gap 4: Response Message ID Tracking
- **Browser:** Extracts `response_message_id` from SSE `ready` event
- **Proxy:** May not track this for state management
- **Impact:** Cannot properly set `parent_message_id` for continuation
- **Evidence:** HAR response shows `{"request_message_id":1,"response_message_id":2,...}`

---

## 12. IMPLEMENTATION ORDER RECOMMENDATION

Based on dependency analysis:

1. **Device ID persistence** — Store and reuse `x-device-id` across sessions (fingerprint foundation)

2. **Timezone offset correction** — Use browser-appropriate timezone offset instead of hardcoded value

3. **HIF-LEIM requirement validation** — Confirm whether `x-hif-leim` is actually required or optional; remove if not needed

4. **PoW challenge per-request** — Fetch fresh PoW before each completion/edit instead of caching

5. **Edit message endpoint** — Implement `POST /api/v0/chat/edit_message` with proper body structure

6. **Response message ID extraction** — Parse SSE `ready` event to extract `response_message_id` for state tracking

7. **Model type null handling** — Allow `null` for `model_type` in continuation requests

8. **Conversation state management** — Ensure `parent_message_id` correctly tracks last assistant message after edit operations

---

## 13. UNKNOWNS

1. **HIF-LEIM necessity:** The HAR does not show `x-hif-leim` header, but the proxy implementation assumes it's required. Unclear if this is:
   - A recent DeepSeek change (HAR may be outdated)
   - Environment-specific (HAR from different region/account tier)
   - Optional header that proxy incorrectly treats as required

2. **PoW expiration window:** HAR shows `expire_after: 300000` (5 minutes), but actual tolerance unknown

3. **Device ID generation algorithm:** How the browser generates `x-device-id` is not visible in HAR

4. **Cookie rotation policy:** Whether cookies rotate during longer sessions is not observable in this short HAR

5. **Error conditions:** HAR only shows successful (200) responses; error handling requirements unknown

6. **Streaming parsing edge cases:** HAR truncates long streaming responses; complete SSE structure for edge cases (errors, tool calls, etc.) not fully visible

7. **Tool call wire format:** This HAR does not contain tool-calling scenarios; DSML protocol differences unknown

---

## Summary

The browser wire contract is now documented. Key findings:

- **Session creation** and **PoW challenge** implementations match the browser
- **Completion request** structure is correct but has gaps in HIF-LEIM usage and timezone handling
- **Edit message endpoint** is completely missing from proxy implementation
- **Continuation logic** depends on proper `parent_message_id` tracking from SSE responses
- **Fingerprint headers** (timezone, device ID) need alignment with browser behavior

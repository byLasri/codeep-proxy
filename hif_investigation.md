# DeepSeek HIF Investigation

## Version

```text
investigation_version = "2.3"
subject = "DeepSeek Web HIF / LEIM transport"
source_precedence = "HAR captures"
current_primary_capture = "extensive_usage_network_test.har"
```

---

## 1. Executive summary

`x-hif-leim` is a server-issued value obtained from a dedicated HTTP side-channel:

```text
GET https://hif-leim.deepseek.com/query
```

The current browser does not compute the value locally.

The current browser obtains:

```text
response.data.biz_data.value
```

and sends that exact opaque value on chat completion as:

```text
x-hif-leim: <value>
```

The current capture establishes a 600-second client lifetime for the value.

The current capture also establishes that the HIF-LEIM GET is made with DeepSeek client identity headers and `Accept: */*`, without `Authorization`, `Cookie`, `Origin`, or `Referer`.

The previous repository description that treated the value as a browser fingerprint, a JWT, or a bearer-token exchange was incorrect and is superseded by this document.

---

## 2. Evidence hierarchy

The repository contains multiple generations of DeepSeek network captures.

The interpretation used here is:

```text
1. extensive_usage_network_test.har       CURRENT
2. reload_for_hif.har                     OLDER FUNCTIONAL CAPTURE
3. V4-pro-plus-login.har                  OLDER FUNCTIONAL CAPTURE
4. dev-browser-20260910-001517.har        OLDER FUNCTIONAL CAPTURE
```

The newest HAR controls the current protocol description.

Older HARs remain authoritative evidence for historical behavior that is absent from or disabled by the newest UI configuration, especially model switching and HIF-related enforcement.

---

## 3. HIF-LEIM endpoint

Canonical endpoint:

```http
GET https://hif-leim.deepseek.com/query
```

Current captured request headers:

```http
accept: */*
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.4.0
x-client-locale: en_US
x-client-timezone-offset: 3600
```

Current captured request properties:

```text
Authorization: absent
Cookie: absent
Origin: absent
Referer: absent
```

These omissions are significant because the current capture is the actual browser wire request. A headless implementation should reproduce this request rather than add credentials or browser navigation headers that are not present on the wire.

---

## 4. HIF-LEIM response schema

The successful current response is:

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

The extraction path is deterministic:

```text
data.biz_data.value
```

Do not search the response for an alternate token field.

---

## 5. HIF-LEIM value format

The current captured value is a two-segment dot-delimited opaque string.

It is not a standard three-segment JWT.

Therefore all of the following are incorrect implementation strategies:

```text
JWT decode
JWT claim extraction
local signature reconstruction
JSON payload parsing
browser fingerprint derivation
```

The correct operation is byte-for-byte propagation of the returned string.

```text
HTTP response value
    |
    +--> data.biz_data.value
            |
            +--> x-hif-leim
```

No transformation occurs between acquisition and completion header injection.

---

## 6. HIF lifetime

The newest HAR contains client telemetry reporting:

```json
{
  "ds_ttl": 600
}
```

The newest client settings also define:

```json
{
  "hif_max_retry_interval_secs": 600
}
```

The current client therefore treats the LEIM value as a 600-second value.

Implementation rule:

```text
LEIM validity window = 600 seconds
```

A proxy MUST refresh the value before continuing after this client lifetime.

A proxy MAY refresh earlier.

---

## 7. HIF refresh behavior

The browser performs the HIF GET as a side-channel request separate from chat session creation.

The observed client behavior is:

```text
need HIF
   |
   +--> GET hif-leim.deepseek.com/query
           |
           +--> success -> cache value
           |
           +--> failure -> retry according to client retry policy
```

The exact exponential/backoff sequence is not part of the wire contract. The only deterministic configuration captured for this behavior is the 600-second maximum retry interval setting.

---

## 8. HIF injection point

The value is inserted into the completion request as:

```http
x-hif-leim: <hif_leim_value>
```

It is not inserted into:

```text
chat_session/create
create_pow_challenge
```

The current flow is therefore:

```text
GET HIF-LEIM
      |
      v
cache opaque value
      |
      +--------------------+
                           |
POST /api/v0/chat/completion
      |
      +--> x-hif-leim
      +--> x-ds-pow-response
```

---

## 9. Relationship to PoW

HIF-LEIM and PoW are independent transport components.

PoW creation:

```http
POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge
Content-Type: application/json

{"target_path":"/api/v0/chat/completion"}
```

Observed PoW algorithm:

```text
DeepSeekHashV1
```

PoW transport:

```text
x-ds-pow-response: <solved-result>
```

HIF transport:

```text
x-hif-leim: <opaque-value>
```

A correct headless implementation performs both operations.

---

## 10. HIF and chat sessions

The HIF GET does not use `chat_session_id`.

The HIF value is therefore not a chat-session identifier and is not obtained from `/api/v0/chat_session/create`.

The protocol relationship is:

```text
chat_session_id -> completion body
hif_leim        -> completion header
```

They are transported through different protocol fields and acquired through different requests.

---

## 11. HIF and authentication

The current HIF-LEIM acquisition request contains no `Authorization` or `Cookie` header in the newest HAR.

Therefore the old description:

```text
GET /query using Authorization: Bearer <user-token>
```

is not the current wire protocol.

Likewise, adding:

```text
Origin: https://chat.deepseek.com
Referer: https://chat.deepseek.com/
```

is not required to reproduce the captured current request.

Authenticated state still applies to the authenticated DeepSeek web API operations. That is separate from the current HIF-LEIM GET header composition.

---

## 12. HIF-LEIM acquisition outside the web UI

The current browser behavior can be reproduced with a normal HTTP request.

Canonical request:

```bash
curl 'https://hif-leim.deepseek.com/query' \
  -H 'accept: */*' \
  -H 'x-client-bundle-id: com.deepseek.chat' \
  -H 'x-client-platform: web' \
  -H 'x-client-version: 2.4.0' \
  -H 'x-client-locale: en_US' \
  -H 'x-client-timezone-offset: 3600'
```

The response is JSON.

Extract exactly:

```text
data.biz_data.value
```

Then copy the result unchanged into:

```http
x-hif-leim: <data.biz_data.value>
```

No browser DOM automation is involved.

No JavaScript running in `chat.deepseek.com` is required for this transport step.

---

## 13. Headless completion sequence

A complete browser-equivalent HIF-assisted request is:

```text
1. Authenticate for DeepSeek chat API use.
2. POST /api/v0/chat_session/create with {}.
3. GET https://hif-leim.deepseek.com/query.
4. Extract data.biz_data.value.
5. POST /api/v0/chat/create_pow_challenge.
6. Send {"target_path":"/api/v0/chat/completion"}.
7. Solve DeepSeekHashV1.
8. POST /api/v0/chat/completion.
9. Set Accept: text/event-stream.
10. Set x-hif-leim to the extracted HIF value.
11. Set x-ds-pow-response to the solved PoW value.
12. Send the normal completion JSON body.
13. Parse the SSE ready event.
14. Store ready.response_message_id.
15. Use that value as parent_message_id on the next turn.
```

This is the direct HTTP protocol. The browser UI is not a required dependency.

---

## 14. Completion body used with HIF

The normal body remains:

```json
{
  "chat_session_id": "<session>",
  "parent_message_id": "<number-or-null>",
  "model_type": null,
  "prompt": "<prompt>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

The HIF layer changes the request headers, not the chat JSON schema.

---

## 15. HIF-DLIQ endpoint

The related side-channel is:

```http
GET https://hif-dliq.deepseek.com/query
```

Current newest-HAR status:

```text
requests occur
requests fail as network/XHR errors
no successful token value is captured
```

Therefore the current working DLIQ acquisition algorithm is not established by the newest traffic.

Do not infer a token format from old documentation.

Do not fabricate `x-hif-dliq`.

---

## 16. Historical DLIQ behavior

Older functional captures contain `x-hif-dliq` on completion traffic.

This establishes that DLIQ was part of the historical HIF header set.

It does not establish a current successful DLIQ retrieval path in the latest client.

Normative state:

```json
{
  "historical_header": "x-hif-dliq",
  "historical_completion_use": "ESTABLISHED",
  "current_successful_acquisition": "NOT_ESTABLISHED"
}
```

---

## 17. Model selection and HIF enforcement

Older functional captures establish a working `expert` model wire path.

The completion request represents the model as:

```json
{"model_type":"expert"}
```

and the SSE `ready` event reports:

```json
{"model_type":"expert"}
```

The default path uses:

```json
{"model_type":null}
```

The newest client settings currently mark the expert and vision models as disabled and non-switchable in the UI.

Therefore two separate facts must be retained:

```text
historical wire support for model_type="expert" = established
current UI exposure of Expert/Vision = disabled
```

The older capture set also establishes HIF-sensitive model enforcement, including the server rejection surface:

```text
unsupported_client_by_model
```

Operationally, the headless client should always acquire and inject HIF before attempting model-sensitive completion traffic.

---

## 18. Why HIF must be fetched rather than generated

The capture shows the browser requesting the value from a dedicated server hostname and then reusing the returned value as a completion header.

There is no captured local generation step that derives the value from browser state.

Therefore the implementation boundary is:

```text
client implementation
    |
    +--> fetch HIF value
    |
    +--> forward HIF value
```

not:

```text
client implementation
    |
    +--> reproduce DeepSeek signing algorithm locally
```

The private signing mechanism is not part of the web client wire contract.

---

## 19. Cache design

A correct implementation should maintain one cached LEIM value per HIF acquisition context and refresh it on expiry.

A practical state object is:

```json
{
  "value": "<opaque>",
  "acquired_at": "<timestamp>",
  "expires_at": "<acquired_at + 600s>"
}
```

Do not store live captured HIF values in source control.

For concurrent completions:

```text
cache hit -> reuse current value
cache miss -> one in-flight GET
parallel callers -> await same GET
success -> publish new value
failure -> surface error
```

This avoids generating a separate HIF request for every completion.

---

## 20. Refresh policy

The deterministic minimum rule is:

```text
refresh when the cached value reaches 600 seconds of age
```

Refreshing slightly before 600 seconds is permitted and is operationally safer.

An implementation MUST NOT treat the value as permanent session state.

---

## 21. Failure handling

If HIF acquisition fails:

```text
1. Do not fabricate a value.
2. Do not alter the returned JSON structure.
3. Do not send an empty x-hif-leim header.
4. Do not use a known-expired value indefinitely.
5. Retry according to implementation policy.
6. Propagate a definitive error if acquisition cannot succeed.
```

The browser configuration exposes a maximum retry interval setting of 600 seconds. It does not establish one universal backoff formula.

---

## 22. Current HIF wire recipe

The current protocol can be reduced to this exact transformation:

```text
GET https://hif-leim.deepseek.com/query
        |
        v
JSON.data.biz_data.value
        |
        v
completion header: x-hif-leim
```

The HIF service is therefore a side-channel token source, not a second chat completion endpoint.

---

## 23. Current protocol recipe with PoW

```text
                         +----------------------------+
                         | hif-leim.deepseek.com      |
                         | GET /query                 |
                         +-------------+--------------+
                                       |
                                       | value
                                       v
+----------------+         +-----------+-----------+         +----------------------+
| chat_session   |-------->| completion request    |<--------| PoW challenge        |
| /create        | session | x-hif-leim             | solved  | /create_pow_challenge|
+----------------+         | x-ds-pow-response     |         +----------------------+
                           | JSON body              |
                           +-----------+------------+
                                       |
                                       v
                         https://chat.deepseek.com
                         POST /api/v0/chat/completion
                         SSE response
```

---

## 24. Exact current acquisition recipe

### Request

```http
GET /query HTTP/1.1
Host: hif-leim.deepseek.com
Accept: */*
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.4.0
x-client-locale: en_US
x-client-timezone-offset: 3600
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "code":0,
  "msg":"",
  "data":{
    "biz_code":0,
    "biz_msg":"",
    "biz_data":{
      "value":"<opaque-hif-leim>"
    }
  }
}
```

### Extraction

```text
hif_leim = json.data.biz_data.value
```

### Completion injection

```http
x-hif-leim: <opaque-hif-leim>
```

No transformation occurs.

---

## 25. What is proven by the current HAR

```text
HIF-LEIM has a dedicated GET endpoint.                         PROVEN
The browser sends client identity headers to that endpoint.   PROVEN
The newest GET lacks Authorization/Cookie/Origin/Referer.     PROVEN
The response value is data.biz_data.value.                    PROVEN
The current value is opaque and two-segment dot-delimited.    PROVEN
The current client reports ds_ttl=600.                        PROVEN
The current settings expose hif_max_retry_interval_secs=600.  PROVEN
Completion carries x-hif-leim in the HIF flow.                PROVEN
PoW remains separate from HIF.                                PROVEN
Current DLIQ requests fail without a captured value.          PROVEN
Current Expert/Vision UI switches are disabled.               PROVEN
Older captures contain expert model requests.                 PROVEN
```

---

## 26. What must no longer be claimed

The following statements are obsolete and MUST NOT be used in project documentation:

```text
"x-hif-leim is a browser fingerprint"
"x-hif-leim is a standard JWT"
"HIF-LEIM GET requires Authorization in the current capture"
"HIF-LEIM GET requires Origin/Referer in the current capture"
"the current client has a successful DLIQ retrieval flow"
"expert and vision are currently switchable in the latest UI"
```

---

## 27. Implementation boundary

The HIF mechanism is reproducible outside the web UI at the HTTP protocol level.

A conforming client needs:

```text
an HTTP client
valid DeepSeek authenticated API state
client identity headers
HIF-LEIM GET
PoW challenge/solver
SSE parser
conversation state management
```

It does not need:

```text
DOM automation
browser extensions
page-injected JavaScript
UI button clicks
```

---

## 28. Final deterministic answer

The current DeepSeek HIF mechanism used by the web client is:

```text
1. GET https://hif-leim.deepseek.com/query with the captured client identity headers.
2. Read data.biz_data.value from the JSON response.
3. Treat that string as opaque.
4. Cache it for 600 seconds at most.
5. Put it unchanged in x-hif-leim on /api/v0/chat/completion.
6. Independently obtain and solve a PoW challenge for /api/v0/chat/completion.
7. Send x-ds-pow-response together with x-hif-leim.
8. Stream the completion as SSE.
9. Use ready.response_message_id as the next parent_message_id.
```

That is the HTTP-level HIF behavior established by the checked-in network evidence.

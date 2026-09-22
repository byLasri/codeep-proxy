# DeepSeek Android App — Full Protocol Capture

**Status:** Reference / future migration. **Not implemented.** The proxy still runs the web profile.

**Source:** DeepSeek Android `2.5.3` (versionCode 276, targetSdk 36) on MEmu (Android 9, SDK 28, x86_64), captured via mitmproxy with a system-trusted CA. 66 flows across app launch, session listing, one full chat turn, and idle telemetry.

**Why this matters:** The mobile app talks to the **same `chat.deepseek.com/api/v0/*` backend** as the web client, with the same POW algorithm and the same SSE response format. Migrating the proxy to the mobile profile is a header/body delta, not a protocol rewrite.

---

## 1. Migration summary (future work)

| Aspect | Web (current proxy) | Android 2.5.3 | Action |
|---|---|---|---|
| `x-client-platform` | `web` | `android` | change |
| `x-client-version` | `2.5.0` | `2.5.3` | change |
| `user-agent` | none | `DeepSeek/2.5.3 Android/28` | add |
| `accept` (completion) | `*/*` | `application/json` | change |
| `origin` | present | **absent** | remove |
| `referer` | `.../a/chat/s/<id>` | **absent** | remove |
| `x-hif-leim` | required | **absent on completion** | remove requirement |
| `x-device-id` | UUID v4 | base64 device id (server-issued) | change |
| `x-device-model` | empty | real model (`NX809J`) | change |
| `x-rangers-id` | absent | present (numeric string) | add |
| completion body | 9 fields | 9 fields + `audio_id: null` | add field |
| POW | `DeepSeekHashV1` | `DeepSeekHashV1` | unchanged |
| SSE response | standard | standard | unchanged |
| `x-ds-pow-response` | present | present | unchanged |

**Key simplification:** HIF-LEIM (`hif-leim.deepseek.com/query`) is called at startup by the app but **not attached to `/chat/completion`**. The current proxy treats it as a required side-channel for every completion. Under the mobile profile that dependency can be dropped entirely.

**Recommendation:** implement the mobile profile as a selectable mode (web/mobile) rather than a hard replacement.

---

## 2. Endpoint inventory

### 2.1 DeepSeek backend (`chat.deepseek.com`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v0/ip_to_country_code` | no | Geo lookup on launch |
| POST | `/api/v0/chat_session/create` | yes | Create chat session |
| POST | `/api/v0/chat/create_pow_challenge` | yes | Get POW challenge for `target_path` |
| POST | `/api/v0/chat/completion` | yes | The completion call (SSE) |
| GET | `/api/v0/chat/history_messages?chat_session_id=<id>&scenario=stream_close` | yes | Re-fetch messages after stream close |
| GET | `/api/v0/chat_session/fetch_page` | yes | List sessions |
| GET | `/api/v0/chat/tts/voices` | yes | TTS voice catalog |
| GET | `/api/v0/users/current` | yes | Current user profile |
| POST | `/api/v0/users/auth_token/check_device` | yes | Device check (returns `rotate`) |
| GET | `/api/v0/client/settings?scope=<provider\|voice\|model\|main>&did=<device_id>` | yes | Remote settings |
| POST | `/api/v0/client/settings/report` | yes | Report applied setting ids |
| GET | `/api/v0/check_client_update?scenario=launch&region=<cc>` | no | Update check |

### 2.2 Side-channel (`hif-leim.deepseek.com`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/query` | no | Returns opaque `value` for `x-hif-leim` |

Called ~10x during launch/telemetry. **Not sent on completion in the mobile profile.**

### 2.3 Third-party (analytics / anti-fraud — do NOT replicate)

| Host | Path(s) | Purpose |
|---|---|---|
| `www.googleapis.com` | `/androidantiabuse/v1/x/create?alt=PROTO&key=AIzaSy...` | Google DroidGuard / Play Integrity anti-abuse. protobuf. |
| `firebaselogging.googleapis.com` | `/v0cc/log/batch` | Firebase logging |
| `firebaselogging-pa.googleapis.com` | `/v1/firelog/legacy/batchlog` | Firebase logging |
| `play.googleapis.com` | `/play/log?format=raw&proto_v2=true` | Play logging |
| `play-fe.googleapis.com` | `/fdfe/getBillingConfig` | Play billing |
| `gator.volces.com` | `/service/2/profile/`, `/service/2/app_log/`, `/service/2/log_settings/` | ByteDance analytics |
| `tab.volces.com` | `/service/2/abtest_config/` | ByteDance A/B testing |
| `apmplus.volces.com` | `/monitor/collect/c/cloudcontrol/get`, `/settings/get` | ByteDance APM |
| `fp-sa-it-acc.fengkongcloud.com` | `/v3/cloudconf`, `/deviceprofile/v4` | Fengkong (Shumei) anti-fraud |
| `www.microvirt.com` | `/new_market/...` | MEmu emulator itself, not the app |

### Note on `androidantiabuse`
The `/antiabuse` endpoint is **Google DroidGuard**, not DeepSeek. It sends `application/x-protobuf` (~744 bytes of device fingerprint: BOARD, BRAND, FINGERPRINT, MODEL, ABI, VERSION.*), returns a large (~610 KB) protobuf blob, header `user-agent: DroidGuard/255034008`. No DeepSeek auth. Irrelevant to the chat protocol.

---

## 3. Complete header sets

### 3.1 Common app headers (all DeepSeek authenticated calls)

```
x-client-platform: android
x-client-version: 2.5.3
x-client-locale: en_US
x-client-bundle-id: com.deepseek.chat
x-rangers-id: 7685111460929750020        # empty string ("") on first launch, then numeric
x-client-timezone-offset: 28800           # seconds, browser/device convention
x-device-model: NX809J
x-device-id: wR1495uB7x9nBHSk79oHsBaxTtihyhspsZQSm6SeHYk=
user-agent: DeepSeek/2.5.3 Android/28
authorization: Bearer <token>
accept: application/json
accept-charset: UTF-8
accept-encoding: gzip
```

Notes:
- `x-rangers-id` is empty on initial unauthenticated calls, populated with a large numeric string after launch.
- `x-device-id` is a base64 string (server-issued), not a UUID. Appears in settings query params as `did=<urlencoded>`.
- No `origin`, no `referer`, no `cookie` on API calls (unlike web).
- `content-type: application/json` only on POST bodies.

### 3.2 Per-endpoint deltas

**`POST /api/v0/chat/completion`** — adds:
```
x-ds-pow-response: <base64, len~364>
content-type: application/json
content-length: 232
```
No `x-hif-leim`. This is the critical difference.

**`POST /api/v0/chat/create_pow_challenge`** — `content-type` + body only. Response sets `set-cookie: ds_session_id=...; HttpOnly; Path=/; SameSite=strict; Secure`.

**`GET /api/v0/client/settings`** — adds:
```
x-settings-token: <JWE, len~357>   # eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0...
x-device-id: <base64>
```
`x-settings-token` is a JWE (`alg: dir`, `enc: A256GCM`). Not needed by the proxy.

**`POST /api/v0/users/auth_token/check_device`** — body:
```json
{"device_model":"NX809J","device_id":"wR1495uB7x9nBHSk79oHsBaxTtihyhspsZQSm6SeHYk="}
```
Response: `{"code":0,...,"biz_data":{"rotate":null}}`.

**`POST /api/v0/client/settings/report`** — body includes `settings_ids` (numeric list), `did`, `sso_id`.

### 3.3 Response headers (chat.deepseek.com)

Common:
```
server: elb
x-ds-trace-id: <hex>
strict-transport-security: max-age=31536000; includeSubDomains; preload
x-content-type-options: nosniff
x-cache: Miss from cloudfront
via: 1.1 <id>.cloudfront.net (CloudFront)
x-amz-cf-pop: MAD56-P5
x-amz-cf-id: <base64>
```

Completion SSE specifically:
```
content-type: text/event-stream; charset=utf-8
cache-control: no-cache
x-ds-sse-heartbeat-timeout-secs: 8
x-ds-served-by: chat
```
**`x-ds-sse-heartbeat-timeout-secs: 8`** — server expects the client to tolerate 8s gaps. Relevant to streaming-truncation concerns.

`create_pow_challenge` response sets `set-cookie: ds_session_id=<hex>; HttpOnly; Path=/; SameSite=strict; Secure`. The app does not echo this cookie back (no `cookie` header on later requests), so it appears unused for API auth.

---

## 4. Request/response bodies

### 4.1 Completion

**Request** `POST /api/v0/chat/completion`:
```json
{
  "chat_session_id": "0b2d4077-e1f6-43af-9563-d24eb9912d7b",
  "parent_message_id": null,
  "prompt": "helo",
  "ref_file_ids": [],
  "thinking_enabled": true,
  "search_enabled": true,
  "audio_id": null,
  "preempt": false,
  "model_type": "default",
  "action": null
}
```
**Only addition vs current proxy: `audio_id: null`.**

**Response**: `text/event-stream`. Identical structure to web:
```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

event: update_session
data: {"updated_at":...}

data: {"v":{"response":{...,"fragments":[{"id":2,"type":"THINK","content":"We",...}],...}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}
data: {"v":" answer"}
...

data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":70},{"p":"quasi_status","v":"FINISHED"}]}
event: auto_tts_capability
data: {"status":"ready"}
data: {"p":"response/status","o":"SET","v":"FINISHED"}
event: update_session
data: {"updated_at":...}
event: title
data: {"content":"Hello greeting"}
event: close
data: {"click_behavior":"none","auto_resume":false}
```

**New event not seen in web capture: `event: auto_tts_capability`** (`{"status":"ready"}`), near completion. Parser ignores unknown events safely.

### 4.2 POW challenge

**Request** `POST /api/v0/chat/create_pow_challenge`:
```json
{"target_path":"/api/v0/chat/completion"}
```
**Response**:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"challenge":{
  "algorithm":"DeepSeekHashV1",
  "challenge":"e56f7908298c5bba3e70b33b132f3a992534398e62f8be9b736ca08d03b9e5d2",
  "salt":"451c3c00ce1b5bdb4185",
  "signature":"63b4d62719f55df92a5040a2594304b72eb20b8935911355f68c911f20c4d1bf",
  "difficulty":144000,
  "expire_at":1790052015207,
  "expire_after":300000,
  "target_path":"/api/v0/chat/completion"
}}}}
```
Identical to web. `x-ds-pow-response` is base64 JSON (`eyJhbGdvcml0aG0iOiJEZWVwU2Vla0hhc2hWMSIs...`).

### 4.3 Session create

**Request**: empty body (`content-length: 0`).
**Response**:
```json
{"code":0,"msg":"","data":{"biz_code":0,"biz_msg":"","biz_data":{"chat_session":{
  "id":"53239596-afe8-4d4e-ba09-9ca8b84f5d78","seq_id":212214915,"agent":"chat",
  "model_type":"default","title":null,"title_type":"WIP","version":0,
  "current_message_id":null,"pinned":false,"inserted_at":...,"updated_at":...
},"ttl_seconds":259200}}}
```

### 4.4 History messages

`GET /api/v0/chat/history_messages?chat_session_id=<id>&scenario=stream_close` — returns the full session (`chat_session` + `chat_messages[]`), each message with `fragments` (`REQUEST`/`RESPONSE`/`THINK`). Called after the SSE stream closes. The proxy does not need this.

### 4.5 User

`GET /api/v0/users/current` -> `biz_data`: `{id, token, email (masked), mobile_number, status, ..., is_mainland}`. Note the response contains a `token` field.

---

## 5. Networking / capture setup (reproducible)

1. **MEmu root:** `memuc setconfigex -i 0 enable_su 1` while VM stopped, then start. Verify `su -c id` -> `uid=0`.
2. **CA:** mitmproxy generates CA; compute Android hash with `openssl x509 -subject_hash_old` -> `<hash>.0`.
3. **System cert install:** `/system` is ext4 read-only at block level (`/dev/block/sda6`), remount fails with I/O error. Workaround: copy certs to `/data/local/tmp/cacerts`, add CA, `mount --bind` over `/system/etc/security/cacerts`.
4. **Proxy routing:** `adb reverse tcp:8888 tcp:8888` + `settings put global http_proxy 127.0.0.1:8888`. The MEmu NAT gateway (`192.168.232.1`) is not a bindable host interface, so `adb reverse` is required.
5. **No cert pinning** in DeepSeek 2.5.3 — interception worked without Frida.
6. **Capturing streaming flows:** mitmproxy serializes a flow only after it completes; long/held SSE streams may not appear until the connection closes. Force-stop the app to flush.

## 6. Security note

The captured flows contain a **live bearer token** and device identifiers. Treat `flows*.mitm`, `all_flows_dump.txt`, and `completion_dump.txt` as secrets; do not commit them.

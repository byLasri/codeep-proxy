# DeepSeek Browser Mimicry Roadmap

Based on HAR analysis of real browser traffic to chat.deepseek.com

---

## Missing Browser Headers & Behaviors

### 1. User-Agent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0`
- [ ] **Not yet done** - Implement real Firefox UA string
- **Source**: Static string from browser
- **Dynamic**: Version changes with Firefox updates (currently 155.0)
- **How to get**: Copy from real browser; must match `x-client-version` (2.5.0)
- **Dependencies**: Must match `x-client-version` (2.5.0) and platform
- **Risk**: Mismatch with TLS fingerprint or TLS JA3 will flag as bot

### 2. Full Referer (session-specific): `https://chat.deepseek.com/a/chat/s/{chat_session_id}`
- [ ] **Not yet done** - Implement session-specific referer
- **Source**: Constructed from `chat_session_id` returned by `/api/v0/chat_session/create`
- **Dynamic**: **Yes** - unique per session
- **How to get**: Construct from `chat_session_id` returned by `/api/v0/chat_session/create`
- **Dependencies**: Requires valid `chat_session_id` from session creation
- **Pattern**: `https://chat.deepseek.com/a/chat/s/{chat_session_id}`

### 3. Full Cookie Jar (WAF token + session cookies)
- [ ] **Not yet done** - Implement full cookie jar management
- **Cookies needed**:

| Cookie | Source | Dynamic? | How to Get |
|---|---|---|---|
| `ds_session_id` | Login/auth flow | **Yes** - expires | From login response / auth storage |
| `aws-waf-token` | WAF challenge on first visit | **Yes** - short TTL | Set by Cloudflare WAF on first request to chat.deepseek.com |
| `smidV2` | Session tracking | **Yes** | Set on first visit |
| `.thumbcache_*` | Static asset caching | Semi-static | Set on first visit |
| `ds_session_id` (in Cookie header) | Session binding | **Yes** | From auth |

- **Critical**: `aws-waf-token` is **WAF bypass token** - without it, Cloudflare WAF blocks requests
- **How to get**: Must visit `chat.deepseek.com` first (GET /) and capture cookie set by Cloudflare
- **Dependencies**: All cookies tied to same browser session/profile. Must persist across requests.

### 4. Sec-Fetch-* Headers
- [ ] **Not yet done** - Implement Sec-Fetch-* headers per endpoint type

| Header | Value | Dynamic? | Source |
|---|---|---|---|
| `Sec-Fetch-Dest` | `empty` (API), `script` (JS), `image`, `font` | Per request type | Static per endpoint type |
| `Sec-Fetch-Mode` | `cors` (API), `no-cors` (static) | Per request type | Static |
| `Sec-Fetch-Site` | `same-origin`, `same-site`, `cross-site` | Per target domain | Computed from referer vs target |

**Implementation**: Hardcode per endpoint type:
- API calls: `empty`, `cors`, `same-origin`
- Static assets: `script`/`font`/`image`, `no-cors`/`cors`, `same-site`

### 5. Timezone Offset
- [ ] **Not yet done** - Implement dynamic timezone detection
- **Browser value**: `-25200` (UTC-7, e.g., PDT)
- **Our current**: `+3600` (hardcoded)
- **Dynamic**: **Yes** - user's actual timezone
- **How to get**: `Intl.DateTimeFormat().resolvedOptions().timeZone` → offset in seconds
- **Dependencies**: Must match user's actual location; mismatch flags as bot

### 6. OPTIONS Preflight for HIF Endpoints
- [ ] **Not yet done** - Implement OPTIONS preflight before HIF GET requests

| Endpoint | Preflight? | Request Headers | Response Headers |
|---|---|---|---|
| `hif-leim.deepseek.com/query` | ✅ Yes | `Access-Control-Request-Method: GET`, `Access-Control-Request-Headers: x-client-bundle-id,x-client-locale,x-client-platform,x-client-timezone-offset,x-client-version` | `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers` |
| `hif-dliq.deepseek.com/query` | ✅ Yes | Same | Same |

**Behavior**: Browser sends OPTIONS before GET. Server responds with CORS headers. Then browser sends GET.

**Implementation**: Before each HIF GET, send OPTIONS first, verify CORS response, then GET.

### 7. HIF-DLIQ Endpoint
- [ ] **Not yet done** - Investigate and implement HIF-DLIQ endpoint

| Aspect | Details |
|---|---|
| **Endpoint** | `GET https://hif-dliq.deepseek.com/query` |
| **Headers** | Same as HIF-LEIM + `Origin: https://chat.deepseek.com`, `Referer: https://chat.deepseek.com/` |
| **Response** | Similar structure: `data.biz_data.value` |
| **Header** | `x-hif-dliq: <value>` on completion |
| **Status in HAR** | Requests fail (network/XHR errors), no successful value captured |
| **Current status** | **NOT WORKING** in current browser version |

**Status**: **NOT IMPLEMENTED** and currently non-functional in browser (HAR shows failed requests). DeepSeek may have disabled it.

---

## Dependency Graph & Implementation Order

```
┌─────────────────────────────────────────────────────────────┐
│  1. LOGIN / AUTH FLOW (PREREQUISITE)                         │
│  ├─ POST /login → ds_session_id, authorization token        │
│  ├─ GET https://chat.deepseek.com/ → aws-waf-token cookie  │
│  └─ Sets base cookies for all subsequent requests           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  2. SESSION CREATION                                         │
│  ├─ POST /api/v0/chat_session/create                        │
│  │   Headers: UA, Referer (https://chat.deepseek.com/),    │
│  │   Cookies (all), Sec-Fetch-*, Origin, x-client-*        │
│  └─ Returns chat_session_id                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  3. COMPLETION REQUEST (per turn)                            │
│  ├─ Referer: https://chat.deepseek.com/a/chat/s/{session_id}│
│  ├─ Cookies: ALL (WAF + session + tracking)                 │
│  ├─ Headers: UA, Sec-Fetch-*, Origin, Referer, x-client-*  │
│  ├─ HIF-LEIM: OPTIONS → GET /query → x-hif-leim            │
│  ├─ HIF-DLIQ: OPTIONS → GET /query → x-hif-dliq (if works) │
│  ├─ PoW: POST /create_pow_challenge → solve → x-ds-pow-response│
│  └─ Completion: POST /completion with all above             │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Constraints

| Constraint | Impact |
|---|---|
| **No fabrication** | All values must come from real browser interactions |
| **Cookie persistence** | Must maintain cookie jar across all requests |
| **Referer chain** | Each request's referer depends on previous step |
| **Time sync** | Timezone must match actual user location |
| **Version sync** | UA version, client version, platform must align |
| **WAF token** | Must be fresh; obtained by visiting homepage first |

**Bottom line**: Requires maintaining a full browser-like session state machine, not just sending headers. The WAF token alone requires a real browser visit to `chat.deepseek.com` first.

---

## Current Implementation Status

| Component | Status | Notes |
|---|---|---|
| D1 Session Tracking | ✅ Done | `chat_session_id` + `parent_message_id` in D1 |
| Worker Rate Limit | ✅ Done | 5s delay at `/deepseekprotocol` endpoint |
| DeepSeek API Module | ✅ Done | `deepseek_api` module with completion, session, PoW, HIF-LEIM |
| Python Client | ✅ Done | Logs raw SSE with timestamps |
| Documentation | ✅ Done | `DeepSeek-API.md` with wire protocol details |
| **Browser Mimicry** | **❌ Not Started** | All 7 items above |
| **Cookie Management** | **❌ Not Started** | No cookie jar persistence |
| **Sec-Fetch-* Headers** | **❌ Not Started** | Missing entirely |
| **OPTIONS Preflight** | **❌ Not Started** | Not implemented for HIF |
| **HIF-DLIQ** | **❌ Not Started** | Currently non-functional |
| **Dynamic Timezone** | **❌ Not Started** | Hardcoded to +3600 |

---

## Next Steps Priority

1. **Cookie Jar + WAF Token** - Prerequisite for everything else
2. **User-Agent + Sec-Fetch-*** - Basic browser fingerprint
2. **Login Flow** - Get `ds_session_id` + `authorization` token
3. **Session Creation** - With full headers + cookies
3. **HIF-LEIM + OPTIONS** - Preflight + token fetch
4. **PoW + Completion** - With all headers + tokens
5. **HIF-DLIQ** - Investigate if needed (currently broken)
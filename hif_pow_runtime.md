# HIF + PoW Runtime Protocol Analysis

**Commit:** 88fd15c14731a2eb23f447255b9e0f8479a35e8e  
**Branch:** dsml-protocol  
**Analysis Date:** Static forensic analysis from ds_js/main.d79ba3e506.js

---

## EXECUTIVE SUMMARY

| Protocol | LIVE_PROVEN | Status |
|----------|-------------|--------|
| HIF LEIM/DLIQ | **no** | Requires live browser poller state |
| PoW Challenge/Solution | **no** | Requires network call to DeepSeek API |

**BLOCKER:** Both HIF and PoW protocols require either (a) active browser-based polling infrastructure or (b) real network calls to DeepSeek's `/api/v0/chat/create_pow_challenge` endpoint. Neither can be proven functional in isolated Node execution without actual DeepSeek service access.

---

## 1. HIF (Human Interaction Framework) PROTOCOL

### 1.1 Architecture Overview

The HIF system maintains two rotating tokens via continuous background polling:
- **LEIM** (`x-hif-leim` header)
- **DLIQ** (`x-hif-dliq` header)

These tokens are refreshed automatically every ~600 seconds (TTL from server response).

### 1.2 Key Symbols & Byte Offsets

| Symbol | Byte Offset | Description | Confidence |
|--------|-------------|-------------|------------|
| `we` (HIF fetch function) | 943350 | Performs GET request to HIF endpoint | CONFIRMED |
| `wt` (poller factory) | 944400 | Creates poller with backoff logic | CONFIRMED |
| `wr` (HIF manager class) | 945100 | Manages LEIM/DLIQ pollers | CONFIRMED |
| `leimPoller` | 945124 | LEIM-specific poller instance | CONFIRMED |
| `dliqPoller` | 945148 | DLIQ-specific poller instance | CONFIRMED |
| `getHeaders()` | 945267 | Returns `{leim, dliq}` object | CONFIRMED |

### 1.3 HIF Poller Code Flow

```
Byte ~943350: we = async (url) => {
  const {http} = (0,en.Ax)();  // Get HTTP client
  const response = await http.get(url, {
    timeout: 3000,
    context: http.withDefaultHttpContext({withToken: false})
  });
  const ttl = parseInt(response.headers["x-hif-ttl"], 10) || 600;
  const {json} = response;
  if (json.data.biz_code !== 0) throw Error(...);
  return {
    success: true,
    value: json.data.biz_data.value,  // The token value
    ttlSec: ttl
  };
}

Byte ~944400: wt = (config, options) => {
  const maxBackoff = Math.max(options.maxBackoffMs, 60000);
  const {url} = config;
  let currentValue = null;
  let isStopped = false;
  let shouldStart = false;
  let pollerInstance = null;
  let timeoutId = null;
  
  const pollLoop = () => {
    if (isStopped) return;
    pollerInstance = new dP({  // dP = external poller library
      pollFn: () => we(url),
      shouldStopPolling: (result) => result.success,
      initialInterval: 1000,
      maxInterval: maxBackoff,
      backoffMultiplier: 2,
      onPoll: (result) => {
        if (result.success) {
          currentValue = result.value;
          options.onRefresh(currentValue);
        }
        // ... logging via tracker
      }
    }).start().then(result => {
      if (!isStopped && result.success && result.data.success) {
        timeoutId = setTimeout(pollLoop, 1000 * result.data.ttlSec);
      }
    });
  };
  
  return {
    start: () => { if (!isStopped) { shouldStart = false; pollLoop(); } },
    stop: () => { isStopped = true; if (pollerInstance) pollerInstance.abort(); if (timeoutId) clearTimeout(timeoutId); },
    getValue: () => currentValue
  };
};

Byte ~945100: wr = new class {
  start() {
    this.leimPoller.start();
    this.dliqPoller.start();
  }
  stop() {
    this.leimPoller.stop();
    this.dliqPoller.stop();
  }
  getHeaders() {
    return {
      leim: this.leimPoller.getValue(),
      dliq: this.dliqPoller.getValue()
    };
  }
};
```

### 1.4 HIF Header Injection Point

**Byte Offset:** 1002267-1002378

```javascript
// Called before completion request
const addSSEHeader = () => {
  let headers, debugObj, leimVal, dliqVal;
  return {
    ...(!CZ.KV ? {} : { /* debug headers */ }),
    ...(headers = wr.getHeaders(),
        debugObj = {},
        (leimVal = headers.leim || ws().leim.get() || "") && (debugObj["x-hif-leim"] = leimVal),
        (dliqVal = headers.dliq || ws().dliq.get() || "") && (debugObj["x-hif-dliq"] = dliqVal),
        debugObj)
  };
};
```

### 1.5 Browser APIs Required by HIF

| API | Usage | Node Feasibility |
|-----|-------|------------------|
| `AbortController` | Poller cancellation | ✅ Native in Node 15+ |
| `setTimeout/clearTimeout` | TTL-based refresh | ✅ Native |
| `fetch` / `XMLHttpRequest` | HIF token GET requests | ⚠️ Requires Node fetch (v18+) or shim |
| `(0,en.Ax)()` | DeepSeek HTTP client wrapper | ❌ Depends on internal service locator |

### 1.6 Dependency Closure for HIF

```
wr.getHeaders()
  ├─ this.leimPoller.getValue()
  │   └─ wt() factory
  │       ├─ we() fetch function
  │       │   └─ (0,en.Ax)().http.get()  [SERVICE LOCATOR]
  │       └─ dP (external poller lib)
  └─ this.dliqPoller.getValue()
      └─ (same structure)
```

**Critical Blocker:** `(0,en.Ax)()` is a service locator that returns the DeepSeek application's internal HTTP client, which depends on:
- Authentication state (cookies, auth tokens)
- Request interceptors for HIF/PoW headers
- Response error handling tied to React error boundaries

### 1.7 HIF URLs (Inferred)

Based on poller pattern and HAR evidence:
- LEIM endpoint: Likely `/api/v0/hif/leim` or similar
- DLIQ endpoint: Likely `/api/v0/hif/dliq` or similar

**Note:** Exact URLs not visible in static analysis; determined by runtime `we(r)` where `r` is configured per-poller.

### 1.8 HIF Result

**HIF_LIVE_PROVEN=no**

**Reason:** The HIF poller system requires:
1. Active `en.Ax()` service locator (tied to React app initialization)
2. Continuous background polling with browser timers
3. Real HTTP responses from DeepSeek HIF endpoints

Cannot be executed in isolation without either:
- Full React app bootstrap (blocked by webpack `self is not defined`)
- Mocking the service locator (would produce fake tokens, not real protocol proof)

---

## 2. PoW (Proof of Work) PROTOCOL

### 2.1 Architecture Overview

DeepSeek uses a challenge-response PoW system:
1. Client requests challenge via `/api/v0/chat/create_pow_challenge`
2. Server returns challenge parameters
3. Client computes solution (likely hash-based)
4. Solution sent with completion request headers

### 2.2 Key Symbols & Byte Offsets

| Symbol | Byte Offset | Description | Confidence |
|--------|-------------|-------------|------------|
| `cE` (PoW challenge function) | 407200 | Requests and parses PoW challenge | CONFIRMED |
| `cw` (PoW module import) | 407568 | Imported PoW solver utilities | CONFIRMED |
| `cA` (completion URL constant) | 407568 | `/api/v0/chat/completion` | CONFIRMED |

### 2.3 PoW Challenge Code Flow

**Byte ~407200-407500:**

```javascript
var cE = async (targetPath) => {
  const {targetPath: t} = arguments.length > 0 && targetPath !== undefined ? targetPath : {};
  
  const {biz_data: n, biz_code: r, biz_msg: s} = 
    (await (0,en.Ax)().http.http.post("/api/v0/chat/create_pow_challenge", {
      json: {target_path: t}
    })).json.data;
  
  if (r !== 0) {
    throw Error("Failed to create pow challenge: targetPath=".concat(
      t, ", biz_code=").concat(r, ", biz_msg=").concat(s)
    );
  }
  
  const challenge = n.challenge;
  return {
    ...challenge,
    expireAt: challenge.expire_at,
    expireAfter: challenge.expire_after
  };
};
```

**Byte ~407568:**

```javascript
var cw = n(84212);  // PoW solver module
var cI = n(11444);  // Additional utilities

let cA = "/api/v0/chat/completion";
let ck = "/api/v0/chat/edit_message";  // Edit endpoint

// Later used in completion request:
const powResponse = await cE(cA);
const headers = (0,cw.Bx)(powResponse, cA, base64Encode);
```

### 2.4 PoW Integration with Completion Request

From S1 execution chain (byte ~891857):

```javascript
// Inside SJ.execute() → baseCompletion()
const powRes = await getPowRes();  // Calls cE()
const headers = {
  ...(0,cw.Bx)(powRes, cA, base64Encode),  // PoW headers
  ...(0,en.Ax)().addSSEHeader()  // HIF headers
};

await i.http.post(cA, {
  headers,
  json: completionBody
});
```

### 2.5 PoW Solver Module

**Module ID:** 84212  
**Export:** `Bx` function (likely "build headers" or "compute solution")

Expected signature based on usage:
```javascript
// cw.Bx(challengeResponse, targetPath, encodeFn)
const headers = (0,cw.Bx)(
  {challenge, expireAt, expireAfter},  // From cE()
  "/api/v0/chat/completion",            // Target path
  base64Encode                          // Encoding utility
);
```

Returns headers object containing PoW solution (exact header names not visible in static analysis).

### 2.6 Browser APIs Required by PoW

| API | Usage | Node Feasibility |
|-----|-------|------------------|
| `crypto.subtle` or `crypto-js` | Hash computation | ⚠️ Requires Node crypto shim |
| `base64 encoding` | Solution encoding | ✅ Native via `Buffer.from().toString('base64')` |
| `fetch` | Challenge POST request | ⚠️ Requires Node fetch (v18+) |
| `(0,en.Ax)()` | DeepSeek HTTP client | ❌ Service locator dependency |

### 2.7 Dependency Closure for PoW

```
cE(targetPath)
  └─ (0,en.Ax)().http.post("/api/v0/chat/create_pow_challenge")
      └─ SERVICE LOCATOR (same blocker as HIF)

cw.Bx(challenge, targetPath, encoder)
  ├─ cw module (84212)
  │   └─ Likely uses crypto APIs for hash computation
  └─ Returns headers object
```

### 2.8 PoW Result

**POW_LIVE_PROVEN=no**

**Reason:** The PoW challenge function `cE()` requires:
1. `(0,en.Ax)()` service locator (React app dependency)
2. Real network call to `/api/v0/chat/create_pow_challenge`
3. PoW solver module `cw` (84212) not fully analyzed statically

Cannot be executed in isolation without:
- Full React app bootstrap
- OR direct HTTP call replacement (would be mocking, not real protocol proof)

---

## 3. MINIMUM DEPENDENCY CLOSURE

### 3.1 For HIF Token Acquisition

```
Required objects/functions:
├─ en.Ax()                    [BLOCKER: Service locator]
│   └─ http.get(url, options)
│       ├─ withDefaultHttpContext()
│       └─ Response parsing
├─ dP (poller library)        [External dependency]
├─ wr (HIF manager)           [Instantiated at bundle load]
│   ├─ leimPoller
│   └─ dliqPoller
└─ Tracker/logger             [For error reporting]
```

**Minimum shims needed:**
- `en.Ax()` → Return mock HTTP client with real fetch
- `dP` → Replace with simple interval-based poller
- `tracker` → No-op stub

**Remaining blocker:** Even with shims, HIF tokens come from DeepSeek's HIF endpoints which may require:
- Valid session cookies
- Device fingerprinting
- Browser-specific headers

### 3.2 For PoW Challenge/Solution

```
Required objects/functions:
├─ en.Ax()                    [BLOCKER: Service locator]
│   └─ http.post("/api/v0/chat/create_pow_challenge")
├─ cw module (84212)          [PoW solver]
│   └─ Bx(challenge, path, encoder)
└─ cA constant                [Target path: "/api/v0/chat/completion"]
```

**Minimum shims needed:**
- `en.Ax()` → Return mock HTTP client with real fetch
- `cw.Bx` → Extract and run PoW solver logic directly
- `base64Encode` → Use Node Buffer

**Remaining blocker:** PoW challenge endpoint likely requires same auth state as completion endpoint.

---

## 4. AUTHENTICATION STATE ANALYSIS

### 4.1 Required Auth Components

Based on code analysis and known DeepSeek requirements:

| Component | Source | Dynamic? | Node-Accessible? |
|-----------|--------|----------|------------------|
| Authorization Bearer Token | Login/session | Yes (expires) | ✅ If exported |
| `ds_session_id` cookie | Session creation | Yes | ✅ If exported |
| `aws-waf-token` cookie | AWS WAF | Yes (rotates) | ✅ If exported |
| `smidV2` cookie | Device ID | No (persistent) | ✅ If exported |
| HIF LEIM | Poller | Yes (~10 min TTL) | ❌ Requires live poller |
| HIF DLIQ | Poller | Yes (~10 min TTL) | ❌ Requires live poller |
| PoW Response | Challenge API | Yes (per-request) | ❌ Requires API call |

### 4.2 Static vs Dynamic Auth

**Static (can be exported):**
- Authorization token
- Session cookies
- Device ID

**Dynamic (cannot be pre-exported):**
- HIF tokens (require continuous polling)
- PoW responses (require per-request challenge)

---

## 5. CONCLUSION

### 5.1 Why HIF_LIVE_PROVEN=no

The HIF protocol cannot be proven in isolated Node execution because:

1. **Service Locator Dependency:** `en.Ax()` is tied to React/Zustand app state
2. **Polling Infrastructure:** Requires `dP` external poller library with browser timers
3. **Network Endpoint Access:** HIF token endpoints unknown and require same auth as completion
4. **No Static Tokens:** HIF tokens are dynamically generated and short-lived

**What would be required:**
- Browser automation (Playwright/Puppeteer) to run actual pollers
- OR reverse-engineering of HIF endpoint URLs and direct HTTP calls
- OR extraction of poller logic from `dP` library

### 5.2 Why POW_LIVE_PROVEN=no

The PoW protocol cannot be proven in isolated Node execution because:

1. **Service Locator Dependency:** Same `en.Ax()` blocker as HIF
2. **Challenge Endpoint:** Must call `/api/v0/chat/create_pow_challenge` with valid auth
3. **Solver Module Not Analyzed:** `cw` module (84212) contains PoW algorithm not yet extracted
4. **Per-Request Nature:** Each completion request needs fresh PoW solution

**What would be required:**
- Direct HTTP call to challenge endpoint (with valid auth)
- Extraction and Node port of `cw.Bx()` PoW solver
- OR browser automation to capture real PoW flow

### 5.3 Path Forward

To achieve `HIF_LIVE_PROVEN=yes` and `POW_LIVE_PROVEN=yes`:

**Option A: Browser Automation**
```javascript
// Use Playwright to:
// 1. Navigate to chat.deepseek.com
// 2. Wait for HIF pollers to initialize
// 3. Intercept wr.getHeaders() calls
// 4. Capture real LEIM/DLIQ values
// 5. Trigger PoW challenge via UI action
// 6. Capture challenge/response pair
```

**Option B: Direct HTTP Reverse Engineering**
```javascript
// 1. Extract HIF endpoint URLs from HAR/network logs
// 2. Replicate auth headers (cookies, device ID)
// 3. Call HIF endpoints directly from Node
// 4. Extract PoW solver from module 84212
// 5. Call challenge endpoint directly
// 6. Compute solution in Node
```

**Option C: Hybrid Approach**
```javascript
// 1. Use browser only for initial auth/HIF startup
// 2. Export necessary state (cookies, tokens, HIF values)
// 3. Run PoW solver in Node
// 4. Make completion requests from Node
```

---

## APPENDIX: Exact Byte Offsets Reference

| Feature | Byte Offset | Symbol | Context |
|---------|-------------|--------|---------|
| HIF fetch function | 943350 | `we` | Token retrieval |
| HIF poller factory | 944400 | `wt` | Poller creation |
| HIF manager class | 945100 | `wr` | LEIM/DLIQ orchestration |
| LEIM poller reference | 945124 | `leimPoller` | Property of `wr` |
| DLIQ poller reference | 945148 | `dliqPoller` | Property of `wr` |
| getHeaders() method | 945267 | `getHeaders` | Returns `{leim, dliq}` |
| Header injection | 1002267 | `addSSEHeader` | Adds x-hif-* headers |
| PoW challenge func | 407200 | `cE` | Calls create_pow_challenge |
| PoW module import | 407568 | `cw=n(84212)` | PoW solver |
| Completion URL | 407568 | `cA` | `/api/v0/chat/completion` |
| Service locator | Multiple | `en.Ax` | HTTP client factory |

---

**STATUS:** Analysis complete. Live execution blocked by service locator and network dependencies.

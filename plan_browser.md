# Browser Fingerprint Implementation Plan

## Overview
Capture full browser fingerprint during CoDeep authentication and use it in CoDeep-proxy for 100% real browser mimicry.

---

## Phase 1: CoDeep - Extend AuthState & Capture Fingerprint

### 1.1 Extend AuthState interface (`CoDeep/src/auth/state.ts`)
- [x] Add `browserFingerprint` field to `AuthState` interface
- [x] Include all browser fingerprint fields (User-Agent, sec-ch-ua*, x-client-*, timezone, etc.)

### 1.2 Capture Fingerprint During Auth (`CoDeep/src/auth/browser.ts`)
- [x] Add `captureBrowserFingerprint(page)` function
- [x] Extract from `navigator.userAgent`, `navigator.userAgentData`, `navigator.languages`, `navigator.platform`
- [x] Include: userAgent, secChUa, secChUaMobile, secChUaPlatform, xClientVersion, xClientPlatform, xClientLocale, xClientTimezoneOffset, xClientBundleId, acceptLanguage
- [x] Call during `captureAuthStateFromPage` and include in returned `AuthState`

### 1.3 Update AuthState Persistence (`CoDeep/src/auth/store.ts`)
- [x] Ensure `browserFingerprint` is serialized/deserialized correctly
- [x] No schema changes needed (flexible object)

### 1.4 Send Fingerprint to Proxy (`CoDeep/src/auth/store.ts`)
- [x] `sendAuthStateToProxy` already sends full `AuthState` - no changes needed

---

## Phase 2: CoDeep-proxy - Use Fingerprint in Worker

### 2.1 Update Worker to Read Fingerprint (`CoDeep-proxy/src/index.ts`)
- [ ] Read `browserFingerprint` from KV auth state
- [ ] Apply captured fingerprint to outbound DeepSeek API requests
- [ ] Include all headers: User-Agent, sec-ch-ua*, x-client-*, Referer, Cookie, Sec-Fetch-*, Priority, Origin

### 2.2 Add OPTIONS Preflight for HIF Endpoints
- [ ] Before HIF-LEIM GET, send OPTIONS preflight
- [ ] Before HIF-DLIQ GET, send OPTIONS preflight
- [ ] Verify CORS response before proceeding

### 2.3 Update Worker to Use Full Cookie Jar
- [ ] Read full cookie array from KV auth state
- [ ] Build complete Cookie header with all cookies (aws-waf-token, ds_session_id, smidV2, etc.)

### 2.4 Fix Timezone Offset
- [ ] Use captured `xClientTimezoneOffset` from fingerprint (e.g., -25200)

---

## Phase 3: Testing & Verification

### 3.1 Test Full Flow
- [ ] Run CoDeep auth (Playwright Chrome login)
- [ ] Verify fingerprint captured and stored in KV
- [ ] Call `/deepseekprotocol` from Python client
- [ ] Verify worker uses captured fingerprint in outbound requests
- [ ] Verify DeepSeek API responds successfully

### 3.2 Verify Headers in Outbound Requests
- [ ] Check logs for all browser headers being sent
- [ ] Verify Referer is session-specific
- [ ] Verify Cookie header includes all cookies
- [ ] Verify Sec-Fetch-* headers present
- [ ] Verify OPTIONS preflight for HIF endpoints

---

## Implementation Checklist

### CoDeep Changes
- [ ] `CoDeep/src/auth/state.ts` - Add browserFingerprint to AuthState
- [ ] `CoDeep/src/auth/browser.ts` - Capture fingerprint during auth
- [ ] `CoDeep/src/auth/browser.ts` - Include fingerprint in returned AuthState
- [ ] `CoDeep/src/auth/store.ts` - Verify serialization works

### CoDeep-proxy Changes
- [ ] `src/index.ts` - Read browserFingerprint from KV
- [ ] `src/index.ts` - Apply fingerprint headers to outbound requests
- [ ] `src/index.ts` - Build full Cookie header from cookies array
- [ ] `src/index.ts` - Add OPTIONS preflight for HIF-LEIM and HIF-DLIQ
- [ ] `src/deepseek_api/hif-leim.ts` - Add OPTIONS preflight before GET
- [ ] `src/deepseek_api/hif-leim.ts` - Add HIF-DLIQ endpoint support

### Testing
- [ ] Run CoDeep auth flow
- [ ] Verify fingerprint in KV
- [ ] Test `/deepseekprotocol` with Python client
- [ ] Verify all headers in outbound requests
- [ ] Verify D1 session tracking still works

---

## Progress Tracker

| Task | Status |
|---|---|
| Extend AuthState with browserFingerprint | [ ] |
| Capture fingerprint during Playwright auth | [ ] |
| Include fingerprint in AuthState sent to proxy | [ ] |
| Worker reads fingerprint from KV | [ ] |
| Worker applies fingerprint to outbound requests | [ ] |
| Worker builds full Cookie header | [ ] |
| Worker adds OPTIONS preflight for HIF | [ ] |
| Worker uses dynamic timezone from fingerprint | [ ] |
| Test full flow end-to-end | [ ] |
# HIF-LEIM + KV Storage Implementation

## Overview

The DeepSeek web client now uses **Cloudflare KV** for persistent, stateless storage of both credentials and dynamic tokens (HIF-LEIM). This replaces the previous in-memory/Cache API approach, ensuring tokens survive worker restarts and are shared across all worker instances.

## Architecture

### StateManager (`src/deepseek/state-manager.ts`)

Unified KV storage manager handling:

**Credentials Storage:**
- `creds:auth_token` - Authorization bearer token
- `creds:cookies` - JSON-stringified cookie array

**HIF-LEIM Storage:**
- `hif:leim_token` - Current valid HIF-LEIM opaque value
- `hif:leim_expiry` - Expiration timestamp (ms)

### HifLeimCache (`src/deepseek/hif-leim.ts`)

TTL-based cache manager (600 seconds per protocol spec) that:
1. Checks KV for valid token before fetching
2. Fetches fresh token from `https://hif-leim.deepseek.com/query` when expired/missing
3. Stores in KV with automatic expiration
4. Supports manual refresh and invalidation

## Usage

### In Cloudflare Worker (`src/index.ts`)

```typescript
import { DeepSeekWebClient } from './deepseek/index.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Initialize client with KV namespace
    const client = new DeepSeekWebClient({
      kv: env.DEEPSEEK_KV,  // Bind your KV namespace in wrangler.toml
      credentials: async () => ({
        authorization: env.DEEPSEEK_AUTH,
        cookie: env.DEEP_COOKIES,
      }),
    });

    // Optionally seed credentials into KV on startup
    await client.stateManager?.setCredentials(
      env.DEEPSEEK_AUTH,
      parseCookies(env.DEEP_COOKIES)
    );

    // Use client normally - HIF-LEIM is auto-managed
    const response = await client.complete({
      session: conversationState,
      prompt: "Hello",
      model_type: "standard",
    });

    return response;
  }
};
```

### wrangler.toml Configuration

```toml
[[kv_namespaces]]
binding = "DEEPSEEK_KV"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"
```

### KV Storage Methods

```typescript
// Get/Set credentials
const creds = await stateManager.getCredentials();
await stateManager.setCredentials(authToken, cookiesArray);

// Get/Set HIF-LEIM
const leim = await stateManager.getHifLeim();
await stateManager.setHifLeim(tokenValue, 600);

// Clear HIF-LEIM (forces refresh on next request)
await stateManager.clearHifLeim();
```

## Protocol Compliance

### HIF-LEIM Acquisition Request

Per wire contract specification:
- ✅ GET `https://hif-leim.deepseek.com/query`
- ✅ Client headers only (no Auth, Cookie, Origin, Referer)
- ✅ Extract: `data.biz_data.value`
- ✅ Cache TTL: 600 seconds
- ✅ Inject as `x-hif-leim` header on `/api/v0/chat/completion`

### Headers Structure

Completion requests include:
```
Authorization: Bearer <token>
Cookie: ds_session_id=<session>; aws-waf-token=<waf>; ...
x-ds-client-pow: <solution>
x-hif-leim: <opaque-value>
```

## Migration Notes

### From Previous Versions

If upgrading from the Cache API version:

1. **Add KV binding** to `wrangler.toml`
2. **Pass KV to client constructor**: `new DeepSeekWebClient({ kv: env.DEEPSEEK_KV, ... })`
3. **Optional**: Seed existing credentials into KV using `stateManager.setCredentials()`

### Backward Compatibility

The module requires KV namespace for production use. The legacy singleton export (`hifLeimCache`) has been removed to enforce proper stateless architecture.

## Benefits

✅ **Stateless Design** - No in-memory state, works across all worker instances  
✅ **Persistent Storage** - Tokens survive worker restarts  
✅ **Automatic TTL Management** - 600s expiration enforced by KV  
✅ **Unified Credential Store** - Both static creds and dynamic tokens in one place  
✅ **Protocol Compliant** - Follows HIF-LEIM wire contract exactly  

## Files Modified

- `src/deepseek/state-manager.ts` (NEW) - KV storage abstraction
- `src/deepseek/hif-leim.ts` - Refactored to use StateManager
- `src/deepseek/client.ts` - Integrated KV-based HIF-LEIM caching
- `src/deepseek/index.ts` - Exported StateManager
- `src/deepseek/constants.ts` - Already contains HIF configuration

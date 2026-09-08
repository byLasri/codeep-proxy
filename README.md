# DeepFree Cloudflare Proxy

Private development proxy between an OpenAI-compatible client and DeepSeek Web.

## Local development

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# Edit .dev.vars with short-lived credentials.
npm run dev
```

The worker exposes:

```text
POST http://localhost:8788/v1/chat/completions
POST http://localhost:8788/v1/responses
GET  http://localhost:8788/health
```

Codex uses `/v1/responses`. The proxy translates the request into DeepSeek
Web v0, solves the PoW challenge, and translates the DeepSeek SSE stream back
into Responses API events. `/v1/chat/completions` remains available for
compatibility.

To configure Codex, copy the provider block from `codex.config.toml` into
`%USERPROFILE%\.codex\config.toml`, update the catalog path, and keep the proxy
URL local during development. Codex supports custom Responses providers
natively. Use `model_catalog_json` for durable custom model metadata;
`models_cache.json` is generated runtime cache and should not be edited.
The bridge only performs interactive login, sends the resulting credentials to
`POST /v1/auth`, deletes its local copy, and does not send chat requests.

Credentials are stored in the local Wrangler KV state under `.wrangler/state`
for development, so they survive worker restarts. They are never returned by
the API. In a deployed Worker, bind `AUTH_KV` to a private Cloudflare KV
namespace. Never commit credentials.
This repository intentionally has no Git remote yet.

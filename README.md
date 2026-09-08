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
POST http://localhost:8787/v1/chat/completions
```

The first version accepts OpenAI Chat Completions-style JSON, creates a
DeepSeek session, requests and solves a fresh PoW challenge, and translates
text fragments from the DeepSeek SSE stream into OpenAI-compatible SSE events.

Credentials belong in Wrangler secrets or local `.dev.vars`; never commit them.
This repository intentionally has no Git remote yet.

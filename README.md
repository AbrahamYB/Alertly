# Alertly

Alertly is an environmental-hazard map, community reporting platform, moderation system, and contextual AI assistant. The project earned first place in its Grade 11 STREAM HS competition.

## Local development

Alertly runs as one local Node.js service. The hazard map, community reports, uploads, and API all use the same origin; Cloudflare is not required.

```sh
npm ci
npm start
```

Open <http://localhost:3000>. Community Reports is available at <http://localhost:3000/report> and health status at <http://localhost:3000/health>.

Community reports use area geometry. **GPS Circle** creates a 1 km polygon around the device location, while **Area** lets the reporter outline a custom zone with at least three map clicks. Press Send or Enter to publish; manual areas are closed automatically. Historical point records remain readable for backward compatibility but cannot be created in the reporting interface.

Area vertices are continuously ordered around the area center, so new and moved points automatically connect between the correct neighbors instead of following click order. Every point remains part of the boundary. Drag a vertex to reposition it, double-click it to remove it, or use **Undo** to remove the most recently added vertex.

Background provider refresh is disabled by default so startup is fast and works offline. Copy `.env.example` to `.env` or set environment variables in your shell to opt into integrations. Never commit real keys.

Existing hazard and report files are read compatibly and normalized at the API boundary. New records support point, line, polygon, severity, status, confidence, source attribution, and timestamps. Community reports pass through one moderation state model: plausible or staff-approved reports are public, uncertain reports remain in moderation, and NSFW media is quarantined for staff review.

## Configurable AI

Use Node.js 22.15 or newer. The server loads `.env` automatically; shell variables take precedence. Copy `.env.example` to `.env`, set `CHAT_AI_API_KEY` for chat and `REPORT_AI_API_KEY` for moderation, and restart. The example configuration documents the current models and provider endpoints. Never commit real keys.

For another Chat Completions-compatible API, set `AI_PROVIDER=compatible`, `AI_BASE_URL` to its API base (including `/v1` if required), `AI_MODEL`, and `AI_API_KEY`. Keys stay on the server. This supports compatible APIs directly; providers with different request formats need an adapter in `lib/ai.js`. Provider-specific search is currently implemented for Groq Compound only. `AI_WEB_SEARCH=false` disables Compound search; explicit requests not to search also disable it per message.

The old local-model router, separate search subscription, scraping pipeline, and AI-generated news hazard importer have been removed. Official hazard feeds still refresh independently. Chat history is bounded to the latest 15 turns and retained for up to 72 hours of inactivity in the same browser. Validated plain-text history is sent with each request so context can survive a server restart. Before substantive requests reach the answering model or web search, a separate low-output semantic classifier evaluates the request and recent context without search and fails closed on unrelated or unclear intent. Answers use the existing chat interface; the provider returns a complete answer before it is displayed. The server applies a 60-second timeout and cancels disconnected requests.

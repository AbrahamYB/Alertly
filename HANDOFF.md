# ALERTLY — MASTER HANDOFF & ARCHITECTURE GUIDE

> **Canonical Source of Truth**: Single unified documentation for Alertly.
> Updated: 2026-10-07 | Node.js 22+ | Express 5 | Vanilla HTML/CSS/JS

---

## 1. PROJECT RULES & DIRECTIVES

- **Inspect before editing**: Follow existing architecture, variable naming, and conventions.
- **Do not break working features**: Preserve script/style boundaries and responsive layouts.
- **Keep changes focused & clean**: Write standard, human-readable, idiomatic code without artificial minification or decorative emoji clutter.
- **Security & Authorization**:
  - Admin and moderation endpoints are guarded by the invite-only staff session system. Owner-only account and ownership actions use `requireOwner`; signed-in owner/staff accounts can operate hazards and moderation.
- **Core Documentation Rules**:
  - `CODEBASE_MAP.md` is strictly for MCP (`jCodeMunch`) indexing and symbol tracking. **NEVER DELETE IT** — only update its tables and symbols when making code changes.
  - `HANDOFF.md` is the primary shared communication channel between the developer, AI, and Codex. Keep current state, tasks, and requirements updated here.
- **Automated Git Push & Live Deploy**:
  - The AI assistant MUST automatically commit and run `git push origin main` after making any code modifications or improvements. The user never runs `git push` manually.
  - Pushes to GitHub automatically trigger the live deployment pipeline on `alertly.live` via the server's `start.sh` background runner.

---

## 2. CURRENT SYSTEM STATE

- **Application Health**: Fully operational and hardened. All routes, feeds, community moderation, hazard admin, chatbox AI, vision verification, rate limiting, and removal resolution are active.
- **Test Suite**: 61 automated checks passing through `npm test` (52 unit/static tests, 8 isolated API tests, and the staff/ownership HTTP smoke test).
- **Database & Persistence**:
  - Zero-dependency file persistence (`data/reports.json` and `hazards.geojson`) with atomic cross-platform file replacement. Backup, restore, and demo seed commands honor deployment storage paths.
  - Automated database backup: `npm run backup` (creates timestamped snapshot in `backups/`).
  - Automated database restore: `npm run restore [file]` (safely restores from backup).
  - One-command demo seeding: `npm run seed:demo` backs up current data before writing the demo dataset.
  - Auto-initialization on fresh starts if data files are missing or empty.
- **Security & Client Data Isolation**:
  - Zero sensitive server data sent to public browsers: `sanitizeReportForPublic` strips internal audit logs, removal requests, moderator notes, and submitter IP addresses before public response.
  - HTTP defense & browser isolation headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), geolocation=(self), microphone=()`).
  - Secure encrypted cookie support (`secure: process.env.NODE_ENV === "production"`, `httpOnly`, `sameSite: "lax"`).
  - In-memory sliding-window rate limiters on `/api/reports/publish` (5/min), `/api/removal` (10/min), and `/chat` (15/min).
  - Enforced daily AI quota: 15 prompts/day per session or IP, with real-time UI badge countdown in `index.html` (resets at 00:00 UTC).
  - Sanitized inputs: geographic coordinate bounds checking, string length caps, and client-safe error messages.
  - File uploads: whitelisted extensions (JPG, PNG, WebP, GIF, MP4, WebM, MOV), 50MB incoming cap, UUID filenames, and automatic media compression.
- **AI Integration**:
  - **Chatbox AI** (`lib/ai.js`): JSON responses for broad browser compatibility, legacy SSE support, a 15-turn recent context window (30 messages max), bounded provider requests, and web-search fallback.
  - **Community Report Verification** (`lib/report-moderator-ai.js`): separate text and vision models inspect report details and media. Plausible reports become public, uncertain reports remain staff-only, and NSFW media is quarantined immediately for staff review rather than permanently deleted.
- **Removal Request Workflow**: Full community removal request submission (`POST /api/removal`) and interactive moderator resolution (`POST /api/moderation/reports/:id/removal-requests/:reqId/resolve` with Accept / Dismiss actions).

---

## 3. DIRECTORY STRUCTURE & FILE MAP

```
stream/
├── server.js                     ← Express app, all routes, session state, auto-purge jobs
├── automation.js                 ← Feed fetchers (runs as forked child process, auto-restarts)
├── worker_manager.js             ← Automation process supervisor
├── package.json
│
├── lib/
│   ├── ai.js                     ← Chatbox AI (Groq compound-mini, web search, 413 retry)
│   ├── report-moderator-ai.js   ← Report credibility & Groq Vision verification
│   ├── media-compressor.js      ← 720p image/video compression and video contact sheets
│   ├── file-utils.js            ← Cross-platform safe file replacement
│   ├── staff-access.js          ← Invite-only staff accounts and ownership transfer
│   ├── task-queue.js            ← Bounded in-process media queue
│   ├── postgres-job-queue.js    ← Durable PostgreSQL queue foundation
│   ├── domain.js                 ← Normalization, validation & canonical hazard categories
│   ├── hazard-region.js          ← Viewport bbox filtering & spatial calculations
│   └── provider-status.js        ← Feed provider health state reader
│
├── index.html                    ← Public interactive map + AI chat (~54 KB inline)
├── hazard-ui.js                  ← Shared browser hazard labels, colors, aliases, and icons
├── report.html                   ← Report submission form with GPS/Area tools (~98 KB inline)
├── moderation.html               ← Moderation dashboard with AI flags & image viewer (~38 KB)
├── hazard-admin.html             ← Authenticated admin hazard editor & inspector
├── staff.html                    ← Owner/staff access and transfer console
├── installer/                    ← Versioned Docker/native/split deployment foundation
│
├── data/
│   └── reports.json              ← Community reports store (JSON array)
├── hazards.geojson               ← Active official & automated hazards store (GeoJSON FeatureCollection)
├── uploads/                      ← Uploaded report images (served at /uploads/*)
│
├── test/
│   ├── ai.test.js                ← Chat AI retry, payload sizing, and search opt-out tests
│   ├── domain.test.js            ← GeoJSON normalization and spatial clustering tests
│   ├── report-moderator-ai.test.js ← Report moderator AI and vision verification tests
│   ├── media-compressor.test.js  ← FFmpeg compression and contact-sheet tests
│   ├── staff-access.test.js      ← Staff invitations and ownership transfer tests
│   ├── backup-restore.test.js    ← Deployment-path backup and restore safety tests
│   ├── provider-status.test.js   ← Provider inventory and staleness tests
│   └── api.test.js               ← Isolated end-to-end HTTP lifecycle tests
│
├── CODEBASE_MAP.md               ← Codebase map for jCodeMunch indexing
└── HANDOFF.md                    ← Single canonical project documentation and handoff reference
```

---

## 4. EXPRESS ROUTES & GUARDS (`server.js`)

### Static Pages & Public Assets
| Method | Path | Guard | Handler / Purpose |
|--------|------|-------|-------------------|
| GET | `/` | — | Serves `index.html` (public map) |
| GET | `/report` | — | Serves `report.html` (submission wizard) |
| GET | `/moderation` | — | Serves `moderation.html` (moderator console) |
| GET | `/hazard-admin` | `requireAdmin` | Serves the authenticated hazard administration page |
| GET | `/uploads/*` | — | Static uploaded report attachments (dotfiles denied) |

### Health & Automation Status
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | JSON health check (uptime, environment flags) |
| GET | `/api/provider-status` | Automated feed provider health status |

### Community Reports & Moderation
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports/data` | Public reports that passed AI plausibility or received moderator approval |
| GET | `/api/moderation/reports` | All reports for moderation interface |
| PATCH | `/api/moderation/reports/:id` | Update report (approve, reject, restore, edit, merge, note) |
| DELETE | `/api/moderation/reports/:id` | Permanently delete report and attached files |
| POST | `/api/reports/publish` | Submit new report (multipart, ≤5 images, auto-triggers AI evaluation) |
| POST | `/api/removal` | Request removal of a report (logs to audit trail) |
| POST | `/api/moderation/reports/:id/verify-ai` | On-demand AI plausibility & Vision re-check |

### AI Assistant Chat
| Method | Path | Description |
|--------|------|-------------|
| POST | `/chat` | JSON response by default for the public UI; legacy SSE mode remains supported; scoped environmental/Alertly assistant; 15-turn context with 72h inactivity retention |
| POST | `/session/reset` | Clear active chat session |

### Hazard Administration (Localhost Only)
| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/hazards/data` | — | Public hazard GeoJSON with source coordinates preserved |
| GET | `/api/admin/hazards` | `requireAdmin` | Full admin hazard dataset |
| POST | `/hazards/publish` | `requireAdmin` | Create official hazard |
| PATCH | `/api/admin/hazards/:id` | `requireAdmin` | Update existing hazard |
| POST | `/api/admin/hazards/:id/merge` | `requireAdmin` | Merge two hazard records |
| DELETE | `/api/admin/hazards/:id` | `requireAdmin` | Delete hazard record |

---

## 5. ENVIRONMENT VARIABLES & SUBSYSTEM CONFIGURATION

All subsystems are isolated and fall back safely to base settings if granular keys are omitted.

| Variable | Fallback | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | — | `3000` | HTTP server listening port |
| `TRUST_PROXY` | — | `loopback` | Express trusted proxy scope; keep narrow unless deployment topology requires otherwise |
| `ENABLE_AUTOMATION` | — | `false` | Fork and run feed automation worker |
| `HAZARD_BBOX` | — | Central America | `minLon,minLat,maxLon,maxLat` bounding box filter |
| `HAZARD_REFRESH_TIMES` | — | `00:00,12:00` | Fixed daily provider refresh times |
| `HAZARD_REFRESH_TIMEZONE` | — | `America/Guatemala` | Time zone used for fixed refresh times |
| `PROVIDER_STALE_HOURS` | — | `13` | Delay threshold for provider-health reporting |
| `DATA_DIR` / `HAZARDS_FILE` / `BACKUPS_DIR` | project paths | — | Deployment-specific persistent storage locations |
| **Chatbox AI** | | | |
| `CHAT_AI_API_KEY` | `AI_API_KEY` / `GROQ_API_KEY` | — | API key for public chat assistant |
| `CHAT_AI_PROVIDER` | `AI_PROVIDER` | `groq` | `groq` or OpenAI-compatible provider |
| `CHAT_AI_BASE_URL` | `AI_BASE_URL` | Groq URL | Custom endpoint base URL |
| `CHAT_AI_MODEL` | `AI_MODEL` | `openai/gpt-oss-20b` | Chat LLM model |
| `CHAT_AI_GUARD_MODEL` | `AI_GUARD_MODEL` / chat model | `openai/gpt-oss-20b` | Low-output semantic scope classifier; runs without web search before substantive chat requests |
| `CHAT_AI_WEB_SEARCH` | `AI_WEB_SEARCH` | `true` | Enable web search tool for chat |
| **Report Moderator AI** | | | |
| `REPORT_AI_API_KEY` | `AI_API_KEY` / `GROQ_API_KEY` | — | API key for report verification & vision |
| `REPORT_AI_PROVIDER` | `AI_PROVIDER` | `groq` | `groq` or OpenAI-compatible provider |
| `REPORT_AI_BASE_URL` | `AI_BASE_URL` | Groq URL | Custom endpoint base URL |
| `REPORT_AI_VISION_MODEL` | `VISION_AI_MODEL` | `qwen/qwen3.8-27b` | Vision-capable verification model |
| `REPORT_AI_TEXT_MODEL` | `AI_MODEL` | `openai/gpt-oss-20b` | Text-only report verification model |
| **External Feeds** | | | |
| `FIRMS_MAP_KEY` | — | — | NASA FIRMS MAP_KEY for VIIRS fire hotspots |

---

## 6. DATA MODELS

### Community Report (`data/reports.json`)
```json
{
  "id": "rep_1740000000000_abc123",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[-89.2, 13.7], [-89.1, 13.7], [-89.1, 13.8], [-89.2, 13.7]]]
  },
  "type": "Fire",
  "text": "Observed brush fire near road",
  "severity": "high",
  "moderationStatus": "approved",
  "status": "active",
  "createdAt": 1791201600000,
  "updatedAt": "2026-10-05T12:00:00.000Z",
  "images": [{ "url": "/uploads/file.jpg", "type": "image" }],
  "publiclyVisible": true,
  "verified": true,
  "aiEvaluation": {
    "analyzedAt": "2026-10-05T12:00:05.000Z",
    "verdict": "plausible",
    "confidence": 92,
    "reason": "Report details and attached imagery are consistent.",
    "visualEvidence": "Visible evidence summary.",
    "model": "provider/model-name"
  },
  "auditLog": [
    { "action": "submitted", "at": "2026-10-05T12:00:00.000Z", "note": "Public submission" }
  ]
}
```

### Official & Automated Hazard (`hazards.geojson`)
```json
{
  "id": "haz_usgs_nc75001234",
  "type": "Feature",
  "geometry": {
    "type": "Point",
    "coordinates": [-89.2182, 13.6929]
  },
  "properties": {
    "hazard": "earthquake|fire|flood|volcano|landslide|other",
    "title": "M 4.8 - 12 km SSW of San Salvador, El Salvador",
    "severity": "medium",
    "confidence": "confirmed",
    "status": "active",
    "source": "USGS",
    "sourceType": "automated",
    "createdAt": "2026-09-05T10:00:00.000Z",
    "lastUpdatedAt": "2026-09-05T10:05:00.000Z",
    "expiresAt": "2026-10-05T10:00:00.000Z"
  }
}
```

---

## 7. AUTOMATED FEEDS (`automation.js`)

The automation engine runs as a supervisor-managed child process (`worker_manager.js`):
- **USGS**: Earthquake alerts and seismic parameters.
- **GDACS**: Multi-hazard global alerts (cyclones, floods, earthquakes, volcanoes).
- **NASA EONET**: Natural hazard events filtered to valid 30-day active windows.
- **RSOE EDIS**: Emergency and disaster information service events.
- **Copernicus EMS**: One event marker per activation. AOI boundaries are mapping coverage metadata and are not displayed as hazard footprints.
- **NASA FIRMS**: VIIRS NOAA-20 & NOAA-21 24-hour thermal hotspot detections (requires `FIRMS_MAP_KEY`).
- **Stale Batch Rejection**: Automatically excludes expired records prior to saving to prevent re-adding already-purged events.

---

## 8. FRONTEND ARCHITECTURE

### Public Map (`index.html`)
- Leaflet map with OpenStreetMap & Satellite base layers.
- Viewport-scoped dynamic hazard loading that keeps every event separate at its source-reported coordinates.
- Public approved community report layer.
- Collapsible AI assistant panel with character-by-character streaming, session reset, and conversation export to text.

### Community Report Submission (`report.html`)
- Map-assisted drawing tools: GPS Circle, editable polygon area, movable vertices, double-click delete, and undo.
- Auto-zoom animation with graceful cancellation if user pans or drags.
- Dynamic color styling synchronized with hazard category.
- Multi-image attachment support (≤5 images) with local preview and viewer modal.

### Moderation Dashboard (`moderation.html`)
- Queue filtering by status, hazard category, date, and search text.
- Full inspection view with attached image gallery, AI authenticity flags, credibility confidence, and model reasoning.
- Actions: Approve, Reject, Resolve, Edit polygon vertices, Merge reports, Add moderator notes, and trigger on-demand AI re-evaluation.

### Hazard Administration (`hazard-admin.html`)
- Localhost-only administrative interface for creating, inspecting, editing, and merging official hazards.
- Styled hazard markers matching public UI; manual drawing tools cleanly segregated to prevent public map pollution.

---

## 9. TESTING & VERIFICATION

Run the full automated test suite. The runner starts isolated temporary servers for HTTP tests and removes their data afterward:
```bash
npm test
```

### Test Coverage (61 Passing Checks)
- `test/ai.test.js`: Chatbot 413 history truncation, retry behavior, and search opt-out.
- `test/ai-usage.test.js`: Privacy-safe aggregate usage tracking.
- `test/domain.test.js`: GeoJSON normalization, report defaults, and Haversine point clustering.
- `test/report-moderator-ai.test.js`: Report moderator AI evaluation, Groq Vision image analysis, and error fallback handling.
- `test/security.test.js`: Rate limiting, daily quota tracking (15 prompts/day limit), geographic coordinate bounds, upload extension sanitization, and administrative key validation.
- `test/api.test.js`: End-to-end integration tests for health check, auth status, chat quota, report publishing, removal request submission, removal resolution (accept/dismiss), and deletion.
- `test/media-compressor.test.js`: FFmpeg discovery, 720p compression, size limiting, format conversion, and contact sheets.
- `test/frontend-static.test.js`: No-window syntax validation for every inline application script and moderation workflow wiring checks.
- `test/automation-static.test.js`: Ensures every documented external hazard provider remains connected to the refresh cycle.
- `test/provider-status.test.js`: Provider inventory, credential-aware states, and schedule-compatible staleness checks.
- `test/backup-restore.test.js`: Atomic backup/restore behavior, deployment storage paths, and invalid-backup rejection.
- `test/server-static.test.js`: Protected media quarantine/restore re-check wiring.
- `test/staff-access.test.js` and `test/staff-http-smoke.js`: Invite-only access and two-party ownership transfer.
- `test/postgres-job-queue.test.js` and `test/task-queue.test.js`: Queue estimates and concurrency enforcement.

---

## 10. RECENT CHANGE LOG

- **Latest — Source Style Cleanup**: Removed decorative and generated-looking comments, emoji debug output, stale test model names, and unused declarations while preserving user-facing hazard icons and labels. Normalized the automation supervisor's formatting and stopped sending placeholder image data when an attachment cannot be read.
- **Latest — Unified Public/Moderation Visibility & Fixed Hazard Schedule**: Community reports now use one server-side visibility decision everywhere. AI-plausible or moderator-approved reports are public; unverified, suspicious, likely-false, rejected, and removed reports stay moderation-only. Approved community reports are merged into the main map hazard feed, already-open report maps replace stale markers after moderator edits, and public query parameters cannot reveal hidden reports. Automated hazard refreshes now run at fixed `00:00` and `12:00` times in `America/Guatemala` instead of drifting twelve hours from process startup.
- **Latest — Full Reliability Audit**: Connected RSOE EDIS and Copernicus to the real refresh cycle; made provider failure/empty-result handling safe; aligned provider staleness with the twice-daily schedule; corrected upload cleanup and the 50MB error; made backup/restore/seed deployment-path aware and atomic; removed dead aliases, IPC, and legacy seed fields; added clean worker shutdown/restart behavior; restored quarantined media after a plausible staff re-check; narrowed proxy trust; and expanded coverage to 61 passing checks.
- **Latest — Chat Retention and Semantic Scope Guard**: Extended browser-visible chat and context retention to 72 hours of inactivity, added a persistent 72-hour chat cookie, and safely resends the last 15 turns from the same browser so context survives a server restart. Before any substantive request can reach the answering model or web search, a separate low-output, no-search AI classifier analyzes the request and recent context as untrusted data. It permits only environmental safety and Alertly intent, rejects unrelated intent without consuming the user's daily quota, and fails closed on unclear output or provider failure. The scoped answering prompt remains a second guardrail.

1. **Map Cleanup & Marker Polish**: Removed manual mapping and blue circle marker artifacts from `hazard-admin.html`. Segregated community reporting from official administrative inspection.
2. **Codebase Hygiene**: Pruned dead `node-fetch` dependency (migrated to Node native `fetch`), deleted duplicate server files, and eliminated artificial emoji comments.
3. **Subsystem API Isolation**: Structured independent configuration namespaces for Chatbot AI (`CHAT_AI_*`), Report Moderator AI (`REPORT_AI_*`), and Feeds (`FIRMS_*`).
4. **AI Vision Verification**: Implemented `lib/report-moderator-ai.js` with separately configurable text and vision models to verify community reports while quarantining explicit media for staff review.
5. **Moderation UI Integration**: Added AI credibility badges, reasoning breakdown, image viewer modal, and on-demand verification re-check to `moderation.html`.
6. **Security Hardening**: Removed invasive Discord visitor tracking webhook and middleware.
7. **Documentation Consolidation**: Consolidated `CHANGES_SUMMARY.md` into `HANDOFF.md` and preserved `CODEBASE_MAP.md` for jCodeMunch MCP.
8. **UI & Data Synchronization Overhaul**: Fixed stats, counts, and category normalization inconsistencies across `moderation.html`, `hazard-admin.html`, and `index.html`. Added one-click moderator action controls (Approve, Reject, Pending, Resolve) and live AI/community flag counters.
9. **Eliminated Parasitic Ghost Mappings & Added Anti-Caching**:
   - Removed overlapping background polygons from the moderation map. Unselected queue items use point markers, while the selected report renders its full geometry.
   - Enforced strict HTTP `Cache-Control: no-store, no-cache, must-revalidate` across all Express API routes (`/api/moderation/reports`, `/api/reports/data`, `/hazards/data`, `/api/admin/hazards`) and timestamped client requests (`?_t=...`) to stop stale browser caching.
   - Fixed topbar flex styling so navigation buttons sit on a single line without wrapping.
10. **Moderation Queue & Category Synchronization**:
    - All public, report, moderation, and hazard administration surfaces now use the shared taxonomy in `hazard-ui.js`; lightning and thunder remain storm subtypes, while earthquakes always use the seismic category icon.
    - Provider subtype text is retained as `hazardDetail`, so lightning and thunderstorms render as `⛈️` inside the Storms layer instead of losing their subtype during server normalization. Community-report and moderation point markers use the same hazard-specific design rather than the legacy generic pin or dot.
    - Replaced the horizontal accordion with a vertical category rail (`.cat-sidebar`) beside the review queue.
    - Displays `🌐 All types` and all 6 categories permanently with live item count badges (`.cat-badge`) and active state switching.
    - Simplified status filter to strictly 3 modes: `All reports`, `Regular submissions`, and `Suspicious / Flagged`.
    - Verified permanent erasure on deletion (`DELETE /api/moderation/reports/:id`) removing records from `data/reports.json` and unlinking attachments from `uploads/`.
11. **Alertly Antigravity Checklist Execution (Phases 1–10 Complete)**:
    - **Security & Route Protection**: Replaced shared keys with invite-only owner/staff accounts, password hashing, HTTP-only sessions, limited owner bootstrap, invitations, role-aware guards, and two-party ownership transfer.
    - **Removal Request Resolution**: Implemented `POST /api/moderation/reports/:id/removal-requests/:reqId/resolve` and interactive UI buttons in `moderation.html` allowing moderators to Accept (marks report rejected) or Dismiss removal requests with audit log tracking.
    - **Sliding-Window Rate Limiting & 15-Prompt Daily Quota**: Added sliding-window rate limiters on publishing, removal requests, and chat. Implemented `createDailyQuotaTracker(15)` enforcing a 15-prompt daily user limit (resets 00:00 UTC) with live badge in `index.html`.
    - **AI Chat Context**: Keeps the latest 15 user requests and assistant replies, with proportional shortening only for unusually large histories so every recent turn remains represented.
    - **Database Safety & Atomic Writes**: Wrapped `saveReports` and `saveHazards` in atomic temp-file write + rename operations to prevent file corruption.
    - **Database Backup & Restore**: Added `npm run backup` and `npm run restore` with timestamped JSON snapshots in `backups/`.
    - **Upload Hardening**: Added a 50MB-per-file incoming cap, UUID-based random filenames, strict media-extension checks, failed-upload cleanup, and automatic compression to the bounded stored format.
    - **Automated Verification**: Expanded the suite across unit, static, integration, media, storage, staff, queue, and moderation workflows.

---

## 11. PRODUCTION DEPLOYMENT GUIDE (`alertly.live`)

Alertly is designed for minimal operational overhead and zero external database dependencies.

### Prerequisites
- Linux host (Ubuntu 22.04 / 24.04 or Debian 12 recommended)
- Node.js 22.x or later (`node -v`)
- Reverse proxy (Caddy or Nginx) with HTTPS/SSL certificates

### 1. Installation
```bash
# Clone or copy repository to production server
git clone <repo-url> /var/www/alertly
cd /var/www/alertly/stream

# Install production dependencies
npm ci --omit=dev
```

### 2. Environment Configuration
Create `/var/www/alertly/stream/.env`:
```env
PORT=3000
NODE_ENV=production
TRUST_PROXY=loopback

CHAT_AI_PROVIDER=groq
CHAT_AI_BASE_URL=https://api.groq.com/openai/v1
CHAT_AI_MODEL=openai/gpt-oss-20b
CHAT_AI_API_KEY=your-groq-api-key

REPORT_AI_PROVIDER=groq
REPORT_AI_BASE_URL=https://api.groq.com/openai/v1
REPORT_AI_VISION_MODEL=qwen/qwen3.8-27b
REPORT_AI_TEXT_MODEL=openai/gpt-oss-20b
REPORT_AI_API_KEY=your-groq-api-key

ENABLE_AUTOMATION=true
HAZARD_BBOX=-180,-60,180,85
HAZARD_REFRESH_TIMES=00:00,12:00
HAZARD_REFRESH_TIMEZONE=America/Guatemala
```

### 3. Process Management (PM2)
```bash
# Install PM2 globally
npm install -g pm2

# Start Alertly
pm2 start server.js --name alertly --time

# Configure PM2 to start on system boot
pm2 startup
pm2 save
```

### 4. Reverse Proxy Setup (Caddy Example)
Create `/etc/caddy/Caddyfile`:
```caddy
alertly.live {
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Real-IP {remote_host}
    }
}
```
Reload Caddy:
```bash
systemctl reload caddy
```

### 5. Automated Backups (Cron Job)
Add a nightly cron job to create database backups:
```bash
crontab -e
# Runs nightly at 02:00 AM
0 2 * * * cd /var/www/alertly/stream && npm run backup >> /var/log/alertly-backup.log 2>&1
```

---

## 12. AI PROVIDER SWITCHING & COST ESTIMATION GUIDE

### Switching AI Providers
The chat and report verification modules use the standard OpenAI-compatible completions format. You can switch to any provider (Groq, OpenAI, OpenRouter, Ollama, DeepSeek) simply by updating `.env`:

```env
# Example: Using OpenAI directly
CHAT_AI_BASE_URL=https://api.openai.com/v1
CHAT_AI_MODEL=gpt-4o-mini
CHAT_AI_API_KEY=sk-...

# Example: Using OpenRouter
CHAT_AI_BASE_URL=https://openrouter.ai/api/v1
CHAT_AI_MODEL=anthropic/claude-3.5-haiku
CHAT_AI_API_KEY=sk-or-...
```

### Cost Planning
- Chat keeps at most 15 recent user/assistant turns and bounds unusually large histories before provider submission.
- Report verification uses the text model when no visual media is present and the vision model only when needed; video evidence is summarized into contact sheets.
- Provider prices and free-tier limits change. Calculate deployment cost from the privacy-safe usage totals in the staff console and the provider's current official pricing instead of relying on hard-coded estimates.

---

## 13. EMERGENCY LOW-DATA & MOBILE OPTIMIZATIONS

### 1. Resizable & Responsive Moderator Panels (`moderation.html`)
- **Queue Panel (Left)**: Remains visible with horizontal category pill chips positioned at the top (`🌐 All types`, `🔥 Fire`, `🌊 Flood`, `🌋 Volcanic Activity`, `⛰️ Landslide`, `🫨 Earthquake`, `❓ Other`) above the report queue, giving report cards the full panel width without wasted margins. Can be manually collapsed using the header toggle button into a floating pill tab (`📋 Queue [count] ▶`).
- **Satellite Map Pane (Center)**: Flexibly fills all remaining viewport space (`flex: 1 1 0%`) between the queue and detail panels.
- **Detail Panel (Right)**: Starts automatically collapsed when no incident is selected. Auto-expands smoothly when any incident is selected from the queue or map, and auto-collapses on close/deselect/resolve.
- **Horizontal Resizers**: Sleek glass draggable splitters between panes (`#queueResizer` and `#detailResizer`) allow horizontal-only drag resizing between 240px and 650px. User-preferred widths are persisted in `localStorage`. Double-click resets or toggles collapse.
- **Render Diffing**: Background 3-second polling computes data signatures to prevent DOM thrashing, garbage collection spikes, and battery drain on low-end devices.

### 2. Built-in HTTP Compression (`server.js`)
- Response compression enabled using `compression` middleware, automatically applying Gzip to HTML, JSON, CSS, and JS.
- Bypasses SSE streams (`/chat`) and `no-transform` headers to prevent buffering delays.
- Results:
  - `moderation.html`: 54.8 KB → **12.8 KB** (77% wire reduction)
  - `index.html`: 55.8 KB → **13.8 KB** (75% wire reduction)
  - `report.html`: 98.0 KB → **22.6 KB** (77% wire reduction)
  - API JSON responses reduced by ~80%.

### 3. Emergency Photo Downscaling (`report.html`)
- Citizen photo attachments from modern mobile phone cameras (often 4–10 MB) are automatically resized client-side via an offscreen HTML5 `<canvas>` to max 1600px JPEG (~150–250 KB) before uploading.
- Reduces upload payload by **~95%**, enabling successful report submissions in emergency disaster zones over degraded 2G/3G connections in seconds instead of minutes.

---

## 14. AUTOMATED MEDIA COMPRESSION PIPELINE (`lib/media-compressor.js`)

Inspired by `vladaad/discordcompressor` (Go + FFmpeg utility for target-size video compression).

### Key Mechanics & Algorithm
1. **Target Size Formulation**:
   - Compresses videos down to **≤ 2 Megabytes** (the default target, configurable via `TARGET_SIZE_BYTES`).
   - Uses the `vladaad/discordcompressor` container overhead formula:
     $$\text{Total Bits} = \text{Target Bytes} \times 8 \times 0.94$$
     The 6% headroom ensures the MP4 container headers, moov atom, and audio index do not push the final file over 2 MB.
   - Bitrate calculation:
     $$\text{Total kbps} = \frac{\text{Total Bits}}{\text{Duration (s)} \times 1000}$$
     $$\text{Audio kbps} = 64 \text{ kbps (or 48/32 kbps if video is long or low total budget)}$$
     $$\text{Video kbps} = \max(80, \min(2600, \text{Total kbps} - \text{Audio kbps}))$$

2. **Resolution Downscaling (Max 720p)**:
   - Dynamic aspect-ratio scaling: `min(1280, iw)` for landscape, `min(720, ih)` for portrait.
   - Enforces even macroblock dimensions via `pad=ceil(iw/2)*2:ceil(ih/2)*2` for libx264 compatibility.
   - If media is already ≤ 720p, resolution is preserved without unnecessary downsampling.

3. **Two-Pass libx264 Encoding**:
   - **Pass 1**: Rapid video analysis pass with `-an -f null /dev/null` creating temporary pass logs.
   - **Pass 2**: Final video pass with audio encode, `yuv420p` color space, and `-movflags +faststart`.
   - Temporary pass log files are automatically cleaned up in `os.tmpdir()`.

4. **Progressive Streaming (`+faststart`)**:
   - Rearranges the MP4 container so the `moov` atom (metadata index) is placed at the beginning of the file.
   - Allows instant video streaming in mobile browsers without waiting for the full 2MB file to download.

5. **Image Optimization**:
   - Automatically downsizes large photos (e.g. 4K/1080p camera photos) to max 720p with crisp visual quality (`-q:v 3`).

6. **End-to-End Server Integration & Universal Video Conversion**:
   - Accepts **all major video formats** (`.mp4`, `.webm`, `.mov`, `.mkv`, `.avi`, `.flv`, `.wmv`, `.3gp`, `.ts`, `.ogv`, `.m4v`, `.mpg`).
   - Automatically transcodes any video format into standard **H.264/AAC MP4** with progressive streaming (`+faststart`), renames the final asset to `.mp4`, removes the raw upload, and updates database references so every browser, iPhone, Android, and PC can stream the video natively.
   - Moderation dashboard (`moderation.html`) updated with interactive video players and `▶ VIDEO` badges.
   - Fully covered by `test/media-compressor.test.js`; the full project currently passes 61 automated checks.

12. **Canonical Repository & Cross-Platform Repair (2026-10-07)**:
   - Restored the complete Alertly source, installer foundation, tests, and deployment files to the private Git repository.
   - Switched the public chat frontend to JSON responses while retaining legacy SSE compatibility, avoiding fragile streamed-response behavior in embedded mobile browsers.
   - Added a self-contained test runner that starts clean temporary HTTP servers instead of assuming a server is already running.
   - Added Windows-safe file replacement and an FFmpeg one-pass fallback when old vendor binaries fail to produce usable two-pass statistics.
   - Upgraded vulnerable dependencies; `npm audit` reports zero known vulnerabilities.

7. **Host Compatibility & Bluehost Deployment Guide**:
   - **Binary Resolution**: The compressor dynamically detects FFmpeg via `getFfmpegPath()`:
     1. Environment variable `FFMPEG_PATH` (e.g. `FFMPEG_PATH=/custom/bin/ffmpeg`).
     2. Local project directory (`./bin/ffmpeg` or `./bin/ffmpeg.exe`).
     3. System `PATH` (`ffmpeg` / `ffprobe`).
   - **Graceful Fallback**: If FFmpeg is completely missing on a host, `autoCompressFile` gracefully bypasses compression and saves the original media without throwing errors or interrupting citizen report publishing.
   - **Bluehost Shared vs VPS**:
     - *Bluehost Shared Hosting (cPanel)*: Does **not** include FFmpeg in system PATH and enforces strict CloudLinux LVE CPU execution limits (which may kill processes exceeding 30-60 seconds of CPU). While the Node.js server will boot and safely store raw uploads, automated video compression requires either placing a static Linux `ffmpeg` binary in `bin/` or upgrading to a VPS.
     - *Recommended VPS Hosts*: Any standard Linux VPS (DigitalOcean $4-6/mo, Hetzner €3.50/mo, Linode, AWS EC2, or Railway/Render/Fly.io Docker containers with `apt-get install -y ffmpeg`) has full root access, handles CPU `libx264 -preset veryfast` encoding in 1-3 seconds, and runs out of the box with zero configuration.



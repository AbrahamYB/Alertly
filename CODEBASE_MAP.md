# ALERTLY — CODEBASE MAP
> Source of truth: the canonical private Git repository.
> Last updated: 2026-10-07
> **Update this file after any significant code change using jCodeMunch.**

---

## Directory Structure

```
stream/
├── server.js               ← Express app, all routes, sessions, purge jobs, rate limits
├── automation.js           ← Feed fetchers (child process, auto-restart)
├── worker_manager.js       ← Forks automation.js, IPC bridge
├── package.json
│
├── lib/
│   ├── ai.js               ← Groq chat (compound-mini, web search, 413 retry)
│   ├── media-compressor.js ← 720p / 2MB video & image compressor (vladaad/discordcompressor architecture)
│   ├── report-moderator-ai.js ← Groq vision + report credibility verification
│   ├── domain.js           ← Data normalization + hazard clustering
│   ├── fixed-schedule.js   ← Fixed local-time schedule calculation for hazard refreshes
│   ├── hazard-region.js    ← Viewport bbox filter
│   ├── provider-status.js  ← Automation provider health reader
│   ├── security.js         ← Rate limiters, daily quota (15/day), sanitization, auth guards
│   ├── file-utils.js       ← Cross-platform safe file replacement
│   ├── staff-access.js     ← Invite-only staff access and ownership transfer
│   ├── task-queue.js       ← Bounded in-process queue
│   └── postgres-job-queue.js ← Durable PostgreSQL queue foundation
│
├── scripts/
│   ├── backup.js           ← Database backup generator (npm run backup)
│   ├── restore.js          ← Database backup restore (npm run restore)
│   └── test.js             ← Isolated unit/API/staff test orchestrator
│
├── installer/scripts/setup.js ← Hardware-aware installation configuration
│
├── index.html              ← Public map + AI chat with live 15-prompt daily quota badge
├── report.html             ← Report submission form (~98 KB inline, image/video support)
├── moderation.html         ← Moderation dashboard with removal request review & resolution
├── hazard-admin.html       ← Admin hazard editor (authenticated / localhost dev)
│
├── data/
│   └── reports.json        ← Community reports store (atomic JSON write)
├── hazards.geojson         ← Hazards store (atomic GeoJSON write)
├── uploads/                ← Uploaded report media (auto-compressed to <=2MB, 720p)
├── backups/                ← Timestamped database snapshots (.json)
│
├── test/
│   ├── ai.test.js          ← AI retry + search opt-out tests
│   ├── domain.test.js      ← Normalization + grouping tests
│   ├── fixed-schedule.test.js ← Guatemala midnight/noon schedule tests
│   ├── frontend-static.test.js ← No-window page syntax and moderation wiring checks
│   ├── media-compressor.test.js ← 720p / 2MB video & image compression tests
│   ├── report-moderator-ai.test.js ← Vision + report AI verification tests
│   ├── security.test.js    ← Rate limiting, daily quota, bounds, and auth tests
│   └── api.test.js         ← End-to-end API lifecycle integration tests
│
├── HANDOFF.md              ← Unified master documentation and handoff reference
└── CODEBASE_MAP.md         ← This file (keep updated via jCodeMunch)
```

---

## Express Routes (`server.js`)

### Static Pages
| Method | Path | Guard | Handler |
|--------|------|-------|---------|
| GET | `/` | — | Serves `index.html` |
| GET | `/report` | — | Serves `report.html` |
| GET | `/moderation` | — | Serves `moderation.html` |
| GET | `/hazard-admin` | `requireAdmin` | Serves `hazard-admin.html` |
| GET | `/uploads/*` | — | Static uploaded media (dotfiles denied) |

### Health & Authentication
| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/health` | — | JSON health check (uptime, env flags) |
| GET | `/api/auth/status` | — | Check admin/moderator authorization status |
| POST | `/api/auth/login` | — | Authenticate with API key, sets httpOnly cookie |
| POST | `/api/auth/logout` | — | Clear auth cookie session |
| GET | `/api/provider-status` | — | Feed automation provider status |

### Community Reports & Moderation
| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/api/reports/data` | — | Only AI-plausible or moderator-approved public reports |
| GET | `/api/moderation/reports` | `requireModeratorOrAdmin` | All reports for moderation UI |
| PATCH | `/api/moderation/reports/:id` | `requireModeratorOrAdmin` | Update report (reject, restore, edit, merge, note) |
| DELETE | `/api/moderation/reports/:id` | `requireModeratorOrAdmin` | Permanently delete report + attachments |
| POST | `/api/reports/publish` | `publishLimiter` | Submit report (≤5 files, ≤25MB, UUID filenames) |
| POST | `/api/removal` | `removalLimiter` | Request community report removal |
| POST | `/api/moderation/reports/:id/verify-ai` | `requireModeratorOrAdmin` | On-demand AI verification & vision re-check |
| POST | `/api/moderation/reports/:id/removal-requests/:reqId/resolve` | `requireModeratorOrAdmin` | Accept or dismiss removal request |

### AI Chat
| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| POST | `/chat` | `chatLimiterUnlessStaff` | JSON by default, legacy SSE support, 15 prompts/day public quota, staff bypass, 15-turn context |
| GET | `/api/chat/quota` | — | Check the public daily quota or signed-in staff unlimited status |
| GET | `/api/staff/ai-usage` | `requireStaff` | Privacy-safe daily AI request/token aggregates and latest provider limit headers |
| POST | `/session/reset` | — | Clear chat session cookie |

### Hazards (Admin)
| Method | Path | Guard | Description |
|--------|------|-------|-------------|
| GET | `/hazards/data` | — | Public hazard GeoJSON (viewport-scoped, grouped) |
| GET | `/api/admin/hazards` | `requireAdmin` | Full admin hazard list |
| POST | `/hazards/publish` | `requireAdmin` | Create new hazard |
| PATCH | `/api/admin/hazards/:id` | `requireAdmin` | Edit hazard |
| POST | `/api/admin/hazards/:id/merge` | `requireAdmin` | Merge two hazards |
| DELETE | `/api/admin/hazards/:id` | `requireAdmin` | Delete hazard |

---

## Server Functions (`server.js`)

| Function | Description |
|----------|-------------|
| `getHazards()` | Read `hazards.geojson` |
| `saveHazards(data)` | Write `hazards.geojson` |
| `getReports()` | Read `data/reports.json` |
| `saveReports(reports)` | Atomic write to `data/reports.json` via `.tmp` rename |
| `purgeExpiredReports(now)` | Remove reports and orphan uploads older than 30 days |
| `purgeExpiredAutomatedHazards(now)` | Remove automated hazards older than 30 days |
| `requireAdmin(req, res, next)` | Guard checking `ADMIN_API_KEY` (Bearer/header/cookie) or localhost |
| `requireModeratorOrAdmin(req, res, next)` | Guard checking moderator or admin authorization |
| `getOrCreateSession(req, res)` | Get or create chat session (6h TTL) |
| `resetSession(sid)` | Delete a session by ID |
| `send(value)` | Write a legacy SSE data frame when JSON mode is not requested |

---

## Scripts (`scripts/`)

| Script | Command | Description |
|--------|---------|-------------|
| `scripts/backup.js` | `npm run backup` | Creates timestamped snapshot of reports, hazards, and config in `backups/` |
| `scripts/restore.js` | `npm run restore [file]` | Restores data files from a backup snapshot |
| `installer/scripts/setup.js` | installer bootstrap | Writes versioned hardware/deployment choices without changing services |
| `scripts/test.js` | `npm test` | Runs unit tests plus isolated API and staff HTTP checks |

---

## Library Functions

### `lib/security.js`
| Function | Description |
|----------|-------------|
| `createRateLimiter(options)` | Sliding-window Express rate limiter |
| `createDailyQuotaTracker(maxDaily)` | Tracks and enforces 15 daily prompts quota per session/IP (resets 00:00 UTC) |
| `isValidCoordinate(lat, lng)` | Validates latitude [-90, 90] and longitude [-180, 180] |
| `sanitizeText(str, maxLength)` | Trims whitespace and bounds string length |
| `getSafeExtension(filename, mimetype)` | Whitelists JPG, PNG, WebP, GIF, MP4, WebM; rejects unsafe types |
| `isAuthorizedAdmin(req, key)` | Verifies Bearer token, X-Admin-Key header, cookie, or localhost fallback |

### `lib/ai.js`
| Function | Description |
|----------|-------------|
| `aiConfig(env)` | Returns `{provider, baseUrl, model, key, search}` from env |
| `answerChat(messages, opts)` | Groq API call, web search, 413 retry with trimmed history |

### `lib/report-moderator-ai.js`
| Function | Description |
|----------|-------------|
| `reportAiConfig(env)` | Returns `{provider, baseUrl, model, key}` for moderation |
| `evaluateReportWithAI(report, opts)` | Evaluates plausibility & attached images via Groq Vision |

### `lib/domain.js`
| Function | Description |
|----------|-------------|
| `isoDate(value, fallback)` | Parse/validate ISO date string |
| `cleanType(value)` | Normalize hazard type string |
| `normalizeHazard(feature, now)` | Validate + normalize hazard GeoJSON feature |
| `normalizeReport(input, now)` | Validate + normalize community report |
| `applyReportAiEvaluation(report, evaluation, now)` | Apply AI decision and canonical public/moderation state |
| `isReportPublic(report)` | Single visibility decision shared by every public feed |
| `reconcileReportVisibility(report)` | Upgrade legacy reports to the canonical visibility state |
| `normalizeCollection(collection)` | Normalize a whole FeatureCollection |
| `distanceKm(a, b)` | Haversine distance between two [lat,lng] points |
| `groupNearbyPointHazards(collection, radiusKm)` | Cluster point hazards within radius for display |

### `lib/hazard-region.js`
| Function | Description |
|----------|-------------|
| `getHazardBbox()` | Read `HAZARD_BBOX` env or return Central America default |
| `coordinatesInBbox(coords, bbox)` | True if [lat,lng] is inside bbox |
| `featureInHazardRegion(feature, bbox)` | Filter a feature to the active region |

### `lib/provider-status.js`
| Function | Description |
|----------|-------------|
| `readProviderStatus(file)` | Read automation provider health from file |

### `lib/fixed-schedule.js`
| Function | Description |
|----------|-------------|
| `parseDailyTimes(value)` | Validate fixed `HH:MM` daily schedule values |
| `zonedMinute(date, timeZone)` | Resolve a timestamp to a minute in the configured time zone |
| `nextScheduledTime(from, options)` | Find the next fixed wall-clock refresh without boot-time drift |

---

## Automation (`automation.js` + `worker_manager.js`)

### Worker Manager
| Symbol | Description |
|--------|-------------|
| `startAutomation()` | Fork `automation.js`, auto-restart on crash |
| `sendToWorker(msg)` | Send IPC `"trigger"` to child to force refresh |

### Automation Feeds (child process)
| Function | Feed |
|----------|------|
| `refreshAutomatedHazards()` | Master runner — calls all fetchers |
| `recentProviderFeatures(features)` | Dedup by provider + recency before merge |
| `getHazards()` / `saveHazards()` | Child-process file I/O (own copies) |
| `fetchUSGS()` | USGS earthquake feed |
| `fetchGDACS()` | GDACS multi-hazard feed |
| `fetchNASAEONET()` | NASA EONET events |
| `fetchRSOE()` | RSOE EDIS alerts |
| `fetchCopernicusEMS()` | Copernicus rapid mapping activations + AOI polygons |
| `fetchFIRMS()` | NASA FIRMS fire hotspots (needs `FIRMS_MAP_KEY`) |

---

## Pages — Feature Map

### `index.html` — Public Map
```
Map
  ├── Leaflet (OSM + Satellite toggle)
  ├── Hazard layers by type (viewport-scoped, radius-grouped)
  ├── Report markers (approved community reports)
  └── Drawing tools (GPS Circle | Area | Undo)

Sidebar
  ├── Hazard type filters (Fire, Flood, Volcano, Landslide, Earthquake, Other)
  ├── Time range toggle
  ├── Layer toggle (OSM / Satellite)
  └── Moderation + Admin links

AI Chat Panel
  ├── Toggle (▾) + Save to device (↓) buttons — both icon-btn style
  ├── Input + Send button (SSE streaming, char-by-char typing animation)
  ├── localStorage autosave (key: alertly_chat_v1, 6h TTL, MutationObserver)
  └── Download exports plain-text .txt via Blob URL
```

### `report.html` — Report Submission
```
Map (Leaflet, full-screen behind form)
  └── Location Detection: 3-second delay after GPS fix (GPS Circle mode only) -> auto-zoom (duration: 2.5s, easeLinearity: 0.15); never runs if GPS fails/unavailable; cancels immediately if user drags or zooms before/during animation

Drawing State
  ├── draftCoordinates[]      ← [lng, lat] pairs
  ├── draftGeometryLayer      ← Leaflet Polygon/Polyline on map (styled dynamically with HAZARD_COLORS)
  ├── draftVertexLayer        ← Vertex markers (styled with active hazard color)
  └── gpsCenter               ← {lat, lng} for GPS Circle mode

Buttons: GPS Circle | Area | Undo
  ├── Responsive centering across mobile & desktop viewports
  ├── Hover highlight animations (matching chip buttons)
  └── selectGeometryMode(mode) & requestUserLocationForRadius()

Form & Input Area
  ├── Hazard type chips with HAZARD_COLORS dynamic mapping
  ├── Glassmorphic pill input area styled after main chatbox (.chat-input-bar)
  ├── Image upload (≤5, preview strip, viewer modal)
  └── POST /api/reports/publish (multipart)
```

### `moderation.html` — Moderation Dashboard
```
Left: Review Queue
  ├── Auto-collapses when 0 reports in queue or matching filter
  ├── Expand floating tab (📋 Queue [count] ▶) when collapsed
  ├── Left Gutter Resizer: horizontal drag slider to resize queue width (240px to 650px)
  ├── Search + filter by status (All, Regular, Suspicious) and date window (24h, 7d, 30d)
  └── Vertical category sidebar with live count badges
Center: Leaflet Map Pane
  ├── Satellite World Imagery + Boundaries/Places
  ├── Interactive incident markers & polygons
  └── Geometry editor (vertex drag/add/undo)
Right: Report Detail
  ├── Auto-collapses until a report/activity is selected from queue or map
  ├── Auto-expands when report selected; auto-collapses on close/deselect/resolve
  ├── Right Gutter Resizer: horizontal drag slider to resize detail width (280px to 650px)
  ├── Approve ✓ / Reject × / Pending ⏳ action buttons
  ├── AI credibility verification card with verdict badge & vision evidence
  ├── Removal request resolution (Accept Removal / Dismiss)
  ├── Nearby duplicate report grouping & unlinking
  └── Attached image gallery with pan/zoom viewer modal

Performance & Low-Data Optimizations:
  ├── Server-side Gzip compression (cuts HTML payload from 55 KB to 12.8 KB, 77% reduction)
  ├── Signature diffing in 3-second background poll (prevents unnecessary DOM churn)
  ├── Debounced search filter (120ms)
  └── LocalStorage width persistence (alertly_mod_queue_width, alertly_mod_detail_width)
```

### `hazard-admin.html` — Hazard Admin (localhost only)
```
Drawing State: draft[], shape, vertices (LayerGroup), mode

Key functions
  ├── redraw()       setMode(m)     fill(h)
  ├── save()         removeHazard() mergeHazard()
  └── selectHazard(id)  newHazard()  geo()
```

---

## Data Models

### Report
```json
{
  "id": "string",
  "geometry": { "type": "Polygon", "coordinates": [[...]] },
  "properties": {
    "hazard": "fire|flood|volcano|landslide|earthquake|other",
    "description": "string",
    "severity": "low|medium|high|critical",
    "moderationStatus": "pending|approved|rejected",
    "status": "active|monitoring|resolved",
    "createdAt": "ISO",  "updatedAt": "ISO",
    "images": ["filename.jpg"],
    "auditLog": [{ "action": "string", "at": "ISO", "note": "string" }],
    "mergedInto": "id|null",
    "removalRequested": true
  }
}
```

### Hazard (GeoJSON Feature)
```json
{
  "id": "string",
  "type": "Feature",
  "geometry": { "type": "Point|LineString|Polygon|MultiPolygon", "coordinates": [...] },
  "properties": {
    "hazard": "fire|flood|...",
    "title": "string",
    "severity": "low|medium|high|critical",
    "confidence": "unverified|possible|probable|confirmed",
    "status": "active|monitoring|resolved",
    "source": "string",
    "sourceType": "admin verified|automated|...",
    "createdAt": "ISO",  "lastUpdatedAt": "ISO",  "expiresAt": "ISO|null",
    "groupedEventCount": 1
  }
}
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AI_API_KEY` | required | Groq API key |
| `AI_PROVIDER` | `groq` | `groq` or `compatible` |
| `AI_BASE_URL` | Groq endpoint | Override for compatible providers |
| `AI_MODEL` | `groq/compound-mini` | Model name |
| `AI_WEB_SEARCH` | `true` | Enable Groq web search tool |
| `ENABLE_AUTOMATION` | `false` | Fork automation worker |
| `HAZARD_BBOX` | Central America | `minLon,minLat,maxLon,maxLat` |
| `FIRMS_MAP_KEY` | — | NASA FIRMS key (fire hotspots) |
| `PORT` | `3000` | Server port |

---

## Groq Limits (Free Tier — `groq/compound-mini`)

| Metric | Limit |
|--------|-------|
| RPM | 30 |
| RPD | **250** ← daily cap, tightest limit |
| TPM | 70,000 |

---

## Architectural Rules (do not break these)

- `/hazard-admin` and `/api/admin/*` require an authenticated owner/staff or configured administrator key; localhost fallback is development-only
- All HTML is single large inline files — preserve script/style block boundaries
- `automation.js` runs as a **separate process** with its own file I/O copies — no shared state with server
- Runtime reports/hazards remain file-backed in the demo build; `postgres-job-queue.js` is the optional durable queue foundation for organization deployments
- `clearDraftGeometry()` in `report.html` is **function-scoped** — must use `addEventListener`, not `onclick`
- Chat history is bounded to 15 user/assistant turns in server memory and is cleared by reset, expiry, or restart

---

## Test Suite

```
npm test
```

| Test | Covers |
|------|--------|
| Compound 413 retry | `answerChat` retries with trimmed history on size error |
| Search opt-out | "don't search" disables web_search tool |
| Hazard normalization | `normalizeHazard` validates + defaults all fields |
| Report normalization | `normalizeReport` validates + defaults all fields |
| Grouping | `groupNearbyPointHazards` clusters correctly |
| Report moderator AI | `evaluateReportWithAI` evaluates text & vision credibility |
| Media Compressor | `autoCompressFile`, bitrate calculation, 2-pass libx264 with old-Windows fallback, 720p image/video output <=2MB |
| HTTP lifecycle | Clean temporary server, auth, reports, removal resolution, deletion, and public-data sanitization |
| Staff workflow | Invitations, sessions, protected pages, and two-party ownership transfer |

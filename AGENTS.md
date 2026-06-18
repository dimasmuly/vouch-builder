# AGENTS.md — Vouch Handover Service

## What this repo is

A Node.js service that generates action-first night-shift handovers for hotel front desks.
It ingests structured events (`data/events.json`) and free-text night logs (`data/night-logs.md`),
reconciles issues across multiple nights, and returns a prioritised handover for the morning manager.

---

## Prerequisites

- Node.js 18+
- An optional `GEMINI_API_KEY` (Google AI Studio) for AI features (translation, extraction from free-text, grounding verification). Without it the service still works — free-text logs are returned as raw notes.

---

## Running locally

```bash
# Install dependencies
npm install

# Set Gemini API key (optional but recommended)
export GEMINI_API_KEY=your_key_here

# Start dev server (with hot reload)
npm run dev

# Or production mode
npm run build && npm start
```

Server starts on port 3000 (override with `PORT` env var).

---

## API endpoints

### `GET /health`
Returns `{ status: "ok", time: "..." }`. Use for uptime checks.

### `GET /handover?date=YYYY-MM-DD`
Generates a handover using the bundled sample data.
- `date` query param sets the morning date to generate for (default: `2026-05-30`)
- Add `Accept: text/html` header to get HTML instead of JSON

```bash
# JSON (default)
curl https://your-deployed-url/handover

# HTML (browser-friendly)
curl -H "Accept: text/html" https://your-deployed-url/handover

# Specific date
curl "https://your-deployed-url/handover?date=2026-05-28"
```

### `POST /handover`
Accepts custom data. Body fields (all optional, falls back to sample data):
```json
{
  "eventsData": { /* events.json contents */ },
  "logsMarkdown": "## Night of...",
  "shiftDate": "2026-05-30"
}
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | No | Google AI Studio key for AI extraction and grounding |
| `PORT` | No | HTTP port (default: 3000) |
| `LOG_LEVEL` | No | Pino log level: `trace`, `debug`, `info`, `warn`, `error` (default: `info`) |
| `NODE_ENV` | No | Set to `production` for JSON logs (default: pretty-printed) |

---

## Architecture

```
POST /handover or GET /handover
        │
        ▼
  [Ingest: structured.ts]   ← Parse events.json, assign shift dates
        +
  [Ingest: freetext.ts]     ← Parse night-logs.md, call Gemini to extract events
        │
        ▼
  [Reconcile: tracker.ts]   ← Build issue threads across nights
        │
        ▼
  [Generate: generator.ts]  ← Produce prioritised handover JSON
        │
        ├─ [Grounding: gemini.ts]  ← Verify claims against source events
        │
        ▼
  [View: html.ts]            ← Render as HTML if requested
```

---

## Debugging a bad handover

All handover pipeline runs emit structured logs with `hotelId` and `shiftDate` fields.

To find logs for a specific hotel/night:
```bash
# If running locally with LOG_LEVEL=debug
npm run dev 2>&1 | grep '"hotelId":"lumen-sg"'

# In production (Railway/Render), filter by field in your log aggregator:
# hotelId = lumen-sg AND shiftDate = 2026-05-30
```

Key log events to look for:
- `"Structured events parsed"` — how many structured events were read
- `"Free-text block processed"` — which blocks were extracted and how many events came out
- `"Prompt injection detected"` — ⚠️ someone tried to manipulate the output
- `"Grounding check found ungrounded claims"` — AI may have introduced facts not in source
- `"Handover pipeline complete"` — summary of section counts

---

## Adding a new hotel

Pass different `eventsData` and `logsMarkdown` in the POST body. The hotel metadata
(id, name, timezone) is read from the `hotel` field in `events.json`. The shift date
resolution logic uses the hotel's UTC offset, so make sure `timezone` is correct.

---

## Running against new night logs

The pipeline is designed to generalise:
1. Free-text logs are sent to Gemini with a strict system prompt that tells it to extract only what's stated
2. Non-English text is translated (Gemini detects language automatically)
3. Prompt injection attempts in guest notes are detected at two layers: Gemini system prompt + regex scan

To test with a new log:
```bash
curl -X POST https://your-url/handover \
  -H "Content-Type: application/json" \
  -d '{"logsMarkdown": "## Night of Mon 18 Jun → morning Tue 19 Jun\n\nAll quiet tonight...", "shiftDate": "2026-06-19"}'
```

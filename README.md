# Vouch Builder — Night-Shift Handover Service

A backend service that ingests hotel front-desk events (structured JSON + free-text markdown) and generates an **action-first handover** for the morning manager.

## Quick Start

```bash
npm install
export GEMINI_API_KEY=your_key  # optional — enables AI extraction from free-text logs
npm run dev
```

Then:

```bash
# JSON handover (latest shift in sample data)
curl http://localhost:3000/handover

# HTML handover (browser-readable)
curl -H "Accept: text/html" http://localhost:3000/handover

# Specific date
curl "http://localhost:3000/handover?date=2026-05-28"
```

## Deployed

```bash
curl https://vouch-handover.up.railway.app/handover
```

## Documentation

- [`AGENTS.md`](./AGENTS.md) — How to run, debug, and extend the service
- [`DECISIONS.md`](./DECISIONS.md) — Architecture decisions, tradeoffs, and what I'd do next

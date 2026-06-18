import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as fs from "fs";
import * as path from "path";

import { logger, handoverLogger } from "./logger";
import { NormalizedEvent } from "./types";
import { parseStructuredEvents } from "./ingest/structured";
import { parseFreetextEvents } from "./ingest/freetext";
import { reconcileEvents } from "./reconcile/tracker";
import { generateHandover } from "./handover/generator";
import { renderHandoverHtml } from "./views/html";
import { verifyGrounding } from "./ai/gemini";

const app = new Hono();

app.use("*", cors());

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (c) => {
  return c.json({ status: "ok", time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Core handover pipeline
// ---------------------------------------------------------------------------
async function runHandoverPipeline(opts: {
  eventsData: unknown;
  logsMarkdown: string;
  targetShiftDate: string; // "YYYY-MM-DD" — the morning date to generate handover FOR
}) {
  const { eventsData, logsMarkdown, targetShiftDate } = opts;

  // 1. Parse structured events
  const { hotel, events: structuredEvents } = parseStructuredEvents(eventsData);
  const hLog = handoverLogger(hotel.id, targetShiftDate);

  hLog.info(
    { structuredCount: structuredEvents.length },
    "Structured events parsed"
  );

  // 2. Parse free-text events via AI
  let freetextEvents: NormalizedEvent[] = [];
  if (logsMarkdown && logsMarkdown.trim().length > 0) {
    freetextEvents = await parseFreetextEvents(logsMarkdown, hotel.id);
    hLog.info({ freetextCount: freetextEvents.length }, "Free-text events parsed");
  }

  // 3. Combine all events
  const allEvents = [...structuredEvents, ...freetextEvents];
  hLog.info({ totalEvents: allEvents.length }, "All events combined");

  // 4. Reconcile across nights → build issue threads
  const threads = reconcileEvents(allEvents, targetShiftDate, hotel.id);
  hLog.info({ threadCount: threads.length }, "Issue threads built");

  // 5. Generate handover
  const handover = generateHandover(threads, targetShiftDate, allEvents, hotel);

  // 6. Grounding verification (optional, requires Gemini)
  if (process.env.GEMINI_API_KEY) {
    const allItems = handover.sections.flatMap((s) => s.items);
    const grounding = await verifyGrounding(
      allItems,
      allEvents.map((e) => ({ id: e.sourceRef, description: e.description }))
    );
    handover.groundingVerified = grounding.verified;
    if (!grounding.verified) {
      hLog.warn(
        { ungroundedClaims: grounding.ungroundedClaims },
        "Grounding check found ungrounded claims"
      );
      // Add ungrounded claims as data quality flags
      for (const claim of grounding.ungroundedClaims) {
        handover.dataQualityFlags.push({
          kind: "incomplete",
          description: `Ungrounded claim: "${claim.claim}" — ${claim.reason}`,
          sourceRefs: [],
        });
      }
    }
  }

  hLog.info(
    {
      actNow: handover.sections.find((s) => s.priority === "act_now")?.items.length,
      pending: handover.sections.find((s) => s.priority === "pending")?.items.length,
      resolved: handover.sections.find((s) => s.priority === "resolved")?.items.length,
      fyi: handover.sections.find((s) => s.priority === "fyi")?.items.length,
      dataQualityFlags: handover.dataQualityFlags.length,
      groundingVerified: handover.groundingVerified,
    },
    "Handover pipeline complete"
  );

  return handover;
}

// ---------------------------------------------------------------------------
// Load sample data once at startup
// ---------------------------------------------------------------------------
const DATA_DIR = path.resolve(__dirname, "../data");

function loadSampleData() {
  const eventsPath = path.join(DATA_DIR, "events.json");
  const logsPath = path.join(DATA_DIR, "night-logs.md");

  if (!fs.existsSync(eventsPath)) {
    throw new Error(`events.json not found at ${eventsPath}`);
  }

  const eventsData = JSON.parse(fs.readFileSync(eventsPath, "utf-8"));
  const logsMarkdown = fs.existsSync(logsPath)
    ? fs.readFileSync(logsPath, "utf-8")
    : "";

  return { eventsData, logsMarkdown };
}

// ---------------------------------------------------------------------------
// GET /handover — uses bundled sample data, generates for the most recent shift
// ---------------------------------------------------------------------------
app.get("/handover", async (c) => {
  try {
    const { eventsData, logsMarkdown } = loadSampleData();

    // Default: generate for the most recent shift date in the data
    const shiftDate = c.req.query("date") ?? "2026-05-30";

    logger.info({ shiftDate }, "GET /handover called");

    const handover = await runHandoverPipeline({
      eventsData,
      logsMarkdown,
      targetShiftDate: shiftDate,
    });

    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.html(renderHandoverHtml(handover));
    }
    return c.json(handover);
  } catch (err) {
    logger.error({ err }, "GET /handover failed");
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// POST /handover — accepts custom data
// Body: { eventsData?: object, logsMarkdown?: string, shiftDate?: string }
// ---------------------------------------------------------------------------
app.post("/handover", async (c) => {
  try {
    let body: {
      eventsData?: unknown;
      logsMarkdown?: string;
      shiftDate?: string;
    } = {};

    try {
      body = await c.req.json();
    } catch {
      // Empty body — use sample data
    }

    const { eventsData: bodyEvents, logsMarkdown: bodyLogs, shiftDate } = body;
    const sample = loadSampleData();

    const eventsData = bodyEvents ?? sample.eventsData;
    const logsMarkdown = bodyLogs ?? sample.logsMarkdown;
    const targetShiftDate = shiftDate ?? "2026-05-30";

    logger.info({ targetShiftDate }, "POST /handover called");

    const handover = await runHandoverPipeline({
      eventsData,
      logsMarkdown,
      targetShiftDate,
    });

    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/html")) {
      return c.html(renderHandoverHtml(handover));
    }
    return c.json(handover);
  } catch (err) {
    logger.error({ err }, "POST /handover failed");
    return c.json({ error: String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "3000", 10);

logger.info({ port: PORT }, "Starting Vouch handover service");

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({ port: info.port }, "Server ready");
});

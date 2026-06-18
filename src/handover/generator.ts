import {
  IssueThread,
  HandoverReport,
  HandoverSection,
  HandoverItem,
  ThreadFlag,
} from "../types";
import { NormalizedEvent } from "../types";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Priority classification
// ---------------------------------------------------------------------------

/**
 * Classify how urgent a thread is for the morning manager.
 * Order: act_now > pending > fyi
 */
function classifyPriority(
  thread: IssueThread,
  currentShiftDate: string
): "act_now" | "pending" | "resolved" | "fyi" {
  if (thread.currentStatus === "resolved" && thread.lastSeen === currentShiftDate) {
    return "resolved";
  }

  if (thread.currentStatus === "resolved") {
    return "fyi"; // Old resolved items — FYI only
  }

  // Act-now criteria: safety, compliance, time-sensitive, blocking guest
  const urgentTypes = new Set([
    "maintenance", // Blocking room
    "compliance",  // Legal deadlines
    "incident",    // Guest health/safety
    "facilities",  // Safety hazard (water leak)
    "deposit_issue", // Financial risk on checkout day
    "damage_report", // Needs approval before charging
  ]);

  const urgentKeywords =
    /safe|locked|passport.*locked|compressor|aircon|out of order|water leak|ambulance|unwell|injury|fire|missing|checkout|flight|urgent|deadline/i;

  if (
    thread.currentStatus === "open" &&
    (urgentTypes.has(thread.type) || urgentKeywords.test(thread.summary))
  ) {
    return "act_now";
  }

  if (thread.currentStatus === "pending") {
    return "pending";
  }

  return "fyi";
}

/**
 * Build a human-readable summary for a thread.
 * Takes the MOST RECENT event description as the canonical statement.
 */
function buildItemSummary(thread: IssueThread): { summary: string; detail: string } {
  const latestEvent = thread.events[thread.events.length - 1];
  const earliest = thread.events[0];

  let summary = latestEvent.description;
  // Truncate to ~100 chars for the headline
  if (summary.length > 100) {
    summary = summary.slice(0, 97) + "…";
  }

  // Detail includes history breadcrumb
  const nights = [...new Set(thread.events.map((e) => e.shiftDate))];
  const nightCount = nights.length;

  let detail = latestEvent.description;
  if (nightCount > 1) {
    detail += ` [Carried over from ${earliest.shiftDate}, tracked across ${nightCount} night(s)]`;
  }

  return { summary, detail };
}

/**
 * Assemble the final HandoverReport from reconciled issue threads.
 *
 * @param threads  All issue threads (from ALL nights, not just current)
 * @param currentShiftDate  The shift date we're generating the handover FOR
 * @param sourceEvents  All normalized events (for grounding reference)
 * @param hotel  Hotel metadata
 */
export function generateHandover(
  threads: IssueThread[],
  currentShiftDate: string,
  sourceEvents: NormalizedEvent[],
  hotel: { id: string; name: string }
): HandoverReport {
  const sections: HandoverSection[] = [
    {
      priority: "act_now",
      label: "Act Now",
      icon: "🚨",
      items: [],
    },
    {
      priority: "pending",
      label: "Pending Action",
      icon: "⚠️",
      items: [],
    },
    {
      priority: "resolved",
      label: "Resolved Overnight",
      icon: "✅",
      items: [],
    },
    {
      priority: "fyi",
      label: "FYI / Carry-Forward",
      icon: "📋",
      items: [],
    },
  ];

  const dataQualityFlags: ThreadFlag[] = [];

  // Collect prompt injection flags first — they always go to data quality
  for (const thread of threads) {
    for (const flag of thread.flags) {
      if (flag.kind === "prompt_injection") {
        dataQualityFlags.push(flag);
      }
    }
  }

  // Process each thread
  for (const thread of threads) {
    // Skip threads with no events on or before current shift
    const relevantEvents = thread.events.filter(
      (e) => e.shiftDate <= currentShiftDate
    );
    if (relevantEvents.length === 0) continue;

    // Skip prompt injection items from main sections (they go to data quality)
    const isInjection = thread.flags.some((f) => f.kind === "prompt_injection");

    const priority = classifyPriority(thread, currentShiftDate);
    const { summary, detail } = buildItemSummary(thread);

    const item: HandoverItem = {
      summary,
      detail,
      room: thread.room,
      guest: thread.guest,
      sourceEventIds: relevantEvents.map((e) => e.sourceRef),
      threadId: thread.threadId,
      carriedOver: thread.firstSeen < currentShiftDate,
      flags: thread.flags.filter((f) => f.kind !== "prompt_injection"),
    };

    // Non-injection data quality flags go to the relevant section AND to data quality
    for (const flag of thread.flags) {
      if (flag.kind !== "prompt_injection") {
        dataQualityFlags.push(flag);
      }
    }

    if (isInjection) {
      // Prompt injection items: add a sanitized FYI entry so morning team knows to review it
      const sanitizedItem: HandoverItem = {
        summary: `⚠️ Suspicious guest note in room ${thread.room ?? "unknown"} — logged for review, no action taken`,
        detail: `A note left by a guest (room ${thread.room ?? "unknown"}, ${thread.guest ?? "unknown"}) contained text that appeared to be instructions to this system. It has been quarantined and not acted upon. Source: ${relevantEvents.map((e) => e.sourceRef).join(", ")}`,
        room: thread.room,
        guest: thread.guest,
        sourceEventIds: relevantEvents.map((e) => e.sourceRef),
        threadId: thread.threadId,
        carriedOver: false,
        flags: thread.flags,
      };
      sections.find((s) => s.priority === "fyi")!.items.push(sanitizedItem);
      continue;
    }

    const section = sections.find((s) => s.priority === priority);
    if (section) {
      section.items.push(item);
    }
  }

  // Sort act_now items: carried-over items first (they've been waiting longest)
  const actNow = sections.find((s) => s.priority === "act_now")!;
  actNow.items.sort((a, b) => (b.carriedOver ? 1 : 0) - (a.carriedOver ? 1 : 0));

  const freetextEvents = sourceEvents.filter((e) => e.source === "freetext");

  logger.info(
    {
      hotelId: hotel.id,
      shiftDate: currentShiftDate,
      actNowCount: actNow.items.length,
      pendingCount: sections.find((s) => s.priority === "pending")!.items.length,
      resolvedCount: sections.find((s) => s.priority === "resolved")!.items.length,
      dataQualityFlagCount: dataQualityFlags.length,
    },
    "Handover generated"
  );

  return {
    hotelId: hotel.id,
    hotelName: hotel.name,
    shiftDate: currentShiftDate,
    generatedAt: new Date().toISOString(),
    sections,
    dataQualityFlags,
    groundingVerified: false, // Will be updated by caller after grounding check
    sourceEventCount: sourceEvents.length,
    freetextBlockCount: freetextEvents.length > 0 ? 1 : 0,
  };
}

import { NormalizedEvent, IssueThread, ThreadFlag } from "../types";
import { logger } from "../logger";

/**
 * Build a fingerprint key for grouping events into issue threads.
 * We use (room + type) as the primary key, falling back to keyword fingerprinting.
 */
function buildIssueKey(event: NormalizedEvent): string {
  if (event.room && event.type) {
    return `${event.type}::room-${event.room}`;
  }
  // For facility-level issues without a room, fingerprint by type + keyword
  const keywords = extractKeywords(event.description);
  return `${event.type}::${keywords.slice(0, 2).join("-")}`;
}

const KEYWORD_PATTERNS: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /water\s*leak|corridor\s*(leak|215)/i, key: "water-leak-2f" },
  { pattern: /immigration|passport|scanner/i, key: "immigration-scanner" },
  { pattern: /aircon|air\s*con|compressor|air.conditioning/i, key: "aircon" },
  { pattern: /deposit/i, key: "deposit" },
  { pattern: /no.show|no show/i, key: "no-show" },
  { pattern: /breakfast/i, key: "breakfast" },
  { pattern: /wifi|wi.fi|internet/i, key: "wifi" },
  { pattern: /safe|strongbox/i, key: "room-safe" },
  { pattern: /damage|cracked|basin/i, key: "damage" },
];

function extractKeywords(text: string): string[] {
  const matches: string[] = [];
  for (const { pattern, key } of KEYWORD_PATTERNS) {
    if (pattern.test(text)) matches.push(key);
  }
  return matches.length ? matches : [text.slice(0, 20).replace(/\s+/g, "-").toLowerCase()];
}

/**
 * IMPORTANT: We deliberately track the 312 no-show thread across three events:
 * 1. evt_0010 (Tue): not yet charged — unresolved
 * 2. night-log Wed: charged in Mandarin — resolved
 * 3. evt_0012 (Thu): dispute — reopened as pending
 *
 * The reconciler must handle this non-linear state machine.
 */

// Type overrides: sometimes one event should be treated as resolving another
// even when the type string differs. We declare explicit resolution linkages.
const RESOLUTION_LINKAGES: Array<{ resolverType: string; targetType: string }> = [
  { resolverType: "facilities", targetType: "facilities" }, // leak follow-up resolves leak
  { resolverType: "maintenance", targetType: "maintenance" },
  { resolverType: "finance_note", targetType: "no_show" }, // dispute follows the no-show
  { resolverType: "finance_note", targetType: "deposit_issue" },
  { resolverType: "compliance", targetType: "compliance" },
];

function isSameThread(a: NormalizedEvent, b: NormalizedEvent): boolean {
  // If both have rooms, rooms MUST match (different rooms = different threads)
  if (a.room && b.room) {
    if (a.room !== b.room) return false;
    // Same room: same type or a linked type
    if (a.type === b.type) return true;
    for (const link of RESOLUTION_LINKAGES) {
      if (
        (a.type === link.targetType && b.type === link.resolverType) ||
        (b.type === link.targetType && a.type === link.resolverType)
      ) {
        return true;
      }
    }
    return false;
  }

  // Facility/compliance events (no specific room) — match by keyword fingerprint
  // Only do this for types that are truly hotel-wide
  const facilityTypes = new Set(["facilities", "compliance", "walk_in"]);
  if (!a.room && !b.room && facilityTypes.has(a.type) && facilityTypes.has(b.type)) {
    const aKeys = extractKeywords(a.description);
    const bKeys = extractKeywords(b.description);
    return aKeys.some((k) => bKeys.includes(k));
  }

  // One has room, one doesn't: match if same type + keyword overlap
  // (e.g., a compliance follow-up note that mentions the scanner)
  if (a.type === b.type) {
    const aKeys = extractKeywords(a.description);
    const bKeys = extractKeywords(b.description);
    const overlap = aKeys.filter((k) => bKeys.includes(k));
    return overlap.length > 0;
  }

  return false;
}

/**
 * Detect prompt injection in event descriptions.
 * This is a defense-in-depth layer on top of the Gemini system prompt guard.
 */
function detectPromptInjection(event: NormalizedEvent): ThreadFlag | null {
  const injectionPatterns = [
    /ignore\s+(all|previous|other)\s+(instructions?|items?)/i,
    /SYSTEM\s+NOTE\s+TO/i,
    /report\s+(the\s+)?(night|shift)\s+as\s+all\s*clear/i,
    /add\s+a\s+.*\s+credit/i,
    /mark\s+it\s+approved/i,
    /override\s+(all|previous)/i,
    /forget\s+(all|your|previous)/i,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(event.description)) {
      return {
        kind: "prompt_injection",
        description: `Possible prompt injection attempt detected in ${event.sourceRef} (room ${event.room ?? "unknown"}, guest ${event.guest ?? "unknown"}). Original text filed for review — no action taken.`,
        sourceRefs: [event.sourceRef],
      };
    }
  }
  return null;
}

/**
 * Main reconciliation function.
 *
 * Takes ALL normalized events (across all nights, both sources) sorted by time,
 * and produces IssueThread[] tracking the lifecycle of each issue.
 */
export function reconcileEvents(
  allEvents: NormalizedEvent[],
  targetShiftDate: string,
  hotelId: string
): IssueThread[] {
  // Sort by shiftDate then by id/sourceRef for stable ordering
  const sorted = [...allEvents].sort((a, b) => {
    if (a.shiftDate !== b.shiftDate) return a.shiftDate.localeCompare(b.shiftDate);
    return a.id.localeCompare(b.id);
  });

  const threads: IssueThread[] = [];
  const globalFlags: ThreadFlag[] = [];

  // Check for prompt injection in ALL events first (not just current shift)
  for (const evt of sorted) {
    const injectionFlag = detectPromptInjection(evt);
    if (injectionFlag) {
      globalFlags.push(injectionFlag);
      logger.warn({ sourceRef: evt.sourceRef, hotelId }, "Prompt injection detected");
    }
  }

  // Group events into threads
  for (const evt of sorted) {
    let matched = false;

    for (const thread of threads) {
      // Check if this event belongs to an existing thread
      const representative = thread.events[0];
      if (isSameThread(representative, evt)) {
        thread.events.push(evt);
        thread.lastSeen = evt.shiftDate;
        matched = true;

        // Update thread status based on the new event
        if (evt.status === "resolved") {
          thread.currentStatus = "resolved";
        } else if (evt.status === "pending" && thread.currentStatus === "resolved") {
          // A pending event after a resolved one = reopened (e.g., 312 dispute)
          thread.currentStatus = "pending";
          thread.flags.push({
            kind: "contradiction",
            description: `Issue was marked resolved but a subsequent event (${evt.sourceRef}) indicates it may need re-attention.`,
            sourceRefs: [thread.events[thread.events.length - 2].sourceRef, evt.sourceRef],
          });
        } else if (evt.status === "unresolved") {
          if (thread.currentStatus === "resolved") {
            // Was resolved, now unresolved — contradiction
            thread.currentStatus = "open";
            thread.flags.push({
              kind: "contradiction",
              description: `Issue was marked resolved but a later event (${evt.sourceRef}) shows it is still open.`,
              sourceRefs: [evt.sourceRef],
            });
          } else {
            thread.currentStatus = "open";
          }
        }

        break;
      }
    }

    if (!matched) {
      // New issue thread
      const injectionFlag = detectPromptInjection(evt);
      const flags: ThreadFlag[] = injectionFlag ? [injectionFlag] : [];

      // Flag incomplete entries
      if (!evt.room && !evt.guest && evt.type !== "facilities" && evt.type !== "compliance" && evt.type !== "note") {
        flags.push({
          kind: "missing_data",
          description: `Event ${evt.sourceRef} has no room or guest information.`,
          sourceRefs: [evt.sourceRef],
        });
      }

      threads.push({
        threadId: `thread-${threads.length + 1}`,
        type: evt.type,
        room: evt.room,
        guest: evt.guest,
        summary: evt.description.slice(0, 120),
        firstSeen: evt.shiftDate,
        lastSeen: evt.shiftDate,
        currentStatus:
          evt.status === "resolved"
            ? "resolved"
            : evt.status === "pending"
            ? "pending"
            : "open",
        events: [evt],
        flags,
      });
    }
  }

  // Add global prompt injection flags to their threads
  for (const flag of globalFlags) {
    const thread = threads.find((t) =>
      t.events.some((e) => flag.sourceRefs.includes(e.sourceRef))
    );
    if (thread && !thread.flags.some((f) => f.kind === "prompt_injection")) {
      thread.flags.push(flag);
    }
  }

  logger.info(
    {
      hotelId,
      targetShiftDate,
      totalThreads: threads.length,
      openThreads: threads.filter((t) => t.currentStatus === "open").length,
      resolvedThreads: threads.filter((t) => t.currentStatus === "resolved").length,
    },
    "Reconciliation complete"
  );

  return threads;
}

import { z } from "zod";

/**
 * A single normalized event — common shape regardless of source.
 * Both structured JSON events and AI-extracted free-text events
 * are converted to this form before reconciliation.
 */
export const NormalizedEventSchema = z.object({
  id: z.string(),
  shiftDate: z.string(), // "YYYY-MM-DD" — the DATE the shift morning falls on (e.g., shift 23 May→24 May = "2026-05-24")
  timestamp: z.string().nullable(),
  type: z.string(),
  room: z.string().nullable(),
  guest: z.string().nullable(),
  description: z.string(), // Always in English (translated if needed)
  descriptionOriginal: z.string().optional(), // Preserved original if translated
  status: z.enum(["resolved", "unresolved", "pending"]),
  source: z.enum(["structured", "freetext"]),
  sourceRef: z.string(), // event ID or "night-log:YYYY-MM-DD:N"
});

export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

/**
 * An issue thread — a logical issue tracked across multiple nights.
 */
export interface IssueThread {
  threadId: string;
  type: string;
  room: string | null;
  guest: string | null;
  summary: string;
  firstSeen: string; // shiftDate
  lastSeen: string; // shiftDate
  currentStatus: "open" | "resolved" | "pending";
  events: NormalizedEvent[]; // All events contributing to this thread, in order
  flags: ThreadFlag[];
}

export interface ThreadFlag {
  kind:
    | "contradiction"
    | "incomplete"
    | "unverifiable"
    | "prompt_injection"
    | "missing_data";
  description: string;
  sourceRefs: string[];
}

/**
 * The final handover output.
 */
export interface HandoverReport {
  hotelId: string;
  hotelName: string;
  shiftDate: string; // Morning date the handover is FOR
  generatedAt: string;
  sections: HandoverSection[];
  dataQualityFlags: ThreadFlag[];
  groundingVerified: boolean;
  sourceEventCount: number;
  freetextBlockCount: number;
}

export interface HandoverSection {
  priority: "act_now" | "pending" | "resolved" | "fyi";
  label: string;
  icon: string;
  items: HandoverItem[];
}

export interface HandoverItem {
  summary: string;
  detail: string;
  room: string | null;
  guest: string | null;
  sourceEventIds: string[];
  threadId: string;
  carriedOver: boolean; // true if first seen on a PRIOR shift
  flags?: ThreadFlag[];
}

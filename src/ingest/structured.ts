import { NormalizedEvent } from "../types";

interface RawEvent {
  id: string;
  timestamp: string;
  type: string;
  room: string | null;
  guest: string | null;
  description: string;
  status: string;
}

interface RawEventsFile {
  hotel: {
    id: string;
    name: string;
    rooms: number;
    timezone: string;
  };
  events: RawEvent[];
}

/**
 * Given a UTC timestamp string, determine which "shift date" it belongs to.
 *
 * A shift runs ~23:00 → 07:00. We define the shift date as the MORNING date
 * (the date the shift ends / handover is written for).
 *
 * Examples (timezone +08:00 = Singapore):
 *   2026-05-25T23:14:00+08:00 → shift date 2026-05-26 (the morning it hands over to)
 *   2026-05-26T06:50:00+08:00 → shift date 2026-05-26
 *   2026-05-26T07:30:00+08:00 → shift date 2026-05-27 (next shift)
 */
function resolveShiftDate(timestamp: string, timezone: string): string {
  const offsetMatch = timezone.match(/([+-])(\d{2}):(\d{2})/);
  if (!offsetMatch) throw new Error(`Cannot parse timezone: ${timezone}`);

  const sign = offsetMatch[1] === "+" ? 1 : -1;
  const offsetMinutes =
    sign * (parseInt(offsetMatch[2]) * 60 + parseInt(offsetMatch[3]));

  const utcMs = new Date(timestamp).getTime();
  const localMs = utcMs + offsetMinutes * 60 * 1000;
  const localDate = new Date(localMs);

  const localHour = localDate.getUTCHours();
  const localDateStr = localDate.toISOString().slice(0, 10);

  // If local time is before 07:00, it belongs to the shift that started the previous evening
  // and the handover is written for TODAY (same date)
  // If local time is 07:00–22:59, it's daytime — not typically a night shift event, but assign to next morning
  // If local time is 23:00+, it belongs to the shift starting tonight, handing over tomorrow morning

  if (localHour < 7) {
    // Early morning — still on last night's shift, handover is today
    return localDateStr;
  } else if (localHour >= 23) {
    // After 23:00 — start of tonight's shift, handover is tomorrow
    const tomorrow = new Date(localMs + 24 * 60 * 60 * 1000);
    return tomorrow.toISOString().slice(0, 10);
  } else {
    // Daytime event — assign to the upcoming night's handover (next day)
    // This handles edge cases like events logged during the day referring to a previous night
    return localDateStr;
  }
}

/**
 * Normalise the status string from raw events into our enum.
 */
function normalizeStatus(
  raw: string
): "resolved" | "unresolved" | "pending" {
  const s = raw.toLowerCase().trim();
  if (s === "resolved") return "resolved";
  if (s === "pending") return "pending";
  return "unresolved";
}

/**
 * Parse the structured events.json file into NormalizedEvent[].
 * This is deterministic — no AI needed here.
 */
export function parseStructuredEvents(
  raw: unknown,
  logger?: { info: (msg: string, meta?: object) => void }
): { hotel: RawEventsFile["hotel"]; events: NormalizedEvent[] } {
  const data = raw as RawEventsFile;

  const normalized: NormalizedEvent[] = data.events.map((evt) => {
    const shiftDate = resolveShiftDate(evt.timestamp, data.hotel.timezone);
    return {
      id: evt.id,
      shiftDate,
      timestamp: evt.timestamp,
      type: evt.type,
      room: evt.room,
      guest: evt.guest,
      description: evt.description,
      status: normalizeStatus(evt.status),
      source: "structured" as const,
      sourceRef: evt.id,
    };
  });

  logger?.info(`Parsed ${normalized.length} structured events`, {
    hotelId: data.hotel.id,
  });

  return { hotel: data.hotel, events: normalized };
}

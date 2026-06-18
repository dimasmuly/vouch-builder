import { NormalizedEvent } from "../types";
import { extractEventsFromFreetext } from "../ai/gemini";
import { logger } from "../logger";

interface FreetextBlock {
  shiftDate: string; // "YYYY-MM-DD"
  header: string;
  body: string;
}

/**
 * Parse the night-logs.md file into per-shift blocks.
 * Each ## heading is treated as a new shift.
 *
 * Header format expected: "Night of [day] [date] → morning [day] [date]"
 * e.g. "Night of Wed 27 May → morning Thu 28 May (relief cover — system was down)"
 */
export function parseFreetextBlocks(markdown: string): FreetextBlock[] {
  const blocks: FreetextBlock[] = [];

  // Split on ## headings
  const sections = markdown.split(/^##\s+/m).filter(Boolean);

  for (const section of sections) {
    const lines = section.trim().split("\n");
    const header = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    // Skip if body is too short to be meaningful
    if (body.length < 20) continue;

    // Try to extract the morning date from the header
    // Pattern: "morning [Weekday] [Day] [Month]" e.g. "morning Thu 28 May"
    const morningMatch = header.match(
      /morning\s+\w+\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i
    );

    let shiftDate = "unknown";
    if (morningMatch) {
      const day = morningMatch[1].padStart(2, "0");
      const monthNames: Record<string, string> = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
      };
      const month = monthNames[morningMatch[2].toLowerCase()];
      // Assume current year if not specified — could be made smarter
      const year = new Date().getFullYear();
      shiftDate = `${year}-${month}-${day}`;
    } else {
      logger.warn({ header }, "Could not parse shift date from free-text header");
    }

    blocks.push({ shiftDate, header, body });
  }

  return blocks;
}

/**
 * Convert free-text blocks into NormalizedEvent[] using the AI extraction pipeline.
 */
export async function parseFreetextEvents(
  markdown: string,
  hotelId: string
): Promise<NormalizedEvent[]> {
  const blocks = parseFreetextBlocks(markdown);
  const allEvents: NormalizedEvent[] = [];

  logger.info({ hotelId, blockCount: blocks.length }, "Parsing free-text blocks");

  for (const block of blocks) {
    const extracted = await extractEventsFromFreetext(block.body, block.shiftDate);

    for (let i = 0; i < extracted.length; i++) {
      const ext = extracted[i];
      const sourceRef = `night-log:${block.shiftDate}:${i + 1}`;

      // Build the normalized event
      const event: NormalizedEvent = {
        id: sourceRef,
        shiftDate: block.shiftDate,
        timestamp: null, // Free-text logs rarely have precise timestamps
        type: ext.type,
        room: ext.room ?? null,
        guest: ext.guest ?? null,
        description: ext.description,
        descriptionOriginal: ext.descriptionOriginal ?? undefined,
        status: ext.status,
        source: "freetext",
        sourceRef,
      };

      allEvents.push(event);
    }

    logger.info(
      { hotelId, shiftDate: block.shiftDate, extractedCount: extracted.length },
      "Free-text block processed"
    );
  }

  return allEvents;
}

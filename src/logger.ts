import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

/**
 * Create a child logger scoped to a specific hotel + shift.
 * All log entries from a handover run will carry hotelId and shiftDate,
 * making it trivial to grep for a bad handover in production.
 */
export function handoverLogger(hotelId: string, shiftDate: string) {
  return logger.child({ hotelId, shiftDate });
}

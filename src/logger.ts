import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

// pino-pretty is a devDependency — only use it in development
// In production (Railway/Render), we fall back to JSON logs
let transport: pino.TransportSingleOptions | undefined;
if (!isProd) {
  try {
    require.resolve("pino-pretty");
    transport = { target: "pino-pretty", options: { colorize: true } };
  } catch {
    // pino-pretty not installed — use plain JSON logs
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport,
});

/**
 * Create a child logger scoped to a specific hotel + shift.
 * All log entries from a handover run will carry hotelId and shiftDate,
 * making it trivial to grep for a bad handover in production.
 */
export function handoverLogger(hotelId: string, shiftDate: string) {
  return logger.child({ hotelId, shiftDate });
}

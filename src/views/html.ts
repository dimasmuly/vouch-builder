import { HandoverReport, HandoverItem, HandoverSection } from "../types";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderItem(item: HandoverItem, showCarriedOver: boolean): string {
  const roomBadge = item.room
    ? `<span class="badge badge-room">Room ${escapeHtml(item.room)}</span>`
    : "";
  const guestBadge = item.guest
    ? `<span class="badge badge-guest">${escapeHtml(item.guest)}</span>`
    : "";
  const carriedBadge =
    showCarriedOver && item.carriedOver
      ? `<span class="badge badge-carried">Carried Over</span>`
      : "";

  const flagHtml =
    item.flags && item.flags.length > 0
      ? `<div class="flags">${item.flags
          .map(
            (f) =>
              `<span class="flag flag-${escapeHtml(f.kind)}">⚑ ${escapeHtml(f.description)}</span>`
          )
          .join("")}</div>`
      : "";

  const sourceHtml = `<div class="sources">Sources: ${item.sourceEventIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</div>`;

  return `
    <div class="item">
      <div class="item-header">
        <div class="badges">${roomBadge}${guestBadge}${carriedBadge}</div>
      </div>
      <p class="item-summary">${escapeHtml(item.summary)}</p>
      <p class="item-detail">${escapeHtml(item.detail)}</p>
      ${flagHtml}
      ${sourceHtml}
    </div>`;
}

function renderSection(section: HandoverSection): string {
  if (section.items.length === 0) return "";

  const showCarried = section.priority === "act_now" || section.priority === "pending";

  return `
    <section class="section section-${section.priority}">
      <h2>${section.icon} ${escapeHtml(section.label)} <span class="count">(${section.items.length})</span></h2>
      ${section.items.map((item) => renderItem(item, showCarried)).join("")}
    </section>`;
}

export function renderHandoverHtml(report: HandoverReport): string {
  const sectionHtml = report.sections.map(renderSection).join("");

  const flagsHtml =
    report.dataQualityFlags.length > 0
      ? `
    <section class="section section-flags">
      <h2>🚩 Data Quality Flags <span class="count">(${report.dataQualityFlags.length})</span></h2>
      ${report.dataQualityFlags
        .map(
          (f) => `
        <div class="item flag-item">
          <span class="flag flag-${escapeHtml(f.kind)}">⚑ ${escapeHtml(f.kind.replace("_", " ").toUpperCase())}</span>
          <p>${escapeHtml(f.description)}</p>
          <div class="sources">Sources: ${f.sourceRefs.map((r) => `<code>${escapeHtml(r)}</code>`).join(", ")}</div>
        </div>`
        )
        .join("")}
    </section>`
      : "";

  const groundingBadge = report.groundingVerified
    ? `<span class="grounding-ok">✓ Grounding verified</span>`
    : `<span class="grounding-skip">Grounding check skipped (no AI key)</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Night-Shift Handover — ${escapeHtml(report.hotelName)} — ${escapeHtml(report.shiftDate)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f0f2f5;
      color: #1a1a2e;
      line-height: 1.5;
      padding: 1.5rem;
    }
    .header {
      background: #1a1a2e;
      color: white;
      border-radius: 12px;
      padding: 1.5rem 2rem;
      margin-bottom: 1.5rem;
    }
    .header h1 { font-size: 1.4rem; font-weight: 700; }
    .header .meta { font-size: 0.85rem; opacity: 0.7; margin-top: 0.25rem; }
    .grounding-ok { color: #4ade80; font-size: 0.8rem; }
    .grounding-skip { color: #facc15; font-size: 0.8rem; }

    .section { background: white; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1rem; }
    .section h2 { font-size: 1.05rem; font-weight: 700; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid currentColor; }
    .count { font-size: 0.85rem; font-weight: 400; opacity: 0.6; }

    .section-act_now h2 { color: #dc2626; border-color: #dc2626; }
    .section-pending h2 { color: #d97706; border-color: #d97706; }
    .section-resolved h2 { color: #16a34a; border-color: #16a34a; }
    .section-fyi h2 { color: #6366f1; border-color: #6366f1; }
    .section-flags h2 { color: #7c3aed; border-color: #7c3aed; }

    .item { border-left: 3px solid #e5e7eb; padding-left: 1rem; margin-bottom: 1rem; }
    .item:last-child { margin-bottom: 0; }
    .section-act_now .item { border-color: #fca5a5; }
    .section-pending .item { border-color: #fcd34d; }
    .section-resolved .item { border-color: #86efac; }

    .item-header { margin-bottom: 0.4rem; }
    .badges { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .badge {
      font-size: 0.72rem;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .badge-room { background: #dbeafe; color: #1d4ed8; }
    .badge-guest { background: #f3e8ff; color: #7c3aed; }
    .badge-carried { background: #fef3c7; color: #b45309; }

    .item-summary { font-weight: 600; font-size: 0.95rem; margin-bottom: 0.25rem; }
    .item-detail { font-size: 0.85rem; color: #4b5563; margin-bottom: 0.4rem; }

    .flags { margin-top: 0.4rem; display: flex; flex-direction: column; gap: 0.25rem; }
    .flag { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; }
    .flag-contradiction { background: #fee2e2; color: #991b1b; }
    .flag-incomplete { background: #fef3c7; color: #92400e; }
    .flag-unverifiable { background: #e0e7ff; color: #3730a3; }
    .flag-prompt_injection { background: #fce7f3; color: #9d174d; font-weight: 700; }
    .flag-missing_data { background: #f1f5f9; color: #475569; }

    .sources { margin-top: 0.4rem; font-size: 0.72rem; color: #9ca3af; }
    .sources code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; }

    .flag-item p { font-size: 0.85rem; color: #4b5563; margin: 0.3rem 0; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Night-Shift Handover — ${escapeHtml(report.hotelName)}</h1>
    <div class="meta">
      Morning of ${escapeHtml(report.shiftDate)} &nbsp;·&nbsp;
      Generated ${new Date(report.generatedAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })} SGT &nbsp;·&nbsp;
      ${report.sourceEventCount} events ingested &nbsp;·&nbsp;
      ${groundingBadge}
    </div>
  </div>

  ${sectionHtml}
  ${flagsHtml}
</body>
</html>`;
}

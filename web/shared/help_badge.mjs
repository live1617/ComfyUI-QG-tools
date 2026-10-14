// The title-bar "?" badge: pure geometry and help-card content assembly.
// Drawing and click wiring live in js/appearance/index.js; this stays
// testable under node:test.

export const BADGE_RADIUS = 7;
export const BADGE_MARGIN = 16; // badge center this far left of the node edge
export const MIN_WIDTH_FOR_BADGE = 140;
const TITLE_CENTER_Y = -15; // half of LiteGraph's 30px title bar

// Badge center in node-local coordinates (title bar is negative y).
export function badgeCenter(nodeWidth) {
  return [nodeWidth - BADGE_MARGIN, TITLE_CENTER_Y];
}

export function showBadge(nodeWidth, collapsed) {
  return !collapsed && nodeWidth >= MIN_WIDTH_FOR_BADGE;
}

// Generous hit zone: larger than the drawn glyph, per the pack's etiquette.
export function hitsBadge(pos, nodeWidth) {
  const [cx, cy] = badgeCenter(nodeWidth);
  return (
    pos[0] >= cx - 10 && pos[0] <= cx + 10 &&
    pos[1] >= cy - 11 && pos[1] <= cy + 11
  );
}

function inputItems(inputSpec) {
  const items = [];
  for (const group of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(inputSpec?.[group] ?? {})) {
      const options = Array.isArray(spec) ? spec[1] : undefined;
      const detail = options && typeof options === "object" ? options.tooltip : undefined;
      items.push({ term: name, detail: detail || undefined });
    }
  }
  return items;
}

// Sections for the help card, straight from the node's registered schema —
// the same DESCRIPTION and tooltips the backend declares.
export function helpSections(nodeData) {
  const sections = [];
  if (nodeData?.description) sections.push({ text: nodeData.description });
  const inputs = inputItems(nodeData?.input);
  if (inputs.length) sections.push({ heading: "Inputs", items: inputs });
  const names = nodeData?.output_name ?? [];
  const tooltips = nodeData?.output_tooltips ?? [];
  const outputs = names.map((name, index) => ({
    term: name,
    detail: tooltips[index] || undefined,
  }));
  if (outputs.length) sections.push({ heading: "Outputs", items: outputs });
  return sections;
}

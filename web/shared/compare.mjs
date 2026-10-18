// Pure decision logic for the QG image-compare panel. No DOM in here — the
// wiring lives in web/image_compare/index.js so this module stays testable.
//
// Ported from ComfyUI-AusBoss (MIT, js/shared/compare.mjs).

// "toggle" keeps its legacy name even though the button now reads A / B:
// a workflow saved with it must still open on the side it was left on.
export const COMPARE_MODES = ["slide", "toggle", "erase"];

// "hold" was the press-and-hold mode that toggle replaced. Mapping it keeps a
// workflow saved with it on the button it became, instead of quietly dropping
// back to slide - the panel would still work, but not the way it was left.
const LEGACY_MODES = { hold: "toggle" };

export function normalizeCompareMode(value) {
  const mapped = LEGACY_MODES[value] ?? value;
  return COMPARE_MODES.includes(mapped) ? mapped : COMPARE_MODES[0];
}

// The caption under the stage: the compared resolution, or "" when nothing
// has been loaded yet. Both sides are normally the same size, so A speaks for
// the pair; when they differ, both are named rather than one quietly winning.
export function compareSizeLabel(refs) {
  const a = refs?.a;
  const b = refs?.b;
  if (!(a?.width > 0) || !(a?.height > 0)) return "";
  if (b?.width > 0 && b?.height > 0 && (b.width !== a.width || b.height !== a.height)) {
    return `A ${a.width}×${a.height} · B ${b.width}×${b.height}`;
  }
  return `${a.width}×${a.height}`;
}

// Fraction of the panel width covered by the pointer, clamped to 0..1.
// Degenerate rectangles and non-finite input resolve to 0 (no left overlay).
export function clipFraction(pointerX, rectLeft, rectWidth) {
  const width = Number(rectWidth);
  if (!Number.isFinite(width) || width <= 0) return 0;
  const fraction = (Number(pointerX) - Number(rectLeft)) / width;
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(1, fraction));
}

// Give both edges a forgiving 6% landing zone. Leaving through any side
// settles to the nearest full image instead of stranding a partial split.
export function slideFraction(pointerX, rectLeft, rectWidth, leaving = false) {
  const fraction = clipFraction(pointerX, rectLeft, rectWidth);
  if (leaving) return fraction < 0.5 ? 0 : 1;
  if (fraction <= 0.06) return 0;
  if (fraction >= 0.94) return 1;
  return fraction;
}

// CSS for a given reveal fraction: the overlay keeps its left portion up to the
// seam, the rest is clipped away. The seam only shows while both images are
// partially visible.
//
// A picture that is wholly covered is not drawn (showA, showB), and a
// picture shown whole has no clip. The browser draws a picture on whole
// pixels but cuts a clip where it falls, so on a stage whose width is not a
// whole number the clipped A ended up to a pixel short of B, and B showed as
// a line down the right edge of A.
export function compareClip(fraction) {
  const value = Number(fraction);
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return {
    clipPath: clamped >= 1 ? "none" : `inset(0 ${((1 - clamped) * 100).toFixed(2)}% 0 0)`,
    seamLeft: `${(clamped * 100).toFixed(2)}%`,
    seamVisible: clamped > 0 && clamped < 1,
    showA: clamped > 0,
    showB: clamped < 1,
  };
}

// Pull the two preview references out of an onExecuted payload. Both must
// be present for the panel to have anything meaningful to show.
//
// `pair` 是这轮运行那两张图在服务端的键，橡皮擦保存时回传它（所以浏览器
// 从不指名要读哪个文件）；`name` 是运行从 filename 输入拿到的保存名。
export function findCompareImages(message) {
  const a = message?.a_images?.[0] ?? null;
  const b = message?.b_images?.[0] ?? null;
  const pair = typeof message?.pair?.[0] === "string" ? message.pair[0] : null;
  const name = typeof message?.save_name?.[0] === "string" ? message.save_name[0] : "";
  return a?.filename && b?.filename ? { a, b, pair, name } : null;
}

// Where the mode switch stands for a mode and a locked side.
export function compareSwitchValue(mode, showingB) {
  if (mode === "toggle") return showingB ? "b" : "a";
  if (mode === "erase") return "erase";
  return "slide";
}

// Where the A and B labels sit: each on its own side of the split line, so
// they move with it; one label, centred, while only one picture shows. A
// side too narrow for its label drops the label rather than covering the
// line. Pixel offsets from the stage's left edge, or null for no label.
export function compareBadges(fraction, stageWidth, badgeWidth = 22, gap = 5) {
  const width = Number(stageWidth);
  const value = Number(fraction);
  if (!Number.isFinite(width) || width <= 0) return { a: null, b: null };
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const centred = Math.round((width - badgeWidth) / 2);
  if (clamped <= 0) return { a: null, b: centred };
  if (clamped >= 1) return { a: centred, b: null };
  const seam = clamped * width;
  const a = Math.round(seam - gap - badgeWidth);
  const b = Math.round(seam + gap);
  return { a: a >= 4 ? a : null, b: b + badgeWidth <= width - 4 ? b : null };
}

// Is `target` somewhere upstream of `start`? `feeds(id)` lists the ids of
// the nodes wired into node `id`.
function isUpstream(target, start, feeds) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const id of feeds(queue.pop()) ?? []) {
      if (id == null || seen.has(id)) continue;
      if (id === target) return true;
      seen.add(id);
      queue.push(id);
    }
  }
  return false;
}

// Which input holds the result, the picture the panel rests on. B is the
// "after" picture by convention. When B's picture feeds the node that makes
// A, they are wired the other way round and the result is A.
//
// `a` and `b` say where the two pictures come from: { id, slot } of the node
// and output wired to each input. `graph` reads the links: feeds(id) lists
// the ids of the nodes wired into node `id`, and inside(id) opens a
// subgraph: the same two calls for the graph in it, plus output(slot),
// where that output comes from in there.
export function compareResultSide(a, b, graph) {
  // Both pictures out of one subgraph: the answer is inside it.
  for (let depth = 0; a && b && a.id === b.id && depth < 16; depth += 1) {
    const inner = graph.inside?.(a.id);
    if (!inner) return "B";
    [a, b, graph] = [inner.output(a.slot), inner.output(b.slot), inner];
  }
  if (!a || !b || a.id === b.id) return "B";
  return isUpstream(b.id, a.id, graph.feeds) ? "A" : "B";
}

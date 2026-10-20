import { app } from "/scripts/app.js";
import {
  CUSTOM_SCHEME,
  DEFAULT_SCHEME,
  NODE_COLOR_SCHEMES,
  SCHEME_NAMES,
  collectGraphNodes,
  normalizeHexColor,
  schemeColors,
  shouldRecolor,
  titleInk,
  wearsLegacyScheme,
} from "../shared/appearance.mjs?v=2026102002";
import { chainCallback, chainHandler, isQgNode } from "../shared/index.mjs?v=2026102002";
import {
  BADGE_RADIUS,
  badgeCenter,
  helpSections,
  hitsBadge,
  showBadge,
} from "../shared/help_badge.mjs?v=2026102002";
import { openInfoCard } from "../shared/settings_menu.mjs?v=2026102002";
import { zh, zhOn, zhReady } from "../shared/zh.mjs?v=2026102002";

const SETTING_ID = "QG.Appearance.NodeColor";
const CUSTOM_SETTING_ID = "QG.Appearance.CustomColor";

// Stored bare (no "#") to match the color setting's storage contract.
// Defaults to the flagship QG-tools title color, so switching the scheme to
// Custom starts from the familiar deep slate-teal.
const DEFAULT_CUSTOM_COLOR = "14424d";

// Every scheme title color (already lowercase in the table) — a node wearing
// one of these was colored by us, whether by the setting or the node menu.
const SCHEME_TITLES = new Set(
  NODE_COLOR_SCHEMES.flatMap((scheme) => (scheme.colors ? [scheme.colors.title] : [])),
);

let activeScheme = DEFAULT_SCHEME;
let activeCustomColor = DEFAULT_CUSTOM_COLOR;
// Normalized "#rrggbb" of the custom title (null when unusable), kept in
// step with activeCustomColor so the per-frame title-ink check stays cheap.
let activeCustomTitle = normalizeHexColor(DEFAULT_CUSTOM_COLOR);

function setActiveCustomColor(value) {
  activeCustomColor = value;
  activeCustomTitle = normalizeHexColor(value);
}

function applyScheme(node, colors) {
  // Assigning undefined (never `delete`) keeps the property reactive under
  // the Vue-based Nodes 2.0 renderer while still restoring theme defaults.
  node.color = colors ? colors.title : undefined;
  node.bgcolor = colors ? colors.body : undefined;
}

// Repaint every QG node still following the setting from one color
// pair to another; pairs (not names) so a CustomColor edit can sweep too.
function repaintAll(next, previous) {
  for (const node of collectGraphNodes(app.graph)) {
    if (!isQgNode(node)) continue;
    if (!shouldRecolor(node, previous)) continue;
    applyScheme(node, next);
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

// The menu's "recolor every QG node": ignore the follow-the-setting rule and
// sweep the active scheme over all of them, subgraphs included. Nodes wearing
// a stray color from another pack or an old session (which would otherwise be
// protected as a manual pick) get unified in one click. Theme default clears.
function repaintEveryQgNode() {
  const colors = schemeColors(activeScheme, activeCustomColor);
  for (const node of collectGraphNodes(app.graph)) {
    if (!isQgNode(node)) continue;
    applyScheme(node, colors);
  }
  app.graph?.setDirtyCanvas?.(true, true);
}

// Scheme titles are dark pigments, so the frontend's default title ink can
// land unreadably close. Wrapping drawTitleText is the sanctioned exception
// to the chainCallback rule: a draw method must return through the original,
// so we save it once, delegate always, and only swap the default color in.
// Nodes 2.0 renders titles in the DOM, not through drawTitleText — out of scope.
function installTitleInk() {
  const proto = window.LiteGraph?.LGraphNode?.prototype;
  if (typeof proto?.drawTitleText !== "function") {
    console.warn("[QG-tools] LGraphNode.drawTitleText not found; adaptive title ink disabled");
    return;
  }
  if (proto.drawTitleText.qgTitleInk) return; // already wrapped
  const original = proto.drawTitleText;
  function drawTitleTextWithInk(ctx, options, ...rest) {
    const color = typeof this?.color === "string" ? this.color.trim().toLowerCase() : "";
    if (
      options &&
      isQgNode(this) &&
      (SCHEME_TITLES.has(color) || (activeCustomTitle !== null && color === activeCustomTitle))
    ) {
      options = { ...options, default_title_color: titleInk(color) };
    }
    return original.call(this, ctx, options, ...rest);
  }
  drawTitleTextWithInk.qgTitleInk = true;
  proto.drawTitleText = drawTitleTextWithInk;
}

app.registerExtension({
  name: "QG.Appearance",
  settings: [
    {
      id: SETTING_ID,
      name: "QG node color",
      type: "combo",
      defaultValue: DEFAULT_SCHEME,
      options: SCHEME_NAMES,
      tooltip:
        "Color scheme applied to every QG node's title bar and body. " +
        "Changing it recolors the open workflow immediately; nodes you have " +
        "colored by hand keep their own colors. Custom uses the color picked " +
        "in the Custom color setting.",
      category: ["QG-tools", "Appearance", "Node color"],
      onChange(value) {
        const previous = activeScheme;
        activeScheme = value ?? DEFAULT_SCHEME;
        if (previous === activeScheme) return;
        const colors = schemeColors(activeScheme, activeCustomColor);
        // Custom with an unusable stored color resolves to null, which reads
        // downstream as "Theme default" and would strip the color off every
        // QG node in the graph. The per-node menu already refuses this;
        // the setting has to refuse it too.
        if (activeScheme === CUSTOM_SCHEME && !colors) return;
        repaintAll(colors, schemeColors(previous, activeCustomColor));
      },
    },
    {
      id: CUSTOM_SETTING_ID,
      name: "QG custom color",
      type: "color",
      defaultValue: DEFAULT_CUSTOM_COLOR,
      tooltip:
        "Title-bar color used when QG node color is set to Custom; the " +
        "body color is derived automatically by muting the pick toward the " +
        "dark canvas. Editing it while Custom is active recolors the open " +
        "workflow immediately.",
      category: ["QG-tools", "Appearance", "Custom color"],
      onChange(value) {
        const previous = activeCustomColor;
        setActiveCustomColor(value);
        if (activeScheme !== CUSTOM_SCHEME) return;
        const next = schemeColors(CUSTOM_SCHEME, activeCustomColor);
        const before = schemeColors(CUSTOM_SCHEME, previous);
        if (next && next.title !== before?.title) repaintAll(next, before);
      },
    },
  ],
  async setup() {
    // onChange only fires on later edits, so seed from the stored values here.
    const stored = app.ui?.settings?.getSettingValue?.(SETTING_ID);
    if (SCHEME_NAMES.includes(stored)) activeScheme = stored;
    const storedCustom = app.ui?.settings?.getSettingValue?.(CUSTOM_SETTING_ID);
    if (normalizeHexColor(storedCustom)) setActiveCustomColor(storedCustom);
    installTitleInk();
    // Nodes created before the zh dictionary settled keep English menu text;
    // LiteGraph menus rebuild on every open, but sweep once anyway in case
    // any consumer cached the item list.
    zhReady().then(() => {
      if (zhOn()) app.graph?.setDirtyCanvas?.(false, true);
    });
  },
  getNodeMenuItems(node) {
    if (!isQgNode(node)) return [];
    // Menus are rebuilt on every open, so zh() resolves live; the dictionary
    // is warm long before a user first right-clicks a node.
    // A title-less node has no bar for the "?" badge; its card opens here.
    const about = isTitleless(node)
      ? [{ content: zh("About this node"), callback: () => openHelpCard(node, null) }]
      : [];
    return [
      ...about,
      {
        content: zh("QG color"),
        has_submenu: true,
        submenu: {
          options: [
            ...SCHEME_NAMES.map((name) => ({
              content: zh(name),
              callback: () => {
                // A menu pick writes the colors directly; shouldRecolor then
                // treats them as the user's choice during setting sweeps.
                const colors = schemeColors(name, activeCustomColor);
                // Custom with an unusable stored color resolves to null, which
                // would wrongly read as "Theme default" — do nothing instead.
                if (name === CUSTOM_SCHEME && !colors) return;
                applyScheme(node, colors);
                app.graph?.setDirtyCanvas?.(true, true);
              },
            })),
            {
              // Pack-wide sweep at the bottom of the scheme list: one click
              // unifies nodes wearing a stray color from another pack or an
              // old session, which the per-node picks would leave alone.
              content: zh("Recolor every QG node"),
              callback: () => repaintEveryQgNode(),
            },
          ],
        },
      },
    ];
  },
  nodeCreated(node) {
    if (!isQgNode(node)) return;
    installHelpBadge(node);
    // Colors restored from a saved workflow (and manual picks) land before
    // this hook runs — an already-colored node is left alone, unless it
    // wears a retired flagship pair: those colors were ours, so the node
    // upgrades to the active scheme instead of keeping them forever.
    if ((node.color || node.bgcolor) && !wearsLegacyScheme(node)) return;
    const colors = schemeColors(activeScheme, activeCustomColor);
    if (colors) applyScheme(node, colors);
  },
});

function isTitleless(node) {
  return node.constructor?.title_mode === (globalThis.LiteGraph?.NO_TITLE ?? 1);
}

function openHelpCard(node, event) {
  const nodeData = node.constructor?.nodeData;
  const clientX = event?.clientX ?? window.innerWidth / 2;
  const clientY = event?.clientY ?? 80;
  // Everything here is assembled at composition time, so it goes through zh()
  // (help_badge.mjs stays a pure, testable module). The card hangs off <body>
  // and its text is written once — the zh plugin's per-node DOM pass never
  // sees it, so leaving any of it bare leaves it English.
  const sections = helpSections(nodeData).map((section) => ({
    ...section,
    ...(section.heading ? { heading: zh(section.heading) } : {}),
    ...(section.text ? { text: zh(section.text) } : {}),
    ...(section.items
      ? {
          items: section.items.map((item) => ({
            term: zh(item.term),
            detail: item.detail ? zh(item.detail) : item.detail,
          })),
        }
      : {}),
  }));
  openInfoCard({
    anchor: { left: clientX - 150, top: clientY, bottom: clientY + 6 },
    title: node.title || zh(nodeData?.display_name) || "About this node",
    sections,
  });
}

// Every QG node gets a quiet "?" in the title bar; clicking it opens a
// card built from the node's own DESCRIPTION and tooltips, so the docs on
// screen are exactly the docs in the source.
function installHelpBadge(node) {
  // A title-less node (Run Timer) has no bar to hang the badge on; its
  // card opens from the node's context menu instead.
  if (isTitleless(node)) return;
  chainCallback(node, "onDrawForeground", function (ctx) {
    if (!showBadge(this.size?.[0] ?? 0, this.flags?.collapsed)) return;
    const [x, y] = badgeCenter(this.size[0]);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, BADGE_RADIUS, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(155,162,170,0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(155,162,170,0.8)";
    ctx.font = "bold 9px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", x, y + 0.5);
    ctx.restore();
  });
  chainHandler(node, "onMouseDown", function (event, pos) {
    if (!showBadge(this.size?.[0] ?? 0, this.flags?.collapsed)) return false;
    if (!pos || !hitsBadge(pos, this.size[0])) return false;
    openHelpCard(this, event);
    return true; // consume the click so it does not start a drag
  });
}

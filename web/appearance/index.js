import { app } from "/scripts/app.js";
import {
  CUSTOM_SCHEME,
  DEFAULT_SCHEME,
  NODE_COLOR_SCHEMES,
  SCHEME_NAMES,
  accentFor,
  accentHover,
  accentInk,
  collectGraphNodes,
  normalizeHexColor,
  schemeColors,
  shouldRecolor,
  titleInk,
  wearsLegacyScheme,
} from "../shared/appearance.mjs?v=202611251300";
import { chainCallback, chainHandler, isQgNode } from "../shared/index.mjs?v=202611251300";
import {
  BADGE_RADIUS,
  badgeCenter,
  helpSections,
  hitsBadge,
  showBadge,
} from "../shared/help_badge.mjs?v=202611251300";
import { mountHelpBadge, unmountHelpBadge } from "../shared/help_badge_dom.mjs?v=202611251300";
import { closeSettingsMenu, openInfoCard } from "../shared/settings_menu.mjs?v=202611251300";
import { zh, zhOn, zhReady, wantsChinese } from "../shared/zh.mjs?v=202611251300";
import { ZH_NODE_DEFS } from "../shared/zh_node_defs.mjs?v=202611251300";

const SETTING_ID = "QG.Appearance.NodeColor";
const CUSTOM_SETTING_ID = "QG.Appearance.CustomColor";
const CUSTOM_ACCENT_SETTING_ID = "QG.Appearance.CustomAccent";
const CUSTOM_GUIDE_SETTING_ID = "QG.Appearance.CustomGuide";
const ACCENT_COLOR_SETTING_ID = "QG.Appearance.AccentColor";
const GUIDE_COLOR_SETTING_ID = "QG.Appearance.GuideColor";
// 数值滑条轨道 + LoRA 强度条共用的一支自定义色（独立于强调色，用户 11-24 要）。
const SLIDER_COLOR_SETTING_ID = "QG.Appearance.SliderColor";
const CUSTOM_SLIDER_SETTING_ID = "QG.Appearance.CustomSlider";
// 鼠标悬停节点标题栏时弹不弹那一段节点说明（长文本）。只关**标题栏**这一条：
// 槽位与控件的提示也受前端 Comfy.EnableTooltips 管，翻那个总开关会把它们一并
// 关掉（用户明确只要标题栏），所以这里改走「清 QG 节点标题栏的 title 属性」，
// 经典画布再由 nodeCreated 里的 getTooltip 兜一层。
const HOVER_TIP_SETTING_ID = "QG.Appearance.HoverTooltip";

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
// "Use my own accent": paint every panel highlight with the custom accent
// color below, whatever the node scheme is. Ships off — user 2026-11-24 wants
// the three Appearance switches all default off; highlights follow the node
// scheme until the user opts in. The default pick below is still the QG-tools
// scheme's own accent, so turning it on changes nothing visually at first.
let activeCustomAccent = false;
// The canvas alignment guides get a switch and a picker of their own — the
// highlight and the guides are two different visual jobs, and a workflow may
// want one but not the other. Ships off: the guides follow the node scheme,
// which is the behaviour the guides had before this pair of settings existed.
let activeCustomGuide = false;
// The two pickers behind those switches. Defaults: the pack teal for the
// panels (the same color QG-tools scheme uses) and the orange the guides wore
// before they started following the scheme.
let activeAccentColor = "00b4aa";
let activeGuideColor = "fb923c";
// 滑条/强度条色默认品牌青，和当前写死的颜色一致 —— 不设新设置也不变样。
let activeSliderColor = "00b4aa";
// 关掉自定义滑条色时跟随节点配色方案的主题色（用户 11-24 要）。默认关。
let activeCustomSlider = false;
// 悬停标题栏是否显示节点说明。11-24 用户要求三个外观开关默认全关，故默认关。
let hoverTipEnabled = false;
let tipObserver = null;
let qgDescHeads = null;

// Vue 渲染的节点定义在 Pinia 的 nodeDef store 里。标题栏那颗气泡读的是
// nodeDefsByName[type].description，而槽/控件的提示读各自 tooltip —— 所以只把
// 这段 description 生成的气泡藏掉，就只关标题栏（不碰 Comfy.EnableTooltips）。
// 🔴 description 是**只读**属性：直接赋值会被静默忽略（实测读回来还是原文），
// 所以只能从渲染层下手。
function nodeDefStore() {
  try {
    const pinia = document.querySelector("#vue-app")?.__vue_app__
      ?.config?.globalProperties?.$pinia;
    return pinia?._s?.get?.("nodeDef") ?? null;
  } catch {
    return null;
  }
}

// QG 各节点说明的开头（本地化后的原文）。用开头比对，容忍气泡里的换行/省略。
function qgDescriptionHeads() {
  const map = nodeDefStore()?.nodeDefsByName;
  if (!map) return null;
  const heads = [];
  for (const [name, def] of Object.entries(map)) {
    if (!name.startsWith("QG_")) continue;
    const text = String(def?.description || "").trim();
    if (text.length >= 8) heads.push(text.slice(0, 32));
  }
  return heads.length ? heads : null;
}

function hideQgDescriptionBubble(el) {
  if (hoverTipEnabled || !(el instanceof HTMLElement)) return;
  // 带 z-overlay 的是气泡外框，文本在它里面的 div 上；两处都要能接住。
  const bubble = el.classList.contains("z-overlay")
    ? el
    : el.closest?.('[class*="z-overlay"]');
  if (!bubble) return;
  const text = (bubble.textContent || "").trim();
  if (text.length < 8) return;
  if (!qgDescHeads) qgDescHeads = qgDescriptionHeads();
  if (!qgDescHeads) return;
  if (qgDescHeads.some((head) => text.startsWith(head))) bubble.style.display = "none";
}

function ensureTipObserver() {
  if (hoverTipEnabled) {
    tipObserver?.disconnect();
    tipObserver = null;
    return;
  }
  qgDescHeads = qgDescriptionHeads();
  if (tipObserver) return;
  tipObserver = new MutationObserver((records) => {
    for (const rec of records) {
      const target = rec.target instanceof HTMLElement ? rec.target : rec.target?.parentElement;
      const open = target?.closest?.('[class*="z-overlay"]');
      if (open) hideQgDescriptionBubble(open);
      for (const node of rec.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        hideQgDescriptionBubble(node);
        node.querySelectorAll?.('[class*="z-overlay"]').forEach(hideQgDescriptionBubble);
      }
    }
  });
  tipObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.querySelectorAll('[class*="z-overlay"]').forEach(hideQgDescriptionBubble);
}

function applyHoverTip(value) {
  hoverTipEnabled = value !== false;
  ensureTipObserver();
  app.graph?.setDirtyCanvas?.(false, true);
}

// 经典画布：LiteGraph 悬停时调 node.getTooltip()。关掉时返回空串，标题栏的
// 节点说明就不再弹；槽位提示不走这里，照旧显示。
function patchNodeTooltip(node) {
  if (!node || node.__qgTipPatched) return;
  node.__qgTipPatched = true;
  const original = node.getTooltip;
  node.getTooltip = function patchedGetTooltip(...args) {
    if (!hoverTipEnabled) return "";
    return typeof original === "function" ? original.apply(this, args) : "";
  };
}
// Normalized "#rrggbb" of the custom title (null when unusable), kept in
// step with activeCustomColor so the per-frame title-ink check stays cheap.
let activeCustomTitle = normalizeHexColor(DEFAULT_CUSTOM_COLOR);

function setActiveCustomColor(value) {
  activeCustomColor = value;
  activeCustomTitle = normalizeHexColor(value);
}

// The accent the panels paint their chosen states in (a switch's off | on, a
// segmented setting, a focused field, the picker's checkbox). It follows the
// node color scheme, so a Plum workflow does not light up in pack teal.
//
// Written as CSS variables on the root once, not per node: every panel rule
// reads var(--qg-accent), so a scheme change repaints every open card on the
// next frame without rebuilding anything.
const ACCENT_VARS = ["--qg-accent", "--qg-accent-hover", "--qg-on-accent"];

// The translucent companion shades: outlines and washes need the accent at a
// fixed alpha, and CSS cannot put an alpha on a hex var without color-mix
// (which older Electron builds lack). Packed here instead.
function accentRgba(accent, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(accent ?? "").trim());
  if (!match) return `rgba(0, 180, 170, ${alpha})`;
  const rgb = parseInt(match[1], 16);
  return `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, ${alpha})`;
}

function applyAccent() {
  const root = document.documentElement;
  // The fallback both switches drop back to: the scheme's own accent (which
  // for the Custom scheme is derived from the custom title color).
  const schemeAccent = accentFor(activeScheme, activeCustomColor);
  // An open switch means "use the picker color exactly as picked" — no
  // lightness lifting, unlike the Custom scheme's derived accent. A stored
  // value that is not hex falls back to the scheme so the panels never go blank.
  const accent = (activeCustomAccent && normalizeHexColor(activeAccentColor)) || schemeAccent;
  root.style.setProperty(ACCENT_VARS[0], accent);
  root.style.setProperty(ACCENT_VARS[1], accentHover(accent));
  root.style.setProperty(ACCENT_VARS[2], accentInk(accent));
  root.style.setProperty("--qg-accent-soft", accentRgba(accent, 0.55));
  root.style.setProperty("--qg-accent-fade", accentRgba(accent, 0.16));
  // The canvas guides (snaplines) are drawn on a 2D context, so they cannot
  // inherit a CSS variable on their own: they read this one and cache it, and
  // this event is what invalidates that cache when either switch changes. It is
  // a variable of its own because the guide has its own switch and picker.
  const guide = (activeCustomGuide && normalizeHexColor(activeGuideColor)) || schemeAccent;
  root.style.setProperty("--qg-guide", guide);
  // 数值滑条轨道 + LoRA 强度条共用色：开关关时跟随节点配色方案的主题色，
  // 开时才用下面那支独立取色器。fill/cap 是半透明/提亮版，强度条 gradient 直接用。
  const slider = (activeCustomSlider && normalizeHexColor(activeSliderColor)) || schemeAccent;
  root.style.setProperty("--qg-slider", slider);
  root.style.setProperty("--qg-slider-fill", accentRgba(slider, 0.28));
  root.style.setProperty("--qg-slider-cap", accentRgba(accentHover(slider), 0.9));
  window.dispatchEvent(new CustomEvent("qg-accent-changed", { detail: { accent, guide, slider } }));
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

// 2026-11-24 用户截图：设置面板里 QG-tools 那几行只有间距、没有分隔，开关
// 和紧跟着的颜色项容易看串行。原生面板的每行是 .setting-item[data-setting-id]，
// 用 ID 精确命中本扩展的 9 行加一条淡下边线 —— 只碰自己的行，不动别的扩展。
const SETTING_DIVIDER_CSS_ID = "qgtools-appearance-setting-divider";
function installSettingDividers() {
  if (document.getElementById(SETTING_DIVIDER_CSS_ID)) return;
  const ids = [
    SETTING_ID, CUSTOM_SETTING_ID, CUSTOM_ACCENT_SETTING_ID, CUSTOM_GUIDE_SETTING_ID,
    ACCENT_COLOR_SETTING_ID, GUIDE_COLOR_SETTING_ID,
    SLIDER_COLOR_SETTING_ID, CUSTOM_SLIDER_SETTING_ID, HOVER_TIP_SETTING_ID,
  ];
  const selectors = ids.map((id) => `.setting-item[data-setting-id="${id}"]`).join(",\n");
  const style = document.createElement("style");
  style.id = SETTING_DIVIDER_CSS_ID;
  // 半透明中性灰：深/浅主题都能看见又不抢眼；清除浮动让线贴着整行底缘。
  style.textContent = `${selectors} {
  border-bottom: 1px solid rgba(128, 128, 128, .25);
  padding-bottom: 8px;
}`;
  document.head.append(style);
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
        "in the QG custom node color setting.",
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
        applyAccent();
        repaintAll(colors, schemeColors(previous, activeCustomColor));
      },
    },
    {
      id: CUSTOM_SETTING_ID,
      name: "QG custom node color",
      type: "color",
      defaultValue: DEFAULT_CUSTOM_COLOR,
      tooltip:
        "Title-bar color used when QG node color is set to Custom; the " +
        "body color is derived automatically by muting the pick toward the " +
        "dark canvas. Editing it while Custom is active recolors the open " +
        "workflow immediately.",
      category: ["QG-tools", "Appearance", "Custom node color"],
      onChange(value) {
        const previous = activeCustomColor;
        setActiveCustomColor(value);
        if (activeScheme !== CUSTOM_SCHEME) return;
        if (activeScheme === CUSTOM_SCHEME) applyAccent();
        const next = schemeColors(CUSTOM_SCHEME, activeCustomColor);
        const before = schemeColors(CUSTOM_SCHEME, previous);
        if (next && next.title !== before?.title) repaintAll(next, before);
      },
    },
    {
      // Registered before its switch on purpose: the settings panel lists the
      // rows of a category in reverse registration order, so this lands right
      // under "Use custom accent" — switch on top, the picker it drives below.
      id: ACCENT_COLOR_SETTING_ID,
      name: "QG custom accent color",
      type: "color",
      defaultValue: "00b4aa",
      tooltip:
        "The color the QG panels' highlights (off | on, Done, segmented picks, " +
        "focused fields) are painted with while Use custom accent is on. Picked " +
        "as-is — a very dark color makes the highlight hard to read.",
      category: ["QG-tools", "Appearance", "Custom accent color"],
      onChange(value) {
        activeAccentColor = value;
        if (activeCustomAccent) applyAccent();
      },
    },
    {
      id: CUSTOM_ACCENT_SETTING_ID,
      name: "Use custom accent",
      type: "boolean",
      // 默认关（用户 2026-11-24 要求三个外观开关默认全关）：高亮跟随节点配色
      // 方案；要自己调色再打开。调色盘默认仍是 QG-tools 方案的 #00b4aa。
      defaultValue: false,
      tooltip:
        "Paint the QG panels' highlights with the QG custom accent color above, " +
        "instead of the one that comes with the node color scheme. Off: the " +
        "highlights follow the scheme.",
      category: ["QG-tools", "Appearance", "Use custom accent"],
      onChange(value) {
        activeCustomAccent = !!value;
        applyAccent();
      },
    },
    {
      id: GUIDE_COLOR_SETTING_ID,
      name: "QG custom guide color",
      type: "color",
      defaultValue: "fb923c",
      tooltip:
        "The color the canvas alignment guides (the lines that appear while " +
        "dragging or resizing nodes) are drawn in while Use custom guide color " +
        "is on. Picked as-is — a very dark color is hard to see on the canvas.",
      category: ["QG-tools", "Appearance", "Custom guide color"],
      onChange(value) {
        activeGuideColor = value;
        if (activeCustomGuide) applyAccent();
      },
    },
    {
      id: CUSTOM_GUIDE_SETTING_ID,
      name: "Use custom guide color",
      type: "boolean",
      defaultValue: false,
      tooltip:
        "Draw the canvas alignment guides in the QG custom guide color above. " +
        "Off: the guides follow the node color scheme. This switch is independent " +
        "of the custom accent one.",
      category: ["QG-tools", "Appearance", "Use custom guide color"],
      onChange(value) {
        activeCustomGuide = !!value;
        applyAccent();
      },
    },
    {
      // 数值滑条 + LoRA 强度条共用的一支颜色，独立于强调色。
      id: SLIDER_COLOR_SETTING_ID,
      name: "QG slider color",
      type: "color",
      defaultValue: "00b4aa",
      tooltip:
        "The color shared by QG number sliders (their filled track) and the " +
        "LoRA strength bars. Independent of the custom accent color. Picked " +
        "as-is — a very dark color makes the bars hard to read.",
      category: ["QG-tools", "Appearance", "Slider color"],
      onChange(value) {
        activeSliderColor = value;
        if (activeCustomSlider) applyAccent();
      },
    },
    {
      // 注册在颜色项之后：面板按倒序列，开关就显示在颜色项上方。
      id: CUSTOM_SLIDER_SETTING_ID,
      name: "Use custom slider color",
      type: "boolean",
      // 默认关（用户 11-24）：滑条与强度条跟随节点配色方案主题色。
      defaultValue: false,
      tooltip:
        "Paint the QG number slider tracks and LoRA strength bars with the QG " +
        "slider color above. Off: they follow the node color scheme's accent, " +
        "just like the other QG highlights. Independent of the custom accent switch.",
      category: ["QG-tools", "Appearance", "Use custom slider color"],
      onChange(value) {
        activeCustomSlider = !!value;
        applyAccent();
      },
    },
    {
      id: HOVER_TIP_SETTING_ID,
      name: "Hover tooltip on node title",
      type: "boolean",
      // 默认关（用户 2026-11-24 要求三个外观开关默认全关）：开箱就不弹标题栏气泡。
      defaultValue: false,
      tooltip:
        "Hide the node-description bubble that pops up when the pointer rests " +
        "on a QG node's title bar. Slot and widget tooltips are left alone and " +
        "still show normally.",
      category: ["QG-tools", "Appearance", "Hover tooltip"],
      onChange(value) {
        applyHoverTip(!!value);
      },
    },
  ],
  async setup() {
    // onChange only fires on later edits, so seed from the stored values here.
    const stored = app.ui?.settings?.getSettingValue?.(SETTING_ID);
    if (SCHEME_NAMES.includes(stored)) activeScheme = stored;
    const storedCustom = app.ui?.settings?.getSettingValue?.(CUSTOM_SETTING_ID);
    if (normalizeHexColor(storedCustom)) setActiveCustomColor(storedCustom);
    activeCustomAccent = app.ui?.settings?.getSettingValue?.(CUSTOM_ACCENT_SETTING_ID) === true;
    activeCustomGuide = app.ui?.settings?.getSettingValue?.(CUSTOM_GUIDE_SETTING_ID) === true;
    // 调色盘：存的是不带 # 的 hex（见 DEFAULT_CUSTOM_COLOR 的注释），
    // 原样收下，applyAccent 里统一 normalize。
    const storedAccent = app.ui?.settings?.getSettingValue?.(ACCENT_COLOR_SETTING_ID);
    if (storedAccent) activeAccentColor = storedAccent;
    const storedGuide = app.ui?.settings?.getSettingValue?.(GUIDE_COLOR_SETTING_ID);
    if (storedGuide) activeGuideColor = storedGuide;
    activeCustomSlider = app.ui?.settings?.getSettingValue?.(CUSTOM_SLIDER_SETTING_ID) === true;
    const storedSlider = app.ui?.settings?.getSettingValue?.(SLIDER_COLOR_SETTING_ID);
    if (storedSlider) activeSliderColor = storedSlider;
    // 悬停提示：读自己的存储值；关着就直接开始扫（Vue 标题栏可能还没渲染完，
    // 轮询会在它出现后把 title 摘掉）。
    hoverTipEnabled = app.ui?.settings?.getSettingValue?.(HOVER_TIP_SETTING_ID) === true;
    if (!hoverTipEnabled) applyHoverTip(false);
    applyAccent();
    installTitleInk();
    installSettingDividers();
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
    // 经典画布：悬停标题栏那段节点说明由 getTooltip 给，包一层好让它跟随开关。
    patchNodeTooltip(node);
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
  // 帮助卡正文取自后端 schema（一律英文），中文只存在于 locales/zh/nodeDefs.json。
  // 中文界面下把那份表传进去，卡片才整张中文；英文界面传 null 保持英文。
  // zh() 那层保留：它查的是汉化插件的 ui 字典，能翻掉标题之类零散词条，
  // 查不到就原样返回，不会把已经中文的内容弄坏。
  const sections = helpSections(nodeData, wantsChinese() ? ZH_NODE_DEFS : null).map((section) => ({
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
  const handle = openInfoCard({
    anchor: { left: clientX - 150, top: clientY, bottom: clientY + 6 },
    title: node.title || zh(nodeData?.display_name) || "About this node",
    sections,
  });
  // 记一笔「最上面这张是帮助卡」：DOM 徽章再点一次要靠它判断该不该收起来。
  const pops = document.querySelectorAll(".qgtools-set-pop");
  const pop = pops[pops.length - 1];
  if (pop) pop.__qgHelpCard = true;
  return handle;
}

// 点第二下收起卡片。DOM 徽章带着 data-qgtools-menu-toggle，帮助卡的
// 「点别处关闭」会放过它，所以这里必须自己判断 —— 否则表现成「点了没反应，
// 只是关了又开一次」。
function toggleHelpCard(node, event) {
  const pops = document.querySelectorAll(".qgtools-set-pop");
  const top = pops[pops.length - 1];
  if (top?.__qgHelpCard) {
    closeSettingsMenu();
    return null;
  }
  return openHelpCard(node, event);
}

// Every QG node gets a quiet "?" in the title bar; clicking it opens a
// card built from the node's own DESCRIPTION and tooltips, so the docs on
// screen are exactly the docs in the source.
function installHelpBadge(node) {
  // A title-less node (Run Timer) has no bar to hang the badge on; its
  // card opens from the node's context menu instead.
  if (isTitleless(node)) return;
  // Classic canvas: drawn in onDrawForeground, clicks caught in onMouseDown.
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
  // Nodes 2.0: neither hook above ever fires — the canvas is not drawing the
  // node any more. Same badge, re-hung as a real button in the DOM title bar
  // (the module decides per render mode; classic simply never mounts it).
  mountHelpBadge(node, {
    label: zh("About this node"),
    onOpen: (event) => toggleHelpCard(node, event),
  });
  chainCallback(node, "onRemoved", () => unmountHelpBadge(node));
}

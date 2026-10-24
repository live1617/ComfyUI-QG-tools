import { api } from "/scripts/api.js";
import { app } from "/scripts/app.js";
import { BRAND, chainCallback, keepDomWidgetWidthAuto, notifyQgChange, showToast, zh, zhOn, zhCount, zhSep, zhEnd } from "../shared/index.mjs?v=2026102420";
import { WIDGET_FRAME, fillNodeHeight, holdVueNodeMinWidth } from "../shared/panel_layout.mjs?v=2026102420";
import { hideInputsInDef, hideWidget as collapseWidget } from "../shared/widget_visibility.mjs?v=2026102420";
import {
  closeSettingsMenu,
  gearIconSvg,
  loadSettings,
  openSettingsMenu,
} from "../shared/settings_menu.mjs?v=2026102420";
import { makeScrubInput } from "../shared/scrub_input.mjs?v=2026102420";
import { isAppShortcut, keepKeyInField } from "../shared/canvas_passthrough.mjs?v=2026102420";
import { resetUnknownValues } from "../shared/widget_card_math.mjs?v=2026102420";
import { boxRowInputs, boxRowsWidget, boxesOf, hostBox, rowsInputName, workflowNodes } from "../shared/lora_box.mjs?v=2026102420";
import { fitNodeToPanelHeight, pinPanelToNodeHeight, unwatchVueShell, watchVueShell } from "../shared/vue_panel_fit.mjs?v=2026102420";
import { SETTINGS_PROPERTY, releaseStackRow, stackRowOwners } from "../shared/workflow_switches.mjs?v=2026102420";
import {
  BYPASS_MODE,
  DEFAULT_STEP,
  FINE_STEP,
  MAX_ROWS,
  MUTE_MODE,
  STRENGTH_MAX,
  STRENGTH_MIN,
  clampHighlight,
  commonFolderPrefix,
  filterLoras,
  fitLoraLabel,
  formatFileSize,
  groupByFolder,
  highlightedName,
  hoverRowIndex,
  applyTemplate,
  cycleMasterToggle,
  duplicateLoraKeys,
  importSummary,
  isScrubbing,
  loaderLoraEntries,
  collectUpstreamLoaders,
  collectDownstreamLoaders,
  absorbChainIssue,
  mergeImportedRows,
  moveHighlight,
  moveRow,
  newRow,
  parseRows,
  parseTemplates,
  pickerWidth,
  removeTemplate,
  reorderRows,
  roundStrength,
  resolveLoraName,
  scrubValue,
  serializeRows,
  setStrength,
  shortLoraName,
  snapshotEnabled,
  strengthBarBackground,
  strengthBarScale,
  thumbPosition,
  strengthOutOfRange,
  summarizeRows,
  templateFromRows,
  toggleAllState,
  toggleTrigger,
  upsertTemplate,
  appendFolderRows,
  hasTrigger,
  loraFolders,
  loraPickerEntries,
  loraStackKeyAction,
} from "../shared/lora_stack.mjs?v=2026102420";
import { civitaiButtonLabel, civitaiByHashUrl, parseCivitaiBody } from "../shared/civitai_lookup.mjs?v=2026102420";

const NODE_CLASS = "QG_LoraLoader";
// A workflow saved by a 1.x release holds the panel's own empty value where
// on_missing now sits (saved values come back by position); it loads as
// "error", the node's default and what an API prompt without it runs with.
const RESET_UNKNOWN = { on_missing: "error" };
const ROW_HEIGHT = 30;
const ROW_GAP = 6;
const ACTIONS_HEIGHT = 26;
const GROUP_HEIGHT = 36;
const STACK_PADDING = 8;
const BLANK_HEIGHT = 44;
const PANEL_PADDING = 10;
// How many of the slot band's pixels the panel climbs back up into. Three output slots reserve 66px of node height before the first
// widget, and the band's whole middle is empty - so the control bar rides
// there (like Pixaroma's controls do) and the row stack starts at the
// band's bottom edge. 52 puts the 36px bar at y 24..60, clear of the title
// and flush with the band.
const BAND_RECLAIM = 52;
// The one line that says where an inner loader's rows are set (see
// rowsSource), and the Workflow Switches node that can own a row.
const NOTE_HEIGHT = 16;
const SWITCHES_CLASS = "QG_WorkflowSwitches";

// Per-node-type preferences behind the gear button; persisted in
// localStorage so they follow the user across workflows.
const SETTINGS_SCOPE = "lora_loader";
const SETTINGS_SCHEMA = [
  {
    key: "default_strength", label: "Default strength", type: "number",
    default: 1, min: -10, max: 10, scrub: true, step: 0.05, fineStep: 0.01, decimals: 2,
    hint: "Strength a newly added LoRA starts at.",
  },
  {
    key: "step", label: "Strength step", type: "number",
    default: 0.05, min: 0.01, max: 1, scrub: true, step: 0.01, fineStep: 0.01, decimals: 2,
    hint: "Scrub and arrow-key step. Shift always steps by 0.01.",
  },
  {
    // persist:false - this mirrors THE OPEN NODE's linked state, so it must
    // never become the stored default: new nodes always start unified. (An
    // absorb can flip a node whose imported rows patch model and CLIP
    // differently; that flip stays on that node.)
    key: "separate_strengths", label: "Separate model / CLIP strength",
    type: "toggle", default: false, persist: false,
    hint: "Two strength boxes per row on this node. New nodes always start "
      + "unified.",
  },
  {
    key: "strength_bars", label: "Strength bars", type: "toggle",
    default: true,
    hint: "Center-zero bar behind each name: teal grows right for positive "
      + "strength, red grows left for negative, scaled so the stack's "
      + "largest magnitude spans the field (never less than 1.0).",
  },
  {
    key: "separator", label: "Trigger word separator", type: "text",
    default: ", ", placeholder: '", "',
    hint: "Joins the triggers output. This node now, new nodes later.",
  },
  {
    key: "strict_missing", label: "Stop on missing LoRA", type: "toggle",
    default: true,
    hint: "On (the default): fail the run before sampling when an enabled row's "
      + "file cannot be found, with an error naming it. Off: skip that row with "
      + "a console warning and render without it. This node now, new nodes later.",
  },
  {
    key: "hide_extension", label: "Hide file extension", type: "toggle",
    default: true,
    hint: "Show LoRA names without .safetensors.",
  },
  {
    key: "hide_folders", label: "Hide folder names", type: "toggle",
    default: true,
    hint: "Rows show just the file name; the full path stays in the "
      + "tooltip and the picker keeps its folders.",
  },
  {
    key: "civitai_lookup", label: "Civitai lookup button", type: "toggle",
    default: true,
    hint: "Offer a Fetch Civitai info button in the info card. Clicking it "
      + "asks civitai.com about that one file, from this browser, and saves "
      + "the answer next to the LoRA. Nothing is sent until you click.",
  },
  {
    key: "name_cut", label: "Long names", type: "choice",
    options: ["end", "middle"], default: "end",
    hint: "How a row shortens a name that does not fit. middle keeps the "
      + "end in view, where checkpoint numbers like _000004000 usually are.",
  },
  {
    key: "name_scrub", label: "Scrub strength on the name", type: "toggle",
    default: true,
    hint: "Drag left/right on a row's name to change its model strength - "
      + "the bar rides along. A plain click still opens the picker.",
  },
  {
    key: "thumbnails", label: "Preview thumbnails", type: "toggle",
    default: true,
    hint: "Poster image beside the picker while hovering a LoRA.",
  },
];
// Narrowest node at which a row still works: toggle + picker + strength +
// info + gaps + padding. Enforced through the DOM widget's layout minimum,
// so the node cannot be resized to where the fixed-width row controls would
// hang past the right edge. Separate model / CLIP strengths put a second
// strength box and its gap on every row, so that mode's floor is wider by
// as much, and the name keeps the same room.
const PANEL_MIN_WIDTH = 320;
const SEPARATE_EXTRA_WIDTH = 72;
// The popups' font, shared with the picker's width measurement, and the
// picker's side paddings, from which an option's text width is worked out.
const POP_FONT = "12px system-ui";
const LIST_PAD_X = 4;
const OPTION_PAD_X = 8;

function installStyles() {
  if (document.getElementById("qgtools-lora-styles")) return;
  const style = document.createElement("style");
  style.id = "qgtools-lora-styles";
  style.textContent = `
  .qgtools-lora-panel, .qgtools-lora-panel *,
  .qgtools-lora-pop, .qgtools-lora-pop *,
  .qgtools-lora-hoverthumb { box-sizing: border-box; }
  .qgtools-lora-panel { width: 100%; height: 100%;
    font: 12px system-ui; color: #d7dde2; pointer-events: none; }
  /* 🔴 Nodes 2.0（Vue 渲染）：mountCard 会给桌面节点的面板写一行内联
     height: calc(100% + 52px)，那是让面板往上探进经典画布的输出槽带（见
     BAND_RECLAIM）。Vue 里槽行是独立的一行 DOM，用不着上探 —— 留着这 52px，
     面板就比布局分配给它的高度高出整整 52px，整个节点被顶高（实测 56px：
     52 + 边框）。所以外壳内改回 100%，内联样式要 !important 才盖得住。 */
  .lg-node .qgtools-lora-panel { height: 100% !important; }
  /* The body is the panel's layout box: it fences every child and carries
     the overflow clip. height: 100% tracks whatever box the frontend
     allocates, so a short allocation shrinks the stack instead of
     chopping its bottom border. */
  /* pointer-events: the panel overlays the slot band's middle (see
     BAND_RECLAIM), so everything down to the body passes clicks through to
     the canvas - slot dots stay wirable, empty band areas still drag the
     node - and the three real surfaces opt back in below. The wrapper rule
     needs !important because the frontend writes pointer-events: auto
     inline on its own wrapper each frame; pointer-events does not inherit,
     so the interactive children stay clickable regardless. */
  .dom-widget:has(> .qgtools-lora-panel) { pointer-events: none !important; }
  .qgtools-lora-body { display: flex; flex-direction: column; gap: ${ROW_GAP}px;
    box-sizing: border-box; width: 100%; height: 100%; padding: ${PANEL_PADDING}px;
    overflow: hidden; pointer-events: none; }
  .qgtools-lora-bargroup, .qgtools-lora-stack,
  .qgtools-lora-actions { pointer-events: auto; }
  .qgtools-lora-row { flex: none; display: flex; align-items: center; gap: 6px; height: ${ROW_HEIGHT}px; }
  .qgtools-lora-row:focus-visible { outline: 2px solid ${BRAND}; outline-offset: 1px; border-radius: 4px; }
  /* An off row dims its controls, not itself: the row's own opacity would
     dim the focus outline with them. A dragged row is dimmed as one piece. */
  .qgtools-lora-row.off > * { opacity: 0.45; }
  .qgtools-lora-row.dragging { opacity: 0.55; }
  .qgtools-lora-row.dragging > * { opacity: 1; }
  .qgtools-lora-grip { width: 14px; height: 24px; border: none; background: transparent;
    color: #5c646c; cursor: grab; flex: none; padding: 0; display: grid; place-items: center;
    touch-action: none; }
  .qgtools-lora-grip:hover { color: #9ba2aa; }
  .qgtools-lora-row.dragging .qgtools-lora-grip { cursor: grabbing; }
  /* A row a Workflow Switches switch sets: a lock in the grip's place, and a
     thin line down its left edge. Clicking the lock takes the row over. */
  .qgtools-lora-grip.locked { color: #8fdcd4; cursor: pointer; }
  .qgtools-lora-grip.locked:hover { color: #c4f1ec; }
  .qgtools-lora-row.owned { box-shadow: inset 2px 0 0 ${BRAND}; }
  /* Where an inner loader's rows are set when its box holds them. */
  .qgtools-lora-onbox { flex: none; height: ${NOTE_HEIGHT}px; line-height: ${NOTE_HEIGHT}px;
    text-align: center; color: #8fb9b4; font: 11px system-ui; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; pointer-events: auto; }
  .qgtools-lora-panel.readonly .qgtools-lora-bargroup,
  .qgtools-lora-panel.readonly .qgtools-lora-stack { pointer-events: none; opacity: .55; }
  .qgtools-lora-toggle { width: 30px; height: 16px; border-radius: 8px; border: none;
    background: #3a4047; cursor: pointer; position: relative; flex: none; padding: 0; }
  .qgtools-lora-toggle::after { content: ""; position: absolute; top: 2px; left: 2px;
    width: 12px; height: 12px; border-radius: 50%; background: #9ba2aa; transition: left .12s; }
  .qgtools-lora-toggle.on { background: ${BRAND}; }
  .qgtools-lora-toggle.on::after { left: 16px; background: #fff; }
  .qgtools-lora-toggle.mixed { background: #4d6763; }
  .qgtools-lora-toggle.mixed::after { left: 9px; background: #cfd6da; }
  /* Inside the stack container, pinned to its bottom edge: the auto margin
     soaks up whatever free height the stack was handed. */
  .qgtools-lora-actions { flex: none; display: flex; height: ${ACTIONS_HEIGHT}px;
    margin-top: auto; }
  /* The control bar is the panel's first row, sitting directly on top of
     the stack; the bordered group inside it holds the controls as one
     centered cluster. */
  .qgtools-lora-bar { flex: none; display: flex; justify-content: center; }
  /* The group stretches toward the panel width but stops short of the slot
     labels it rides between (see BAND_RECLAIM); the summary flexes in the
     middle so the controls spread instead of huddling. */
  .qgtools-lora-bargroup { display: flex; align-items: center;
    gap: 8px; min-width: 0; flex: 1 1 auto;
    max-width: min(440px, calc(100% - 116px)); height: ${GROUP_HEIGHT}px; padding: 0 10px;
    border: 1px solid #3a4047; border-radius: 7px; background: rgba(255,255,255,.05);
    color: #9ba2aa; }
  .qgtools-lora-gear { width: 24px; height: 24px; border: 1px solid #3a4047;
    border-radius: 5px; background: #23272c; color: #9ba2aa; cursor: pointer;
    display: grid; place-items: center; flex: none; padding: 0; }
  .qgtools-lora-gear:hover { border-color: ${BRAND}; color: ${BRAND}; }
  .qgtools-lora-stack { flex: 1 1 auto; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column; gap: ${ROW_GAP}px;
    padding: ${STACK_PADDING}px; border: 1px solid rgba(0,180,170,.22); border-radius: 6px;
    background: rgba(0,0,0,.38); }
  .qgtools-lora-blank { flex: 1 1 auto; display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: ${BLANK_HEIGHT}px; border: 1px dashed #3a4047;
    border-radius: 5px; background: transparent; color: #9ba2aa; font: italic 12px system-ui;
    text-align: center; padding: 0 10px; cursor: pointer; }
  .qgtools-lora-blank:hover { border-color: ${BRAND}; color: ${BRAND}; }
  .qgtools-lora-strength.out-of-range { color: #ffb26b; }
  .qgtools-lora-strengthbox.out-of-range { border-color: #7a5230; }
  .qgtools-lora-folder { padding: 6px 8px 2px; color: #9ba2aa; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.04em; }
  .qgtools-lora-folder-option, .qgtools-lora-folder { display: flex; align-items: center;
    gap: 6px; font-weight: 600; padding-top: 2px; padding-bottom: 2px; }
  .qgtools-lora-folder { padding-right: ${OPTION_PAD_X}px; color: #9ba2aa; }
  .qgtools-lora-folder-option .qgtools-lora-label, .qgtools-lora-folder .qgtools-lora-label {
    flex: 1 1 auto; min-width: 0; }
  .qgtools-lora-folder-toggle { flex: none; width: 24px; height: 24px; display: grid;
    place-items: center; padding: 0; border: none; border-radius: 4px; background: transparent;
    color: #9ba2aa; cursor: pointer; }
  .qgtools-lora-folder-toggle:hover { background: #3a4047; color: ${BRAND}; }
  .qgtools-lora-folder-toggle:focus-visible { outline: 2px solid #9becf5; outline-offset: -2px; }
  .qgtools-lora-folder-toggle[aria-expanded="false"] svg { transform: rotate(-90deg); }
  .qgtools-lora-folder-count { flex: none; color: #9ba2aa; font-size: 11px; }
  .qgtools-lora-picker-note { padding: 0 10px 8px; color: #9ba2aa; font-size: 11px; }
  .qgtools-lora-hoverthumb { position: fixed; z-index: 10001; max-width: 180px;
    max-height: 180px; border-radius: 6px; border: 1px solid #3a4047;
    box-shadow: 0 8px 28px rgba(0,0,0,.5); pointer-events: none; background: #1c1f23; }
  .qgtools-lora-range { display: flex; align-items: center; gap: 6px; }
  .qgtools-lora-name { flex: 1 1 auto; min-width: 0; height: 24px; border: 1px solid #3a4047;
    border-radius: 5px; background: #23272c; color: inherit; text-align: left; padding: 0 8px;
    cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    touch-action: none; }
  .qgtools-lora-name:hover { border-color: ${BRAND}; }
  .qgtools-lora-name.missing { color: #ff8a80; }
  .qgtools-lora-name.moved { border-style: dashed; border-color: #3c6663; }
  .qgtools-lora-name.dup { border-color: #f0a11e;
    box-shadow: inset 0 0 0 1px rgba(240,161,30,.4); }
  .qgtools-lora-name.empty { color: #9ba2aa; font-style: italic; }
  /* A name's text is fitted to this box by fitLabels (middle ellipsis);
     the end ellipsis here only covers a box that has not been fitted. */
  .qgtools-lora-label { display: block; overflow: hidden; text-overflow: ellipsis;
    white-space: pre; }
  .qgtools-lora-dir { opacity: .6; }
  .qgtools-lora-strengthbox { display: flex; width: 66px; height: 24px; border: 1px solid #3a4047;
    border-radius: 5px; background: #23272c; overflow: hidden; flex: none; }
  .qgtools-lora-strengthbox:focus-within { border-color: ${BRAND}; }
  .qgtools-lora-strength { flex: 1 1 auto; min-width: 0; height: 100%; border: none; padding: 0;
    background: transparent; color: inherit; text-align: center; cursor: ew-resize;
    user-select: none; }
  .qgtools-lora-strength:focus { cursor: text; outline: none; user-select: text; }
  .qgtools-lora-step { flex: none; width: 14px; display: flex; flex-direction: column;
    border-left: 1px solid #3a4047; }
  .qgtools-lora-step button { flex: 1 1 0; border: none; background: transparent; color: #9ba2aa;
    cursor: pointer; padding: 0; display: grid; place-items: center; }
  .qgtools-lora-step button:hover { color: ${BRAND}; background: rgba(255,255,255,.05); }
  .qgtools-lora-info { width: 24px; height: 24px; border: 1px solid #3a4047; border-radius: 5px;
    background: #23272c; color: #9ba2aa; cursor: pointer; flex: none;
    font: 700 11px system-ui; }
  .qgtools-lora-info:hover { border-color: ${BRAND}; color: ${BRAND}; }
  .qgtools-lora-add { flex: none; height: ${ACTIONS_HEIGHT}px; border: 1px solid ${BRAND};
    border-radius: 6px; background: ${BRAND}; color: #06211f; font: 600 12px system-ui;
    cursor: pointer; padding: 0 12px; white-space: nowrap; box-shadow: 0 1px 0 rgba(0,0,0,.35); }
  .qgtools-lora-add:hover { background: #00c9be; border-color: #00c9be; }
  .qgtools-lora-add:active { transform: translateY(1px); box-shadow: none; }
  .qgtools-lora-add:focus-visible { outline: 2px solid #9becf5; outline-offset: 1px; }
  .qgtools-lora-add:disabled { opacity: 0.4; cursor: default; }
  .qgtools-lora-actions .qgtools-lora-add { flex: 1 1 auto; }
  .qgtools-lora-summary { color: #9ba2aa; flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .qgtools-lora-pop { position: fixed; z-index: 10000; background: #1c1f23;
    border: 1px solid #3a4047; border-radius: 7px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
    font: ${POP_FONT}; color: #d7dde2; display: flex; flex-direction: column; }
  .qgtools-lora-search { margin: 8px; height: 26px; border: 1px solid #3a4047; border-radius: 5px;
    background: #23272c; color: inherit; padding: 0 8px; outline: none; }
  .qgtools-lora-search:focus { border-color: ${BRAND}; }
  .qgtools-lora-list { overflow-y: auto; max-height: 48vh; padding: 0 ${LIST_PAD_X}px 6px;
    scrollbar-gutter: stable; }
  .qgtools-lora-option { padding: 5px ${OPTION_PAD_X}px; border-radius: 4px; cursor: pointer;
    overflow: hidden; }
  .qgtools-lora-option.highlight, .qgtools-lora-folder-option:hover { background: #2c3238; }
  .qgtools-lora-option.current { color: ${BRAND}; }
  .qgtools-lora-empty { padding: 10px; color: #9ba2aa; font-style: italic; }
  .qgtools-lora-menu { min-width: 140px; padding: 4px; }
  /* Direct children only - those are the plain list rows. Buttons that sit
     inside a wrapper row (Save, apply, delete) are specialized and keep their
     own look; as a blanket descendant rule this outranked them and forced
     width:100%, which clipped the Save button and stretched the delete x. */
  .qgtools-lora-menu > button { display: block; width: 100%; text-align: left; border: none;
    background: transparent; color: inherit; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
  .qgtools-lora-menu > button:hover:not(:disabled) { background: #2c3238; }
  .qgtools-lora-menu button:disabled { opacity: 0.35; cursor: default; }
  .qgtools-lora-menu > button.qgtools-lora-danger { color: #ff8585;
    border-top: 1px solid #574047; margin-top: 6px; padding-top: 8px; }
  .qgtools-lora-templates { min-width: 240px; padding: 8px; gap: 6px; display: flex;
    flex-direction: column; }
  .qgtools-lora-template-row { display: flex; align-items: center; gap: 4px; }
  .qgtools-lora-template-row > button:first-child { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; text-align: left; border: none;
    background: transparent; color: inherit; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
  .qgtools-lora-template-row > button:first-child:hover { background: #2c3238; }
  .qgtools-lora-template-x { flex: none; width: 22px; height: 22px; border: none; border-radius: 4px;
    background: transparent; color: #9ba2aa; cursor: pointer; font-size: 14px; line-height: 1; }
  .qgtools-lora-template-x:hover { background: #2c3238; color: #ff8a80; }
  .qgtools-lora-card { width: 300px; padding: 10px; gap: 8px; }
  .qgtools-lora-card img { max-width: 100%; max-height: 180px; object-fit: contain;
    border-radius: 5px; align-self: center; }
  .qgtools-lora-card h4 { margin: 0; font-size: 12px; color: #fff; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .qgtools-lora-meta { color: #9ba2aa; }
  .qgtools-lora-civitai-link { color: ${BRAND}; text-decoration: none; align-self: flex-start; }
  .qgtools-lora-civitai-link:hover { text-decoration: underline; }
  .qgtools-lora-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .qgtools-lora-chip { border: 1px solid #3a4047; border-radius: 10px; background: #23272c;
    color: inherit; cursor: pointer; padding: 2px 8px; font-size: 11px; }
  .qgtools-lora-chip.active { border-color: ${BRAND}; color: ${BRAND}; }
  .qgtools-lora-fetch { align-self: flex-start; }
  .qgtools-lora-custom { display: flex; gap: 6px; align-items: center; }
  .qgtools-lora-custom input { flex: 1 1 auto; min-width: 0; height: ${ACTIONS_HEIGHT}px;
    border: 1px solid #3a4047; box-sizing: border-box;
    border-radius: 5px; background: #23272c; color: inherit; padding: 0 8px; outline: none; }
  .qgtools-lora-custom input:focus { border-color: ${BRAND}; }
  `;
  document.head.append(style);
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// ---------- long names ----------

// Names are cut in the middle, not at the end (fitLoraLabel in
// lora_stack.mjs): the end of a LoRA file name is what tells its
// checkpoints apart. A label keeps its whole text in data, so it can be
// refitted whenever its box changes width.
let measureContext = null;

function measureCanvas() {
  measureContext ??= document.createElement("canvas").getContext("2d");
  return measureContext;
}

// Widths are cached for the batch: labels in one folder share every
// shortened-folder candidate, so a long picker measures each only once.
function textMeasure(element) {
  const context = measureCanvas();
  if (!context) return null;
  const style = getComputedStyle(element);
  context.font = style.font
    || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const widths = new Map();
  return (text) => {
    let width = widths.get(text);
    if (width === undefined) {
      width = context.measureText(text).width;
      widths.set(text, width);
    }
    return width;
  };
}

function showLabel(label, { folder, name }) {
  label.textContent = "";
  if (folder) label.append(el("span", "qgtools-lora-dir", folder));
  label.append(name);
}

// Plain text until fitLabels lays it out (it runs before the next paint).
function nameLabel(text) {
  const label = el("span", "qgtools-lora-label", text);
  label.dataset.qgFull = text;
  return label;
}

// Every label in the list shares one font, so one measure serves them all.
// Widths are all read before any text is written: interleaving the two
// would lay the list out again for every label. A caller that already
// knows the labels' width passes it and no layout is read at all. A box
// that is not laid out yet (width 0) is left for its resize observer.
function fitLabels(labels, knownWidth) {
  const list = [...labels];
  if (!list.length) return;
  const measure = textMeasure(list[0]);
  if (!measure) return;
  const widths = list.map((label) => knownWidth ?? label.clientWidth);
  list.forEach((label, index) => {
    if (widths[index] > 0) {
      showLabel(label, fitLoraLabel(label.dataset.qgFull ?? "", widths[index] - 1, measure));
    }
  });
}


// Six-dot drag grip, hand-drawn like the shared gear so no glyph font is
// trusted to have it.
function gripIconSvg() {
  const dots = [2, 7, 12].flatMap((y) => [2, 6].map((x) => `<circle cx="${x}" cy="${y}" r="1.3"/>`));
  return `<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">${dots.join("")}</svg>`;
}

// The grip of a row a switch sets.
function lockIconSvg() {
  return '<svg width="11" height="13" viewBox="0 0 11 13" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" stroke-linecap="round" aria-hidden="true">'
    + '<rect x="1.2" y="5.6" width="8.6" height="6.4" rx="1.6" fill="currentColor" fill-opacity=".16"/>'
    + '<path d="M3.1 5.6V3.9a2.4 2.4 0 0 1 4.8 0v1.7"/></svg>';
}

// Stepper chevrons, hand-drawn for the same reason.
function chevronIconSvg(up) {
  const points = up ? "1.5,4 4.5,1 7.5,4" : "1.5,1 4.5,4 7.5,1";
  return `<svg width="9" height="5" viewBox="0 0 9 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

// The shared collapse handles the sizing hooks; a text widget can also carry
// a DOM element on some frontends, so blank that too.
function hideWidget(widget) {
  if (!widget) return;
  collapseWidget(widget);
  if (widget.element) widget.element.style.display = "none";
  if (widget.inputEl) widget.inputEl.style.display = "none";
}

// A slot that a widget sits on borrows its y from that widget: on every
// layout the frontend writes `slot.pos = [10, widget.y + 10]`, and it skips
// hidden widgets when it hands out y, so QG's hidden widgets keep y 0 and the
// slot keeps [10, 10] - the node's first slot row. A link into the rows then
// draws on top of the model dot (the "rows" input looked like it had moved to
// model). The frontend rewrites `slot.pos` from the widget on every layout,
// so the widget's y is what has to move: give each hidden widget the y its
// slot would have if it were a plain input, one slot row each, and the
// frontend recomputes the slot into its own place.
const SLOT_HEIGHT = 20;
function placeWidgetSlots(node) {
  const inputs = node?.inputs;
  if (!inputs?.length) return false;
  const start = Number(node.constructor?.slot_start_y) || 0;
  let row = 0;
  let moved = false;
  for (const slot of inputs) {
    const widget = slot._widget
      ?? (slot.widget ? node.widgets?.find((item) => item.name === slot.widget.name) : null);
    // +4: a widget's own y sits half a slot row above the dot it carries
    // (`slot.pos.y = widget.y + NODE_SLOT_HEIGHT / 2`).
    const y = start + row * SLOT_HEIGHT + 4;
    if (widget && widget.y !== y) {
      widget.y = y;
      moved = true;
    }
    row += 1;
  }
  return moved;
}

async function fetchLoraList() {
  const response = await api.fetchApi("/qg/lora/list");
  const data = await response.json();
  return Array.isArray(data.loras) ? data.loras : [];
}

// One shared popup slot: opening any popup closes the previous one, and every
// listener hangs off one AbortController so teardown cannot leak.
let activePopup = null;

function closePopup() {
  hideHoverThumb();
  if (!activePopup) return;
  activePopup.abort.abort();
  activePopup.element.remove();
  activePopup = null;
}

// ---------- hover thumbnail ----------

// One floating preview image for the whole pack tab, shared by row hover and
// the picker. Fixed-positioned and pointer-events: none, so it can never
// shift layout or steal the cursor; it stays hidden until the image actually
// loads, so a LoRA without a sidecar preview shows nothing at all.
let hoverThumb = null;

function ensureHoverThumb() {
  if (hoverThumb) return hoverThumb;
  hoverThumb = el("img", "qgtools-lora-hoverthumb");
  hoverThumb.alt = "";
  hoverThumb.style.display = "none";
  hoverThumb.addEventListener("load", () => {
    if (hoverThumb.dataset.show === "1") hoverThumb.style.display = "";
  });
  hoverThumb.addEventListener("error", () => { hoverThumb.style.display = "none"; });
  document.body.append(hoverThumb);
  return hoverThumb;
}

function moveHoverThumb(x, y) {
  if (!hoverThumb || hoverThumb.dataset.show !== "1") return;
  const spot = thumbPosition(x, y, window.innerWidth, window.innerHeight);
  hoverThumb.style.left = `${spot.left}px`;
  hoverThumb.style.top = `${spot.top}px`;
}

function showHoverThumb(state, name, x, y) {
  if (!name || state.settings?.thumbnails === false) return;
  const thumb = ensureHoverThumb();
  thumb.dataset.show = "1";
  if (thumb.dataset.name !== name) {
    thumb.dataset.name = name;
    thumb.style.display = "none";
    thumb.src = api.apiURL(
      `/qg/lora/thumb?name=${encodeURIComponent(effectiveLoraName(state, name))}`);
  } else if (thumb.complete && thumb.naturalWidth > 0) {
    thumb.style.display = "";
  }
  moveHoverThumb(x, y);
}

function hideHoverThumb() {
  if (!hoverThumb) return;
  hoverThumb.dataset.show = "0";
  hoverThumb.style.display = "none";
}

function openPopup(element, anchorRect, { width, onEscape } = {}) {
  closePopup();
  const abort = new AbortController();
  element.classList.add("qgtools-lora-pop");
  if (width) element.style.width = `${width}px`;
  document.body.append(element);
  const place = () => {
    const popRect = element.getBoundingClientRect();
    let left = Math.min(anchorRect.left, window.innerWidth - popRect.width - 8);
    let top = anchorRect.bottom + 4;
    if (top + popRect.height > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - popRect.height - 4);
    }
    element.style.left = `${Math.max(8, left)}px`;
    element.style.top = `${top}px`;
  };
  place();
  requestAnimationFrame(place);
  document.addEventListener(
    "pointerdown",
    (event) => { if (!element.contains(event.target)) closePopup(); },
    { capture: true, signal: abort.signal }
  );
  window.addEventListener(
    "keydown",
    (event) => { if (event.key === "Escape") { event.stopPropagation(); closePopup(); onEscape?.(); } },
    { capture: true, signal: abort.signal }
  );
  activePopup = { element, abort };
  return { place };
}

// Re-run the zh translator over a body-level popup. The translator hooks
// insertions into <body> only; content swapped in afterwards (the async LoRA
// info card, a repopulated picker list) is invisible to it. Re-inserting the
// same element fires the observer again and is a no-op when no translator is
// installed. Re-insertion drops focus, so give it back to whoever had it.
function retranslate(element) {
  if (!element.isConnected) return;
  const active = document.activeElement;
  const restore = active && element.contains(active) ? active : null;
  element.replaceWith(element);
  if (restore) restore.focus();
}

// Every commit is a user gesture and enters undo history; a drag passes
// record: false for its intermediate values and records once on release.
function commitRows(state, rows, { structural = false, record = true } = {}) {
  // A card that only shows rows kept elsewhere changes nothing.
  if (state.readOnly) {
    renderRows(state);
    return;
  }
  state.rows = rows;
  state.widget.value = serializeRows(rows);
  state.renderedValue = state.widget.value;
  state.node.graph?.setDirtyCanvas(true, true);
  if (structural) renderRows(state);
  else updateRowValues(state);
  if (record) notifyQgChange();
}

function linked(state) {
  return (state.box?.loader ?? state.node).properties?.qgLoraLinked !== false;
}

// Picker options honor only hide-extension: their folder context is the
// disambiguator (group headers, search prefixes), so it stays.
function displayName(state, name) {
  return shortLoraName(name, {
    hideFolders: false,
    hideExtension: state.settings?.hide_extension !== false,
  });
}

// A row's label (and the info card title) also hides the folder by
// default; the full path lives in the tooltip.
function rowLabel(state, name) {
  return shortLoraName(name, {
    hideFolders: state.settings?.hide_folders !== false,
    hideExtension: state.settings?.hide_extension !== false,
  });
}

// Each named row's fit against the install's lora list,
// cached per name; refreshAvailable clears the cache when the list changes.
function nameStatus(state, name) {
  if (!name || !Array.isArray(state.available)) return null;
  if (!state.nameStatus) state.nameStatus = new Map();
  if (!state.nameStatus.has(name)) {
    state.nameStatus.set(name, resolveLoraName(name, state.available));
  }
  return state.nameStatus.get(name);
}

// The name the SERVER should be asked about: a remapped row's saved path
// would 404 on the thumb/info routes (they may be served by the public
// pack's copy, which resolves strictly), so ask with the resolved one.
function effectiveLoraName(state, name) {
  const status = nameStatus(state, name);
  return status?.status === "remapped" ? status.name : name;
}

function refreshAvailable(state) {
  fetchLoraList()
    .then((names) => {
      state.available = names;
      state.nameStatus = new Map();
      decorateRows(state);
      // Rows whose range lookup 404ed under the stale path get a second
      // chance under the resolved one.
      for (const row of state.rows) {
        if (!row.name) continue;
        if (nameStatus(state, row.name)?.status === "remapped"
            && rangeCache.get(row.name) === null) {
          rangeCache.delete(row.name);
          ensureRange(state, row.name);
        }
      }
    })
    .catch(() => {});
}

// CSS pixels the panel needs to show every row with no scrolling. The add
// button lives inside the stack now, so its height (plus the gap above it)
// counts inside the stack box.
function panelHeight(state) {
  const inner = state.rows.length
    ? state.rows.length * (ROW_HEIGHT + ROW_GAP) - ROW_GAP
    : BLANK_HEIGHT;
  const stack = inner + ROW_GAP + ACTIONS_HEIGHT + STACK_PADDING * 2 + 2; // +2 border
  const note = state.note ? NOTE_HEIGHT + ROW_GAP : 0;
  return PANEL_PADDING * 2 + GROUP_HEIGHT + ROW_GAP + note + stack;
}

function panelMinWidth(state) {
  return PANEL_MIN_WIDTH + (linked(state) ? 0 : SEPARATE_EXTRA_WIDTH);
}

function fitNode(state) {
  const width = Math.max(panelMinWidth(state), state.node.size?.[0] || PANEL_MIN_WIDTH);
  const height = state.node.computeSize
    ? state.node.computeSize()[1]
    : panelHeight(state) + WIDGET_FRAME + 80;
  state.node.setSize?.([width, height]);
  state.node.graph?.setDirtyCanvas(true, true);
}

// ---------- suggested strength ranges ----------

// One cached range per LoRA name; null = known-absent, undefined = not yet
// fetched. Filled lazily from the info route so rows can tint out-of-range
// strengths without a request per render.
const rangeCache = new Map();
const rangeFetches = new Set();

function ensureRange(state, name) {
  if (!name || rangeCache.has(name) || rangeFetches.has(name)) return;
  rangeFetches.add(name);
  api.fetchApi(`/qg/lora/info?name=${encodeURIComponent(effectiveLoraName(state, name))}`)
    .then((response) => response.json())
    .then((data) => {
      rangeCache.set(name, data.ok ? data.info.range ?? null : null);
      updateRowValues(state);
    })
    .catch(() => rangeCache.set(name, null))
    .finally(() => rangeFetches.delete(name));
}

function applyRangeTint(input, row, key) {
  const range = rangeCache.get(row.name);
  const outside = strengthOutOfRange(row[key], range ?? null);
  input.classList.toggle("out-of-range", outside);
  // The border moved to the wrapper when the stepper arrived; tint it too.
  input.closest(".qgtools-lora-strengthbox")?.classList.toggle("out-of-range", outside);
  // The old title prefixed "Suggested range -2 to 2." - but the translator
  // matches whole attributes only, so the varying numbers kept the whole
  // tooltip English forever. The static base title translates; the range
  // itself stays visible as the orange tint and in the info card's editors.
  input.title = input.dataset.baseTitle;
}

// ---------- strength boxes ----------

function strengthBox(state, index, key) {
  const box = el("div", "qgtools-lora-strengthbox");
  const input = el("input", "qgtools-lora-strength");
  input.value = state.rows[index][key].toFixed(2);
  input.dataset.qgStrength = key;
  input.dataset.baseTitle = key === "strength"
    ? "Model strength. Drag left/right to scrub, click to type, arrows to step. Shift = fine."
    : "CLIP strength. Drag left/right to scrub, click to type, arrows to step. Shift = fine.";
  // The title must exist BEFORE insertion: the zh translator only reads
  // attributes of elements present at insert time, and applyRangeTint first
  // runs after the async range fetch - too late for a freshly-set title.
  input.title = input.dataset.baseTitle;
  input.setAttribute("aria-label", key === "strength" ? zh("Model strength") : zh("CLIP strength"));
  input.readOnly = true;
  input.__qgRead = () => state.rows[index]?.[key].toFixed(2) ?? "1.00";
  input.__qgTint = () => state.rows[index] && applyRangeTint(input, state.rows[index], key);
  ensureRange(state, state.rows[index].name);

  const commitValue = (value, { record = true } = {}) => {
    let rows = state.rows;
    if (key === "strength") rows = setStrength(rows, index, value, linked(state));
    else rows = rows.map((row, i) => (i === index ? { ...row, strength_clip: roundStrength(value) } : row));
    commitRows(state, rows, { record });
  };

  let drag = null;
  input.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !input.readOnly) return;
    drag = { x: event.clientX, y: event.clientY, start: state.rows[index][key], scrubbed: false };
    input.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  input.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.scrubbed && isScrubbing(dx, dy)) drag.scrubbed = true;
    if (drag.scrubbed) {
      commitValue(scrubValue(drag.start, dx, event.shiftKey, state.settings?.step), { record: false });
    }
  });
  const endDrag = (event) => {
    if (!drag) return;
    try { input.releasePointerCapture(event.pointerId); } catch {}
    const wasClick = !drag.scrubbed;
    drag = null;
    if (!wasClick) notifyQgChange();
    if (wasClick) {
      input.readOnly = false;
      input.focus();
      input.select();
    }
  };
  input.addEventListener("pointerup", endDrag);
  input.addEventListener("pointercancel", endDrag);

  input.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter") input.blur();
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const coarse = state.settings?.step ?? DEFAULT_STEP;
      const step = (event.shiftKey ? FINE_STEP : coarse) * (event.key === "ArrowUp" ? 1 : -1);
      commitValue(state.rows[index][key] + step);
      input.value = state.rows[index][key].toFixed(2);
      input.select();
    }
  });
  input.addEventListener("blur", () => {
    if (!input.readOnly) {
      const number = Number(input.value);
      if (Number.isFinite(number)) commitValue(number);
      input.readOnly = true;
    }
    input.value = state.rows[index][key].toFixed(2);
  });

  // Click-to-step arrows: the third way to set a strength, next to scrubbing
  // and typing. Steps by the configured step (gear menu); Shift steps fine.
  const steps = el("div", "qgtools-lora-step");
  const stepButton = (direction) => {
    const button = el("button");
    button.type = "button";
    button.tabIndex = -1;
    button.title = direction > 0
      ? "Strength up one step. Shift = fine."
      : "Strength down one step. Shift = fine.";
    button.innerHTML = chevronIconSvg(direction > 0);
    button.addEventListener("click", (event) => {
      const coarse = state.settings?.step ?? DEFAULT_STEP;
      commitValue(state.rows[index][key] + (event.shiftKey ? FINE_STEP : coarse) * direction);
      input.value = state.rows[index][key].toFixed(2);
    });
    return button;
  };
  steps.append(stepButton(1), stepButton(-1));
  box.append(input, steps);
  applyRangeTint(input, state.rows[index], key);
  return box;
}

// ---------- picker ----------

// Width of the longest label in the picker's font. Remembered across opens,
// so the next picker opens at the width its list will want instead of
// jumping when the list arrives.
let widestPickerLabel = 0;

function widestLabel(labels) {
  const context = measureCanvas();
  if (!context) return 0;
  context.font = POP_FONT;
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, context.measureText(label).width);
  return widest;
}

// Folder browsing is a local preference, shared by the node's add/replace
// pickers. It never changes the workflow or enters its undo history.
const COLLAPSED_FOLDERS_KEY = "QG.lora_loader.collapsedFolders";
let rememberedCollapsedFolders = new Set();

function loadCollapsedFolders() {
  try {
    const raw = window.localStorage?.getItem(COLLAPSED_FOLDERS_KEY);
    const stored = raw == null ? null : JSON.parse(raw);
    if (Array.isArray(stored)) rememberedCollapsedFolders = new Set(stored.filter((name) => typeof name === "string"));
  } catch {}
  return rememberedCollapsedFolders;
}

function saveCollapsedFolders(folders) {
  rememberedCollapsedFolders = folders;
  try { window.localStorage?.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...folders])); } catch {}
}

function openPicker(state, index, anchor, { keyboard = false } = {}) {
  // + LoRA adds only after a choice, so cancelling leaves no empty row and
  // a whole folder is one undo step. A row's own picker replaces one file.
  const adding = index == null;
  // Focus goes back to the stack only when the picker was opened from the
  // keyboard. Opened or answered with the mouse, it leaves the keys alone.
  const backToStack = (target) => { if (keyboard) focusStackRow(state, target); };
  const pop = el("div");
  const search = el("input", "qgtools-lora-search");
  // Written after insertion, so the zh plugin DOM pass never revisits it.
  search.placeholder = zh("Search LoRAs...");
  search.setAttribute("aria-label", zh("Search LoRAs"));
  const list = el("div", "qgtools-lora-list");
  list.append(el("div", "qgtools-lora-empty", "Loading..."));
  if (adding) pop.append(el("div", "qgtools-lora-picker-note",
    "Use the arrows to fold folders. Click a file to add one, or a folder name to add all, including nested folders. Skips files already in this stack."));
  pop.append(search, list);
  const anchorRect = anchor.getBoundingClientRect();
  const fitWidth = () => pickerWidth(widestPickerLabel, anchorRect.width, window.innerWidth);
  const originalRowId = state.rows[index]?.id;
  const { place } = openPopup(pop, anchorRect, {
    width: fitWidth(),
    onEscape: () => backToStack(adding ? state.rows.length
      : state.rows.findIndex((row) => row.id === originalRowId)),
  });
  search.focus();

  let names = [];
  let folders = new Map();
  let options = [];
  let loadError = false;
  let highlight = -1;

  const collapsedFolders = loadCollapsedFolders();
  // Search reveals matches without losing the user's usual folded view.
  let searchCollapsed = new Set();
  const currentFolds = () => search.value.trim() ? searchCollapsed : collapsedFolders;

  // after: "highlight" keeps the folder highlighted for the search box's
  // arrow keys, "arrow" keeps focus on the fold arrow that was pressed with
  // the keyboard, "search" hands the keys back to the search box.
  const toggleFolder = (name, collapsed = !currentFolds().has(name), after = "highlight") => {
    const folds = currentFolds();
    if (collapsed) folds.add(name);
    else folds.delete(name);
    if (folds === collapsedFolders) saveCollapsedFolders(folds);
    const scrollTop = list.scrollTop;
    highlight = -1;
    renderList();
    if (after === "highlight" && adding) {
      highlight = options.findIndex((entry) => entry.kind === "folder" && entry.name === name);
      list.querySelector(`[data-qg-flat="${highlight}"]`)?.classList.add("highlight");
    }
    list.scrollTop = scrollTop;
    if (after === "arrow") [...list.querySelectorAll(".qgtools-lora-folder-toggle")]
      .find((button) => button.dataset.folder === name)?.focus({ preventScroll: true });
    else if (after === "search") search.focus({ preventScroll: true });
  };

  const appendFolderToggle = (row, name) => {
    const button = el("button", "qgtools-lora-folder-toggle");
    const expanded = !currentFolds().has(name);
    button.type = "button";
    button.dataset.folder = name;
    button.innerHTML = chevronIconSvg(false);
    button.setAttribute("aria-expanded", String(expanded));
    button.title = zh(expanded ? "Collapse" : "Expand") + " " + name;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("keydown", keepKeyInField);
    button.addEventListener("click", (event) => {
      // Only the folder name adds files; its arrow is browse-only.
      event.stopPropagation();
      // A click made with a key (detail 0) stays on the arrow. A mouse click
      // goes back to the search box, so typing keeps searching.
      toggleFolder(name, !currentFolds().has(name), event.detail === 0 ? "arrow" : "search");
    });
    row.append(button);
  };

  const pick = (entry, { pointer = false } = {}) => {
    if (!entry) return;
    const { name, kind } = entry;
    if (kind === "folder") {
      const result = appendFolderRows(state.rows, folders.get(name) ?? [], state.settings?.default_strength ?? 1);
      if (result.needed > result.room) {
        loraToast(zhCount("This folder has {n} new LoRA", "This folder has {n} new LoRAs", result.needed)
          + zhSep()
          + zh("but only {room} of {max} rows are free. Nothing was added. Remove rows or choose a smaller folder.")
            .replace("{room}", result.room).replace("{max}", MAX_ROWS));
        return;
      }
      if (!result.added) {
        loraToast(zh("Every LoRA in this folder is already in this stack. Nothing was added."));
        return;
      }
      const firstAdded = state.rows.length;
      closePopup();
      commitRows(state, result.rows, { structural: true });
      fitNode(state);
      loraToast(zhCount("Added {n} LoRA", "Added {n} LoRAs", result.added)
        + zhSep() + zh("from {name}.").replace("{name}", name)
        + (result.skipped
          ? zhSep() + zhCount("Skipped {n} already in this stack.", "Skipped {n} already in this stack.", result.skipped)
          : ""));
      if (!pointer) backToStack(firstAdded);
      return;
    }
    if (adding && state.rows.length >= MAX_ROWS) {
      loraToast(zh("This stack already has {max} rows. Remove a row before adding another LoRA.").replace("{max}", MAX_ROWS));
      return;
    }
    const strength = roundStrength(state.settings?.default_strength ?? 1);
    const rows = adding
      ? [...state.rows, { ...newRow(), name, strength, strength_clip: strength }]
      : state.rows.map((row, i) =>
        // A different file means different trigger words: clear the old ones.
        i === index ? { ...row, name, triggers: name === row.name ? row.triggers : "" } : row
      );
    closePopup();
    commitRows(state, rows, { structural: true });
    if (adding) fitNode(state);
    if (!pointer) backToStack(adding ? rows.length - 1 : index);
  };

  const appendOption = (entry, flatIndex) => {
    const { name, kind, label, depth, count } = entry;
    const folder = kind === "folder";
    const option = el("div", "qgtools-lora-option");
    option.style.paddingLeft = `${OPTION_PAD_X + Math.min(4, depth) * 12 + (folder ? 0 : 30)}px`;
    if (folder) appendFolderToggle(option, name);
    option.append(nameLabel(folder ? label : displayName(state, label)));
    if (folder) {
      option.classList.add("qgtools-lora-folder-option");
      option.append(el("span", "qgtools-lora-folder-count", zhCount("Add all {n} LoRA", "Add all {n} LoRAs", count)));
      option.title = zh("Add all LoRAs in this folder, including nested folders. Files already in this stack are skipped.");
    }
    if (!folder && name === state.rows[index]?.name) option.classList.add("current");
    option.addEventListener("pointerenter", (event) => {
      // Pointing at a folder never chooses it for Enter or for the Left and
      // Right keys: a pointer that only rests on the list would otherwise
      // add a whole folder. It lights up on hover (CSS); a click or the
      // arrow keys choose it.
      if (folder) {
        hideHoverThumb();
        return;
      }
      if (highlight !== flatIndex) {
        // Keep the option under the pointer intact through the click.
        list.querySelector(".qgtools-lora-option.highlight")?.classList.remove("highlight");
        highlight = flatIndex;
        option.classList.add("highlight");
      }
      showHoverThumb(state, name, event.clientX, event.clientY);
    });
    option.addEventListener("pointermove", (event) => {
      if (!folder) showHoverThumb(state, name, event.clientX, event.clientY);
    });
    option.addEventListener("pointerleave", hideHoverThumb);
    option.addEventListener("click", () => pick(entry, { pointer: true }));
    option.dataset.qgFlat = String(flatIndex);
    list.append(option);
  };

  const renderList = () => {
    // Read while the list is still laid out from the last frame: the
    // gutter is reserved (scrollbar-gutter), so this width holds whatever
    // the new results are, and fitting the labels forces no layout.
    const labelWidth = list.clientWidth - 2 * (LIST_PAD_X + OPTION_PAD_X);
    const entries = loraPickerEntries(names, search.value, currentFolds());
    options = entries.filter((entry) => adding || entry.kind === "file");
    if (highlight >= 0) highlight = clampHighlight(highlight, options.length);
    list.textContent = "";
    hideHoverThumb();
    if (!entries.length) {
      list.append(el("div", "qgtools-lora-empty",
        loadError ? zh("Could not list LoRAs. Close this picker and try again.")
          : names.length ? "No matches." : "Put LoRA files in models/loras."));
      place();
      return;
    }
    let flatIndex = 0;
    for (const entry of entries) {
      if (!adding && entry.kind === "folder") {
        const heading = el("div", "qgtools-lora-folder");
        appendFolderToggle(heading, entry.name);
        heading.append(nameLabel(entry.label));
        heading.style.paddingLeft = `${OPTION_PAD_X + Math.min(4, entry.depth) * 12}px`;
        heading.title = entry.name;
        list.append(heading);
      } else appendOption(entry, flatIndex++);
    }
    fitLabels(list.querySelectorAll(".qgtools-lora-label"), labelWidth > 0 ? labelWidth : undefined);
    list.querySelector(`[data-qg-flat="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
    place();
  };

  search.addEventListener("input", () => { highlight = -1; searchCollapsed = new Set(); renderList(); });
  search.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (isAppShortcut(event)) return; // Ctrl + Enter runs the workflow, it does not pick
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      highlight = moveHighlight(highlight, event.key === "ArrowDown" ? 1 : -1, options.length);
      renderList();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight")
        && options[highlight]?.kind === "folder") {
      event.preventDefault();
      toggleFolder(options[highlight].name, event.key === "ArrowLeft");
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      highlight = event.key === "Home" ? 0 : options.length - 1;
      renderList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Typing a filename then Enter keeps picking one file. A folder is
      // selected deliberately by a click or by moving the highlight to it.
      pick(options[highlight] ?? options.find((entry) => entry.kind === "file"));
    }
  });

  // Always refetch on open: a stale session cache is how renamed files keep
  // haunting pickers.
  fetchLoraList()
    .then((fetched) => {
      if (!pop.isConnected) return;
      names = fetched;
      // The picker's fresh list is also the row decorator's fresh list.
      folders = new Map(loraFolders(fetched).map(({ folder, names }) => [folder, names]));
      state.available = fetched;
      state.nameStatus = new Map();
      // Full paths bound every label the list shows (browse and search both
      // strip a folder prefix), so this width never changes while typing.
      widestPickerLabel = widestLabel(names.map((name) => displayName(state, name))) + (adding ? 110 : 30);
      if (!adding) highlight = loraPickerEntries(names, "", currentFolds()).filter((entry) => entry.kind === "file")
        .findIndex((entry) => entry.name === state.rows[index]?.name);
      pop.style.width = `${fitWidth()}px`;
      renderList();
    })
    .catch(() => {
      if (!pop.isConnected) return;
      loadError = true;
      renderList();
    });
}

// Only keys dispatched inside this panel participate. No window/document
// listener and no canvas selection heuristic: Tab, application shortcuts,
// typing, and focus in every other node keep their existing behavior.
function focusStackRow(state, index) {
  const rows = [...state.panel.querySelectorAll(".qgtools-lora-row")];
  const target = index >= 0 && index < rows.length ? rows[index]
    : state.panel.querySelector(".qgtools-lora-add:not(:disabled)") ?? rows.at(-1);
  hideHoverThumb();
  target?.focus({ preventScroll: true });
}

// Is the browser showing keyboard focus on this element? A control that was
// clicked with the mouse has focus too, without the outline. Focus is only
// ever handed to a row from an element that shows it: otherwise a mouse click
// would leave a row holding the keys with nothing on screen to say so.
function showsKeyboardFocus(element) {
  try {
    return Boolean(element?.matches?.(":focus-visible"));
  } catch {
    return false;
  }
}

function installStackKeyboard(state) {
  state.panel.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!state.panel.contains(document.activeElement) || event.defaultPrevented
        || event.isComposing || event.keyCode === 229) return;
    const rowElement = target.closest?.(".qgtools-lora-row");
    const atAdd = Boolean(target.closest?.(".qgtools-lora-add, .qgtools-lora-blank"));
    if (!rowElement && !atAdd) return;
    const field = target.closest?.("input, textarea, select, [contenteditable]");
    const editing = Boolean(field && (field.isContentEditable
      || field.tagName !== "INPUT" || !field.readOnly));
    if (event.key === "Escape" && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      document.activeElement?.blur();
      return;
    }
    // A row's own buttons and boxes keep Enter and Space (the switch turns
    // the row off, the name opens its picker). A strength field keeps its
    // editing keys; arrows only browse it while idle.
    const onControl = Boolean(rowElement && target !== rowElement);
    const index = rowElement ? [...state.panel.querySelectorAll(".qgtools-lora-row")].indexOf(rowElement)
      : state.rows.length;
    const action = loraStackKeyAction(event, { index, rowCount: state.rows.length, atAdd, editing, onControl });
    const heldToggle = rowElement && !onControl && event.key === " " && event.repeat && !editing
      && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (!action && !heldToggle) return;
    event.preventDefault();
    event.stopPropagation();
    if (!action) return; // Holding Space never toggles twice or starts canvas panning.
    // "block" (Delete, Backspace) ends here: the key is kept from ComfyUI.
    if (action.kind === "focus") {
      focusStackRow(state, action.index);
    } else if (action.kind === "pick") {
      if (atAdd && state.rows.length >= MAX_ROWS) return;
      openPicker(state, atAdd ? null : index,
        atAdd ? state.panel.querySelector(".qgtools-lora-add") : rowElement.querySelector(".qgtools-lora-name"),
        { keyboard: true });
    } else if (action.kind === "toggle") {
      const rows = state.rows.map((row, i) => i === index ? { ...row, enabled: !row.enabled } : row);
      state.toggleSnapshot = snapshotEnabled(rows);
      commitRows(state, rows, { structural: true });
      focusStackRow(state, index);
    } else if (action.kind === "strength") {
      const strengthField = field ?? target.closest?.(".qgtools-lora-strengthbox")?.querySelector("input");
      const key = strengthField?.dataset.qgStrength === "strength_clip" ? "strength_clip" : "strength";
      const step = action.fine ? FINE_STEP : state.settings?.step ?? DEFAULT_STEP;
      const value = roundStrength(state.rows[index][key] + action.direction * step);
      if (value === state.rows[index][key]) return;
      const rows = key === "strength"
        ? setStrength(state.rows, index, value, linked(state))
        : state.rows.map((row, i) => i === index ? { ...row, strength_clip: value } : row);
      commitRows(state, rows);
    }
  }, { capture: true });
}

// ---------- Civitai lookup ----------

// One click, one file: the server hashes the LoRA, this browser asks Civitai
// about that hash, and the server saves the answer beside the LoRA after
// checking it describes the same file. Returns false when Civitai does not
// know the file (unpublished or hidden models answer 404).
async function lookUpOnCivitai(serverName) {
  const hashed = await (await api.fetchApi(
    `/qg/lora/hash?name=${encodeURIComponent(serverName)}`
  )).json();
  if (!hashed.ok) throw new Error(hashed.error || "Could not hash this LoRA file.");
  const response = await fetch(civitaiByHashUrl(hashed.sha256), {
    credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Civitai answered ${response.status}.`);
  const info = parseCivitaiBody(await response.text());
  const saved = await (await api.fetchApi("/qg/lora/civitai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: serverName, info }),
  })).json();
  if (!saved.ok) throw new Error(saved.error || "Could not save the Civitai info.");
  return true;
}

// ---------- info card ----------

function openInfo(state, index, anchor) {
  const row = state.rows[index];
  if (!row.name) return;
  // Every server call in the card goes through the resolved name, so the
  // card works for a moved file too.
  const serverName = effectiveLoraName(state, row.name);
  const card = el("div", "qgtools-lora-card");
  card.append(el("div", "qgtools-lora-empty", "Loading..."));
  openPopup(card, anchor.getBoundingClientRect());

  const render = (info) => {
    card.textContent = "";
    const image = el("img");
    image.alt = "";
    image.src = api.apiURL(`/qg/lora/thumb?name=${encodeURIComponent(serverName)}`);
    image.addEventListener("error", () => image.remove());
    if (info.has_preview) card.append(image);
    card.append(el("h4", "", info.civitai_title || rowLabel(state, row.name)));
    if (info.base_model) {
      // "Base model" stays its own text node so the translator can match it;
      // the value after it is data and needs no translation.
      const base = el("div", "qgtools-lora-meta", "Base model");
      base.append(`: ${info.base_model}`);
      card.append(base);
    }
    const size = formatFileSize(info.size_bytes);
    if (size) {
      const meta = el("div", "qgtools-lora-meta", size);
      if (Number.isFinite(info.mtime)) {
        meta.append(" · ", "modified", ` ${new Date(info.mtime * 1000).toLocaleDateString()}`);
      }
      card.append(meta);
    }
    if (Number.isInteger(info.civitai_model_id)) {
      const link = el("a", "qgtools-lora-civitai-link", "View on Civitai ↗");
      const version = Number.isInteger(info.civitai_version_id)
        ? `?modelVersionId=${info.civitai_version_id}` : "";
      link.href = `https://civitai.com/models/${info.civitai_model_id}${version}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }

    const chipSection = (label, words) => {
      if (!words?.length) return;
      card.append(el("div", "qgtools-lora-meta", label));
      const chips = el("div", "qgtools-lora-chips");
      for (const word of words) {
        const chip = el("button", "qgtools-lora-chip", word);
        chip.type = "button";
        chip.title = zh("Toggle this trigger word into the row's output");
        const refresh = () => chip.classList.toggle("active", hasTrigger(state.rows[index].triggers, word));
        refresh();
        chip.addEventListener("click", () => {
          const rows = state.rows.map((entry, i) =>
            i === index ? { ...entry, triggers: toggleTrigger(entry.triggers, word) } : entry
          );
          commitRows(state, rows);
          refresh();
        });
        chips.append(chip);
      }
      card.append(chips);
    };
    chipSection("From the file", info.file_triggers);
    chipSection("From Civitai", info.civitai_triggers);
    chipSection("Your words", info.custom_triggers);

    if (state.settings?.civitai_lookup !== false) {
      const fetchButton = el(
        "button", "qgtools-lora-add qgtools-lora-fetch", civitaiButtonLabel(info.has_civitai)
      );
      fetchButton.type = "button";
      fetchButton.title = zh("Asks civitai.com about this one file, from this browser.");
      fetchButton.addEventListener("click", async () => {
        fetchButton.disabled = true;
        fetchButton.textContent = "Fetching...";
        retranslate(card);
        try {
          if (!(await lookUpOnCivitai(serverName))) {
            fetchButton.textContent = "Not found on Civitai";
            retranslate(card);
            return;
          }
          load();
        } catch (error) {
          fetchButton.textContent = "Civitai lookup failed";
          fetchButton.title = String(error?.message || error);
          retranslate(card);
        }
      });
      card.append(fetchButton);
    }

    const range = el("div", "qgtools-lora-range");
    range.append(el("span", "qgtools-lora-meta", "Suggested strength"));
    // Each bound is optional: erase it for "any". Saved when a gesture ends.
    const bounds = {};
    const saveRange = async () => {
      const payload = {
        name: serverName,
        words: info.custom_triggers || [],
        min: bounds.min.get(),
        max: bounds.max.get(),
      };
      try {
        await api.fetchApi("/qg/lora/triggers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        rangeCache.delete(row.name);
        ensureRange(state, row.name);
      } catch {}
    };
    for (const key of ["min", "max"]) {
      bounds[key] = makeScrubInput({
        value: info.range?.[key] ?? null, allowEmpty: true, emptyStart: key === "min" ? 0 : 1,
        placeholder: "any", min: STRENGTH_MIN, max: STRENGTH_MAX,
        step: 0.05, fineStep: 0.01, decimals: 2, width: 76,
        title: key === "min"
          ? "Suggested lowest strength; erase it for any. Drag to scrub, click to type, arrows to step; Shift = fine."
          : "Suggested highest strength; erase it for any. Drag to scrub, click to type, arrows to step; Shift = fine.",
        onSettle: saveRange,
      });
    }
    range.append(bounds.min.root, el("span", "qgtools-lora-meta", "to"), bounds.max.root);
    range.title = "Advisory range for this LoRA; out-of-range strengths tint orange on the row.";
    card.append(range);

    const custom = el("div", "qgtools-lora-custom");
    const wordInput = el("input");
    wordInput.placeholder = zh("Add your own trigger word...");
    wordInput.addEventListener("keydown", (event) => {
      keepKeyInField(event);
      if (event.key === "Enter" && !isAppShortcut(event)) addButton.click();
    });
    const addButton = el("button", "qgtools-lora-add", "Add");
    addButton.type = "button";
    addButton.addEventListener("click", async () => {
      const word = wordInput.value.trim();
      if (!word) return;
      wordInput.value = "";
      const words = [...(info.custom_triggers || []), word];
      try {
        await api.fetchApi("/qg/lora/triggers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: serverName, words }),
        });
      } catch {}
      const rows = state.rows.map((entry, i) =>
        i === index ? { ...entry, triggers: toggleTrigger(entry.triggers, word) } : entry
      );
      commitRows(state, rows);
      load();
    });
    custom.append(wordInput, addButton);
    card.append(custom);
    // The zh translation plugin translates a popup once, at the moment it is
    // appended to <body>; its observer does not watch subtree changes, so a
    // card repopulated after the async lookup would stay English. Swapping
    // the card with itself re-triggers that observer over the finished
    // content (a no-op when no translator is installed).
    retranslate(card);
  };

  const load = () => {
    api.fetchApi(`/qg/lora/info?name=${encodeURIComponent(serverName)}`)
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) throw new Error(data.error);
        render(data.info);
      })
      .catch(() => {
        card.textContent = "";
        card.append(el("div", "qgtools-lora-empty", "Could not read LoRA info."));
        retranslate(card);
      });
  };
  load();
}

// ---------- templates ----------

const TEMPLATES_KEY = "QG.lora_loader.templates";

function loadTemplates() {
  try {
    return parseTemplates(window.localStorage?.getItem(TEMPLATES_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveTemplates(list) {
  try {
    window.localStorage?.setItem(TEMPLATES_KEY, JSON.stringify(list));
  } catch {}
}

function openTemplates(state, anchor) {
  const menu = el("div", "qgtools-lora-menu qgtools-lora-templates");
  const rebuild = () => {
    menu.textContent = "";
    const saveRow = el("div", "qgtools-lora-custom");
    const nameInput = el("input");
    nameInput.placeholder = zh("Save current as...");
    nameInput.title = "Name this stack; saving over an existing name replaces it";
    const saveButton = el("button", "qgtools-lora-add", "Save");
    saveButton.type = "button";
    const save = () => {
      const template = templateFromRows(nameInput.value, state.rows);
      if (!template) return;
      saveTemplates(upsertTemplate(loadTemplates(), template));
      nameInput.value = "";
      rebuild();
    };
    saveButton.addEventListener("click", save);
    nameInput.addEventListener("keydown", (event) => {
      keepKeyInField(event);
      if (event.key === "Enter" && !isAppShortcut(event)) save();
    });
    saveRow.append(nameInput, saveButton);
    menu.append(saveRow);

    const templates = loadTemplates();
    if (!templates.length) {
      menu.append(el("div", "qgtools-lora-empty", "No saved templates yet."));
      return;
    }
    for (const template of templates) {
      const row = el("div", "qgtools-lora-template-row");
      const apply = el("button", "", template.name);
      apply.type = "button";
      apply.title = zh("Replace this node's rows with {a} ({b})")
        .replace("{a}", template.name)
        .replace("{b}", template.rows.length + (template.rows.length === 1 ? " LoRA" : " LoRAs"));
      apply.addEventListener("click", () => {
        closePopup();
        commitRows(state, applyTemplate(template), { structural: true });
        fitNode(state);
      });
      const remove = el("button", "qgtools-lora-template-x", "×");
      remove.type = "button";
      remove.title = zh("Delete {a}").replace("{a}", template.name);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        saveTemplates(removeTemplate(loadTemplates(), template.name));
        rebuild();
      });
      row.append(apply, remove);
      menu.append(row);
    }
  };
  rebuild();
  openPopup(menu, anchor.getBoundingClientRect(), { width: 240 });
  menu.querySelector("input")?.focus();
}

// ---------- row menu ----------

function openRowMenu(state, index, event) {
  const menu = el("div", "qgtools-lora-menu");
  const item = (label, action, disabled = false) => {
    const button = el("button", "", label);
    button.type = "button";
    button.disabled = disabled;
    button.addEventListener("click", () => { closePopup(); action(); });
    menu.append(button);
    return button;
  };
  const insertEmpty = (position) => {
    if (state.rows.length >= MAX_ROWS) return;
    const strength = roundStrength(state.settings?.default_strength ?? 1);
    const rows = state.rows.slice();
    rows.splice(position, 0, { ...newRow(), strength, strength_clip: strength });
    commitRows(state, rows, { structural: true });
    fitNode(state);
  };
  item("Insert empty LoRA above", () => insertEmpty(index), state.rows.length >= MAX_ROWS);
  item("Insert empty LoRA below", () => insertEmpty(index + 1), state.rows.length >= MAX_ROWS);
  item("Move up", () => commitRows(state, moveRow(state.rows, index, -1), { structural: true }), index === 0);
  item("Move down", () => commitRows(state, moveRow(state.rows, index, 1), { structural: true }),
    index === state.rows.length - 1);
  item("Duplicate", () => {
    const copy = { ...state.rows[index], id: newRow().id };
    const rows = state.rows.slice();
    rows.splice(index + 1, 0, copy);
    commitRows(state, rows, { structural: true });
    fitNode(state);
  }, state.rows.length >= MAX_ROWS);
  item("Remove this LoRA", () => {
    const rows = state.rows.slice();
    rows.splice(index, 1);
    commitRows(state, rows, { structural: true });
    fitNode(state);
  });
  item("🗑 Delete all LoRAs…", () => {
    const confirmation = el("div", "qgtools-lora-menu");
    const message = el("div", "qgtools-lora-empty",
      "Remove every LoRA row from this node? Files on disk are kept.");
    const cancel = el("button", "", "Cancel — keep LoRAs");
    const remove = el("button", "qgtools-lora-danger", "🗑 Yes, delete all rows");
    cancel.type = remove.type = "button";
    cancel.addEventListener("click", closePopup);
    remove.addEventListener("click", () => {
      closePopup();
      commitRows(state, [], { structural: true });
      fitNode(state);
      notifyQgChange();
    });
    confirmation.append(message, cancel, remove);
    openPopup(confirmation,
      { left: event.clientX, top: event.clientY, bottom: event.clientY, width: 0 },
      { width: 270 });
    cancel.focus();
  }).classList.add("qgtools-lora-danger");
  openPopup(menu, { left: event.clientX, top: event.clientY, bottom: event.clientY, width: 0 });
}

// ---------- rows a switch sets ----------

// Every Workflow Switches node on a graph, with its settings.
function switchBoards(graph) {
  return (graph?.nodes ?? graph?._nodes ?? [])
    .filter((node) => node?.type === SWITCHES_CLASS)
    .map((node) => ({ node, settings: node.properties?.[SETTINGS_PROPERTY] }));
}

// The switches that set one row. A switch addresses the node that keeps the
// rows (state.owner): the loader itself, or the box that holds them.
function rowOwners(state, row) {
  const owner = state.owner;
  if (!owner?.node?.graph || !row?.name) return [];
  return stackRowOwners(switchBoards(owner.node.graph), owner.node.id, owner.name, row.name);
}

function ownerNames(owners) {
  return [...new Set(owners.map((owner) => `"${owner.title}"`))].join(", ");
}

// Put a lock in the grip's place on every row a switch sets. Cheap to call
// often: the rows are only touched when who sets them changed.
function refreshLocks(state) {
  const owners = state.rows.map((row) => rowOwners(state, row));
  const signature = owners.map(ownerNames).join("|");
  if (signature === state.lockSignature) return;
  state.lockSignature = signature;
  const rows = state.panel.querySelectorAll(".qgtools-lora-row");
  rows.forEach((rowElement, index) => {
    const grip = rowElement.querySelector(".qgtools-lora-grip");
    if (!grip) return;
    const names = ownerNames(owners[index] ?? []);
    rowElement.classList.toggle("owned", Boolean(names));
    grip.classList.toggle("locked", Boolean(names));
    grip.innerHTML = names ? lockIconSvg() : gripIconSvg();
    grip.title = names
      ? zh(`Set by ${names}. Click the lock to take this row over: the switch then leaves it alone. Drag to reorder.`)
      : zh("Drag to reorder");
  });
}

// Take a row back from the switches that set it: they forget it, keep the
// rest of what they do, and stop reading "changed" because of it.
function takeRowOver(state, index) {
  const row = state.rows[index];
  const owners = rowOwners(state, row);
  if (!owners.length) return;
  for (const owner of owners) {
    owner.node.properties ??= {};
    owner.node.properties[SETTINGS_PROPERTY] = releaseStackRow(
      owner.node.properties[SETTINGS_PROPERTY], owner.id, state.owner.node.id, state.owner.name, row.name,
    );
  }
  refreshLocks(state);
  app.canvas?.setDirty?.(true, true);
  notifyQgChange();
  loraToast(zh(`${rowLabel(state, row.name)} is yours now: ${ownerNames(owners)} no longer sets it.`));
}

// ---------- rendering ----------

// Per-row decoration. The strength bar behind each name (inline styles,
// not CSS classes - every bar's geometry is data-driven; the pure math
// lives in js/shared/lora_stack.mjs), the amber duplicate ring,
// and the moved/missing tint against the install's list. Runs on every
// value update - the bar scale can change whenever any row's strength does.
function decorateRows(state) {
  const showBars = state.settings?.strength_bars !== false;
  const scale = strengthBarScale(state.rows);
  const dups = duplicateLoraKeys(state.rows);
  state.panel.querySelectorAll(".qgtools-lora-name").forEach((button, index) => {
    const row = state.rows[index];
    if (!row?.name) {
      button.style.background = "";
      button.classList.remove("dup", "moved", "missing");
      return;
    }
    const notes = [row.name];
    if (showBars) {
      button.style.background = strengthBarBackground(row.strength, scale);
      notes.push(`Model strength ${row.strength.toFixed(2)}; `
        + `bar edges are ±${scale.toFixed(2)}`);
    } else {
      button.style.background = "";
    }
    const dup = dups.has(row.name.toLowerCase());
    button.classList.toggle("dup", dup);
    if (dup) notes.push("Duplicate: another row loads this same LoRA.");
    const status = nameStatus(state, row.name);
    button.classList.toggle("moved", status?.status === "remapped");
    button.classList.toggle(
      "missing",
      status?.status === "missing" || status?.status === "ambiguous",
    );
    if (status?.status === "remapped") {
      notes.push(`Not at its saved path; the run will use "${status.name}".`);
    } else if (status?.status === "missing") {
      notes.push(
        state.onMissingWidget?.value === "skip"
          ? "No matching file in models/loras - this row is skipped at run time "
            + "(Stop on missing LoRA is off)."
          : "No matching file in models/loras - the run stops before sampling. Fix "
            + "the row, or turn Stop on missing LoRA off in the gear menu to skip it.",
      );
    } else if (status?.status === "ambiguous") {
      notes.push("Several files match this name - pick one to settle it.");
    }
    button.title = notes.join("\n");
  });
}

function updateRowValues(state) {
  state.panel.querySelectorAll(".qgtools-lora-strength").forEach((input) => {
    if (input.readOnly && input.__qgRead) input.value = input.__qgRead();
    if (input.__qgTint) input.__qgTint();
  });
  const summary = state.panel.querySelector(".qgtools-lora-summary");
  if (summary) {
    if (summary.firstChild) summary.firstChild.nodeValue = summarizeRows(state.rows);
    const word = summary.querySelector(".qgtools-lora-sumword");
    if (word) word.hidden = !state.rows.some((row) => row.name);
  }
  const master = state.panel.querySelector(".qgtools-lora-master");
  if (master) {
    const overall = toggleAllState(state.rows);
    master.classList.toggle("on", overall === "on");
    master.classList.toggle("mixed", overall === "mixed");
  }
  decorateRows(state);
}

// ---------- absorb the loader chain ----------

// Loader recognition and graph traversal share one tested source in lora_stack.mjs.
// Circular reconnect arrow, hand-drawn like the shared gear so no glyph
// font is trusted to have it.
function reloadIconSvg() {
  return (
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M13.4 8a5.4 5.4 0 1 1-1.8-4"/><polyline points="13.6 1.4 13.6 4.6 10.4 4.6"/></svg>'
  );
}

// Re-check every row against a FRESH lora list and repair
// what it can. A row whose file moved (or was restored after being missing)
// reconnects by rewriting the row to the resolved path - exactly what
// deleting and re-adding the row did by hand. Wired to the bar's reconnect
// button and to ComfyUI's own R refresh; quiet mode only toasts when it
// actually repaired something.
async function runReconnect(state, { quiet = false } = {}) {
  let list;
  try {
    list = await fetchLoraList();
  } catch {
    if (!quiet) loraToast("Could not refresh the LoRA list.");
    return;
  }
  state.available = list;
  state.nameStatus = new Map();
  let repaired = 0;
  const rows = state.rows.map((row) => {
    if (!row.name) return row;
    const fit = resolveLoraName(row.name, list);
    if (fit.status !== "remapped") return row;
    repaired += 1;
    rangeCache.delete(row.name);
    return { ...row, name: fit.name };
  });
  const unresolved = rows.filter(
    (row) => row.name && resolveLoraName(row.name, list).status !== "exact",
  ).length;
  if (repaired) {
    commitRows(state, rows, { structural: true });
    notifyQgChange();
  } else {
    decorateRows(state);
  }
  if (!quiet || repaired) {
    const lead = repaired
      ? zhCount("Reconnected {n} LoRA path", "Reconnected {n} LoRA paths", repaired)
      : zh("LoRA list refreshed");
    if (unresolved) {
      loraToast(`${lead}${zhSep()}${zhCount("{n} row still missing", "{n} rows still missing", unresolved)}`);
    } else {
      loraToast(repaired ? `${lead}${zhEnd()}` : `${lead}${zhSep()}${zh("every row points at a real file")}`);
    }
  }
}

function loraToast(detail) {
  showToast({ summary: "LoRA Loader", detail, life: 7000 });
}

async function runImportChain(state) {
  // A bypassed or muted loader is not shaping the current render; importing
  // its rows would change the image. Leave it alone.
  const isActive = (loader) =>
    loader.mode !== BYPASS_MODE && loader.mode !== MUTE_MODE;
  const upstream = collectUpstreamLoaders(state.node);
  const downstream = collectDownstreamLoaders(state.node);
  const issue = absorbChainIssue(state.node, upstream, downstream);
  if (issue) { loraToast(issue); return; }
  const activeUp = upstream.filter(isActive);
  const activeDown = downstream.filter(isActive);
  const sources = [...activeUp, ...activeDown];
  // A snapshot cannot reproduce values calculated by another node at run time.
  if (sources.some((loader) => loader.inputs?.some((input) => input.link != null
      && !["MODEL", "CLIP"].includes(String(input.type).toUpperCase())))) {
    loraToast("A source loader has linked LoRA settings. Disconnect those settings before absorbing; source loaders remain active.");
    return;
  }
  const entriesOf = (loader) => loaderLoraEntries({
    type: String(loader.type ?? loader.comfyClass ?? ""),
    widgets: (loader.widgets ?? []).map((widget) => ({
      name: widget.name,
      value: widget.value,
    })),
  })?.map(row => ({ ...row, strength_clip: loader.inputs?.some(input =>
    String(input.type).toUpperCase() === "CLIP" && input.link != null) ? row.strength_clip : 0 })) ?? [];
  // Upstream walks nearest-first, so reversed = the order the chain applies
  // them; downstream nearest-first already IS its apply order.
  const upEntries = activeUp.slice().reverse().flatMap(entriesOf);
  const downEntries = activeDown.flatMap(entriesOf);
  if (!upEntries.length && !downEntries.length) {
    loraToast(importSummary({}));
    return;
  }
  let available = [];
  try {
    available = await fetchLoraList();
    state.available = available;
    state.nameStatus = new Map();
  } catch {
    // Offline: names import verbatim; the rows tint and the run-time
    // resolver gets the next chance.
  }
  let remapped = 0;
  let missing = 0;
  let ambiguous = 0;
  const resolve = (item) => {
    if (!available.length) return { ...item };
    const fit = resolveLoraName(item.name, available);
    if (fit.status === "remapped") remapped += 1;
    else if (fit.status === "missing") missing += 1;
    else if (fit.status === "ambiguous") ambiguous += 1;
    return { ...item, name: fit.name };
  };
  const upResolved = upEntries.map(resolve);
  const downResolved = downEntries.map(resolve);
  // Preserve upstream → this stack → downstream application order, including
  // repeated files: the same LoRA in two loaders represents two applications.
  const upMerge = mergeImportedRows(state.rows, upResolved,
    { position: "before", deduplicate: false });
  const downMerge = mergeImportedRows(upMerge.rows, downResolved,
    { position: "after", deduplicate: false });
  // Never bypass a source if any of its rows would be lost to the stack limit.
  if (state.rows.length + upMerge.added + downMerge.added > MAX_ROWS) {
    loraToast(`Absorb needs more than ${MAX_ROWS} rows. Free some stack rows first; source loaders remain active.`);
    return;
  }
  // Imported rows keep whatever strength mode the node is already in: new
  // nodes start unified, so the CLIP box stays hidden unless the user turns
  // on "Separate model / CLIP strength" in Settings (2026-10-12 user request:
  // importing must not flip the view by itself).
  const absorbed = [...activeUp, ...activeDown];
  for (const loader of absorbed) loader.mode = BYPASS_MODE;
  commitRows(state, downMerge.rows, { structural: true });
  fitNode(state);
  notifyQgChange();
  loraToast(importSummary({
    added: upMerge.added + downMerge.added,
    skipped: upMerge.skipped + downMerge.skipped,
    bypassed: absorbed.length,
    remapped,
    missing,
    ambiguous,
  }));
}

function openSettings(state, anchor) {
  // The import action rides the gear menu but is per-node and one-shot, so
  // the schema is composed per call; persistence still uses SETTINGS_SCHEMA.
  const menuSchema = [
    ...SETTINGS_SCHEMA,
    {
      key: "_import_chain",
      label: "Absorb chain LoRAs",
      type: "action",
      button: "Absorb",
      hint: "Pull every LoRA loader wired into this node's model chain - "
        + "upstream and downstream - into this stack and bypass those "
        + "nodes; the graph keeps computing the same thing.",
      onAction: () => {
        closeSettingsMenu();
        runImportChain(state);
      },
    },
  ];
  // Inside a subgraph the rows can show on the box's face instead; first in
  // the menu there, since it is what a loader in a box is usually set up for.
  if (state.node.graph?.isRootGraph === false) {
    const onBox = Boolean(rowsInputName(state.node));
    menuSchema.unshift({
      key: "_box_rows",
      label: zh("Rows on the box"),
      type: "action",
      button: onBox ? zh("Take back") : zh("Show"),
      hint: onBox
        ? zh("The rows show on the box this subgraph sits in. Take back puts them "
          + "inside this loader again, as the box you came in through holds them; "
          + "every copy of the box then runs those rows.")
        : zh("Show these rows on the face of the box this subgraph sits in, where "
          + "they can be switched on and off and set by Workflow Switches. Each "
          + "copy of the box keeps its own rows."),
      onAction: () => {
        closeSettingsMenu();
        if (onBox) rowsBackInside(state);
        else showRowsOnBox(state);
      },
    });
  }
  openSettingsMenu({
    scope: SETTINGS_SCOPE,
    schema: menuSchema,
    anchor: anchor.getBoundingClientRect(),
    title: zh("LoRA Loader settings"),
    // The menu reflects THIS node's live state where the two overlap.
    initial: {
      ...state.settings,
      separate_strengths: !linked(state),
      ...(state.separatorWidget ? { separator: state.separatorWidget.value } : {}),
      ...(state.onMissingWidget
        ? { strict_missing: state.onMissingWidget.value === "error" }
        : {}),
    },
    onChange: (values, key) => {
      state.settings = values;
      // Two settings also steer this node's own serialized state, so the
      // change takes effect here immediately, not just on future nodes.
      if (key === "separate_strengths" || key === null) {
        state.node.properties.qgLoraLinked = !values.separate_strengths;
        if (!values.separate_strengths) {
          commitRows(
            state,
            state.rows.map((row) => ({ ...row, strength_clip: row.strength })),
          );
        }
      }
      if ((key === "separator" || key === null) && state.separatorWidget) {
        state.separatorWidget.value = values.separator;
      }
      if ((key === "strict_missing" || key === null) && state.onMissingWidget) {
        state.onMissingWidget.value = values.strict_missing ? "error" : "skip";
      }
      renderRows(state);
      fitNode(state);
      notifyQgChange();
    },
  });
}

function renderRows(state) {
  const panel = state.panel;
  // The rebuild below drops focus. It is put back only for keyboard focus:
  // after a mouse click on a switch the keys stay with ComfyUI, as before.
  const focused = panel.contains(document.activeElement) && showsKeyboardFocus(document.activeElement)
    ? document.activeElement : null;
  const focusedRow = focused?.closest?.(".qgtools-lora-row") ?? null;
  const focusedRowId = focusedRow?.dataset.rowId;
  const focusedIndex = focusedRow ? [...panel.querySelectorAll(".qgtools-lora-row")].indexOf(focusedRow) : -1;
  const wasAddFocused = Boolean(focused?.matches?.(".qgtools-lora-add, .qgtools-lora-blank"));
  panel.textContent = "";
  const body = el("div", "qgtools-lora-body");
  panel.append(body);

  const addRowAndPick = (event) => {
    // detail is 0 for a click made with Enter or Space.
    openPicker(state, null, event.currentTarget, { keyboard: event.detail === 0 });
  };

  const bar = el("div", "qgtools-lora-bar");
  const overall = toggleAllState(state.rows);
  const master = el(
    "button",
    `qgtools-lora-toggle qgtools-lora-master${overall === "on" ? " on" : overall === "mixed" ? " mixed" : ""}`
  );
  master.type = "button";
  master.title = "Toggle every LoRA: mixed saves your setup and turns all on; "
    + "on turns all off; off brings your saved setup back";
  // The master pill remembers the mixed setup it destroys,
  // so an accidental click is always one more click from home.
  master.addEventListener("click", () => {
    const cycled = cycleMasterToggle(state.rows, state.toggleSnapshot);
    state.toggleSnapshot = cycled.snapshot;
    commitRows(state, cycled.rows, { structural: true });
  });
  const templates = el("button", "qgtools-lora-gear", "▤");
  templates.type = "button";
  templates.title = zh("LoRA templates: save this stack, or apply a saved one");
  templates.addEventListener("click", () => openTemplates(state, templates));
  const recheck = el("button", "qgtools-lora-gear");
  recheck.type = "button";
  recheck.title = zh("Re-check LoRA files: refresh the list and reconnect rows whose files moved or came back");
  recheck.innerHTML = reloadIconSvg();
  recheck.addEventListener("click", () => runReconnect(state));
  const gear = el("button", "qgtools-lora-gear");
  gear.type = "button";
  gear.title = zh("LoRA Loader settings");
  gear.innerHTML = gearIconSvg();
  gear.addEventListener("click", () => openSettings(state, gear));
  const group = el("div", "qgtools-lora-bargroup");
  const summary = el("span", "qgtools-lora-summary", summarizeRows(state.rows));
  const sumWord = el("span", "qgtools-lora-sumword", "enabled");
  summary.append(sumWord);
  sumWord.hidden = !state.rows.some((row) => row.name);
  // On a box only the rows themselves: templates and the settings stay on
  // the loader inside.
  if (state.box) group.append(master, summary, recheck);
  else group.append(templates, master, summary, recheck, gear);
  bar.append(group);
  body.append(bar);
  panel.classList.toggle("readonly", Boolean(state.readOnly));
  if (state.note) {
    const note = el("div", "qgtools-lora-onbox", state.note);
    note.title = state.note;
    body.append(note);
  }

  const stack = el("div", "qgtools-lora-stack");
  if (!state.rows.length) {
    const blank = el("button", "qgtools-lora-blank", "No LoRAs yet");
    blank.type = "button";
    blank.title = zh("Add a LoRA");
    blank.addEventListener("click", addRowAndPick);
    stack.append(blank);
  }

  state.rows.forEach((row, index) => {
    const rowElement = el("div", "qgtools-lora-row");
    rowElement.tabIndex = 0;
    rowElement.dataset.rowId = row.id;
    rowElement.setAttribute("role", "group");
    rowElement.setAttribute("aria-label", row.name || zh("Empty LoRA row"));
    rowElement.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Space Enter Escape");
    rowElement.title = zh("Up/Down chooses a row, Space toggles it, and Left/Right changes strength. Hold Shift for smaller steps; Enter picks a file.");
    if (!row.enabled) rowElement.classList.add("off");

    const grip = el("button", "qgtools-lora-grip");
    grip.type = "button";
    grip.title = zh("Drag to reorder");
    grip.innerHTML = gripIconSvg();
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || state.rows.length < 2) return;
      event.preventDefault();
      hideHoverThumb();
      rowElement.classList.add("dragging");
      let current = index;
      const abort = new AbortController();
      const rowElements = () => Array.from(stack.querySelectorAll(".qgtools-lora-row"));
      const onMove = (moveEvent) => {
        const elements = rowElements();
        const centers = elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
        const target = hoverRowIndex(centers, moveEvent.clientY);
        if (target === current || target < 0) return;
        // Live preview shuffles only the DOM; the serialized stack changes
        // once, on drop, so an abandoned drag never dirties the widget.
        if (target > current) elements[target].after(rowElement);
        else elements[target].before(rowElement);
        current = target;
      };
      const finish = (commit) => {
        abort.abort();
        rowElement.classList.remove("dragging");
        if (current === index) return;
        grip.dataset.qgDragged = "1";
        if (commit) commitRows(state, reorderRows(state.rows, index, current), { structural: true });
        else renderRows(state);
      };
      // The gesture listens on the window, capture phase - never through
      // setPointerCapture on the grip. The preview above reparents the row,
      // and a reparent removes the grip from the document for an instant,
      // which silently releases its pointer capture: the pointerup then
      // never reached the grip, the drop never committed, and the row rode
      // the cursor until the next render snapped it back.
      window.addEventListener("pointermove", onMove, { capture: true, signal: abort.signal });
      window.addEventListener("pointerup", () => finish(true), { capture: true, signal: abort.signal });
      window.addEventListener("pointercancel", () => finish(false), { capture: true, signal: abort.signal });
    });
    // A click on the lock of a row a switch sets takes the row over (a drag
    // that moved the row is no click).
    grip.addEventListener("click", () => {
      if (grip.dataset.qgDragged) {
        delete grip.dataset.qgDragged;
        return;
      }
      takeRowOver(state, index);
    });

    const toggle = el("button", `qgtools-lora-toggle${row.enabled ? " on" : ""}`);
    toggle.type = "button";
    toggle.title = zh("Enable or disable this LoRA");
    // The pill only shows its state by colour and position.
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(row.enabled));
    toggle.addEventListener("click", () => {
      const rows = state.rows.map((entry, i) =>
        i === index ? { ...entry, enabled: !entry.enabled } : entry
      );
      // Every hand-made toggle refreshes the master pill's memory.
      state.toggleSnapshot = snapshotEnabled(rows);
      commitRows(state, rows, { structural: true });
    });

    const name = el("button", "qgtools-lora-name");
    name.append(row.name
      ? nameLabel(rowLabel(state, row.name))
      : el("span", "qgtools-lora-label", "choose a LoRA..."));
    // The visible text may be shortened; a screen reader gets the whole name.
    if (row.name) name.setAttribute("aria-label", rowLabel(state, row.name));
    name.type = "button";
    name.title = row.name || zh("Pick a LoRA from models/loras");
    if (!row.name) name.classList.add("empty");
    // The name is also a scrub surface - the bar behind it
    // makes it the natural drag target for model strength. The shared dead
    // zone keeps a plain click a click, which still opens the picker; a
    // scrub that ends on the button swallows the click it fires.
    let nameDrag = null;
    name.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !row.name
          || state.settings?.name_scrub === false) return;
      nameDrag = { x: event.clientX, y: event.clientY,
                   start: state.rows[index].strength, scrubbed: false };
      name.setPointerCapture(event.pointerId);
    });
    name.addEventListener("pointermove", (event) => {
      if (!nameDrag) {
        showHoverThumb(state, row.name, event.clientX, event.clientY);
        return;
      }
      const dx = event.clientX - nameDrag.x;
      const dy = event.clientY - nameDrag.y;
      if (!nameDrag.scrubbed && isScrubbing(dx, dy)) {
        nameDrag.scrubbed = true;
        hideHoverThumb();
      }
      if (nameDrag.scrubbed) {
        commitRows(state, setStrength(
          state.rows,
          index,
          scrubValue(nameDrag.start, dx, event.shiftKey, state.settings?.step),
          linked(state),
        ), { record: false });
      }
    });
    const endNameDrag = (event) => {
      if (!nameDrag) return;
      try { name.releasePointerCapture(event.pointerId); } catch {}
      if (nameDrag.scrubbed) {
        name.dataset.qgScrubbed = "1";
        notifyQgChange();
      }
      nameDrag = null;
    };
    name.addEventListener("pointerup", endNameDrag);
    name.addEventListener("pointercancel", endNameDrag);
    name.addEventListener("click", (event) => {
      if (name.dataset.qgScrubbed) {
        delete name.dataset.qgScrubbed;
        return;
      }
      openPicker(state, index, name, { keyboard: event.detail === 0 });
    });
    name.addEventListener("pointerenter", (event) =>
      showHoverThumb(state, row.name, event.clientX, event.clientY));
    name.addEventListener("pointerleave", hideHoverThumb);

    rowElement.append(grip, toggle, name, strengthBox(state, index, "strength"));
    if (!linked(state)) rowElement.append(strengthBox(state, index, "strength_clip"));

    const info = el("button", "qgtools-lora-info", "i");
    info.type = "button";
    info.title = zh("Preview, base model, and trigger words");
    info.addEventListener("click", () => openInfo(state, index, info));
    rowElement.append(info);

    rowElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openRowMenu(state, index, event);
    });
    stack.append(rowElement);
  });
  // The add button lives INSIDE the stack container and pins to its bottom
  // edge (margin-top: auto), so it stays put however tall the node is
  // dragged - the stack absorbs the free height above it.
  const actions = el("div", "qgtools-lora-actions");
  const add = el("button", "qgtools-lora-add", "+ LoRA");
  add.type = "button";
  // Lost in the port from upstream: without this the + button has no hint.
  add.title = zh("Pick one LoRA, or click a folder name to add all its LoRAs.");
  add.disabled = state.rows.length >= MAX_ROWS;
  add.addEventListener("click", addRowAndPick);
  actions.append(add);
  stack.append(actions);
  body.append(stack);
  if (focusedRowId) {
    const index = state.rows.findIndex((row) => row.id === focusedRowId);
    focusStackRow(state, index >= 0 ? index : Math.min(focusedIndex, state.rows.length));
  } else if (wasAddFocused) focusStackRow(state, state.rows.length);
  decorateRows(state);
  state.lockSignature = null;
  refreshLocks(state);
  // Names refit whenever the stack's box changes - the node was resized,
  // or the panel was laid out for the first time. The first observation
  // arrives before the next paint, so an unfitted name never shows.
  state.nameObserver ??= new ResizeObserver(() => {
    holdVueNodeMinWidth(state.panel, panelMinWidth(state));
    fitRowNames(state);
  });
  state.nameObserver.disconnect();
  state.nameObserver.observe(stack);
}

// Rows cut a long name at the end (the label's CSS ellipsis) unless the
// gear's "Long names" asks for the middle. The picker always keeps the end
// in view: that is where a search tells checkpoints apart.
function fitRowNames(state) {
  const labels = state.panel.querySelectorAll(".qgtools-lora-name > [data-qg-full]");
  if (state.settings?.name_cut === "middle") {
    fitLabels(labels);
    return;
  }
  for (const label of labels) {
    if (label.textContent !== label.dataset.qgFull) label.textContent = label.dataset.qgFull;
  }
}

// ---------- rows on a box ----------

// The box the user last came in through, per subgraph. An inner loader
// whose rows are set on the box follows that box's copy of them.
const enteredBoxes = new WeakMap();
function watchEnteredBoxes() {
  const canvas = app.canvas?.canvas;
  if (!canvas || canvas.__qgLoraEntered) return;
  canvas.__qgLoraEntered = true;
  canvas.addEventListener("subgraph-opened", (event) => {
    const { subgraph, fromNode } = event.detail ?? {};
    if (subgraph && fromNode) enteredBoxes.set(subgraph, fromNode);
  });
}

function rootGraph() {
  return app.rootGraph ?? app.graph;
}

function isLoader(node) {
  return node?.type === NODE_CLASS || node?.comfyClass === NODE_CLASS;
}

function boxTitle(box) {
  return String(box?.title || "the box").replace(/\s*🆎\s*$/u, "");
}

// Where a card's rows are kept, and so what it shows and edits:
// - a box card: the box's own copy of the rows of its loader inside;
// - a loader whose rows come in from its box: that box's copy, when it is
//   known which box (the one the user came in through, or the only one),
//   else its own rows, read only, since each box sets its own;
// - any other loader: its own rows.
// `owner` is the node and control a Workflow Switches switch addresses.
function rowsSource(state) {
  const node = state.node;
  if (state.box) {
    return { widget: boxRowsWidget(node, state.box.inputName), owner: { node, name: state.box.inputName } };
  }
  const own = node.widgets?.find((item) => item.name === "loras") ?? null;
  const fed = rowsInputName(node);
  if (!fed) return { widget: own, owner: { node, name: "loras" } };
  const box = hostBox(node.graph, boxesOf(node.graph, workflowNodes(rootGraph())), enteredBoxes.get(node.graph));
  const widget = box && boxRowsWidget(box, fed);
  if (!widget) {
    return {
      widget: own, owner: { node, name: "loras" }, readOnly: true,
      note: zh("Each box that holds this subgraph sets these rows on its face."),
    };
  }
  // Single quotes on purpose: the box title sits between the two halves, so
  // the two halves are separate dictionary keys, and keeping each literal
  // verbatim (no \" escapes) is what lets verify_i18n.py match them.
  return { widget, owner: { node: box, name: fed }, note: zh('These rows are set on the box "') + boxTitle(box) + zh('".') };
}

// Follow the rows to wherever they are kept now. Returns true when the card
// was drawn again.
function syncRows(state) {
  // The rows slot must keep a place of its own on the node face (see
  // placeWidgetSlots); the frontend can re-lay-out the node at any time, so
  // this rides the same sync that already follows the card.
  if (placeWidgetSlots(state.node)) state.node.setDirtyCanvas?.(true, true);
  const source = rowsSource(state);
  const widget = source.widget;
  if (!widget) return false;
  // The box's raw copy hides under its card; the frontend may hand the box
  // a new copy object at any time (a reload, an undo).
  if (state.box) hideWidget(widget);
  const moved = widget !== state.widget || source.note !== state.note
    || Boolean(source.readOnly) !== Boolean(state.readOnly)
    || source.owner.node !== state.owner?.node || source.owner.name !== state.owner?.name;
  state.widget = widget;
  state.owner = source.owner;
  state.readOnly = Boolean(source.readOnly);
  state.note = source.note;
  if (!moved && widget.value === state.renderedValue) return false;
  state.rows = parseRows(widget.value);
  state.renderedValue = widget.value;
  state.toggleSnapshot = snapshotEnabled(state.rows);
  renderRows(state);
  fitNode(state);
  return true;
}

// Every card on the page, so one redraw hook can keep them current in both
// renderers (Nodes 2.0 does not draw a node on the canvas), and every box
// that is watched for rows coming up to it.
const liveCards = new Set();
const watchedBoxes = new Set();
let redrawTimer = null;
let hookedCanvas = null;
function ensureRedrawHook() {
  const canvas = app.canvas;
  if (!canvas || canvas === hookedCanvas) return;
  hookedCanvas = canvas;
  chainCallback(canvas, "onDrawForeground", () => {
    if (redrawTimer !== null) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      const shown = app.canvas?.getCurrentGraph?.() ?? app.canvas?.graph;
      for (const box of watchedBoxes) if (box.graph === shown) syncBoxCards(box);
      for (const state of liveCards) {
        if (state.node.graph !== shown) continue;
        syncRows(state);
        refreshLocks(state);
      }
    }, 250);
  });
}

// Bring a loader's rows up to its box: the frontend's own way of showing a
// setting on a box, a subgraph input linked to the rows. Every box of this
// subgraph then keeps its own copy, starting from these rows.
function showRowsOnBox(state) {
  const node = state.node;
  const subgraph = node.graph;
  const slot = node.inputs?.find((input) => input.name === "loras");
  const inputNode = subgraph?.inputNode;
  if (!slot || typeof inputNode?.connectByType !== "function" || typeof subgraph.removeInput !== "function") {
    loraToast(zh("This ComfyUI version cannot show the rows on the box."));
    return;
  }
  const before = new Set(subgraph.inputs ?? []);
  // -1 makes a new subgraph input for the first input of this type, which
  // on this node is the rows (the inputs only ever grow at the end).
  inputNode.connectByType(-1, node, slot.type || "STRING");
  const added = (subgraph.inputs ?? []).find((input) => !before.has(input));
  if (!added || rowsInputName(node) !== added.name) {
    if (added) subgraph.removeInput(added);
    loraToast(zh("The rows could not be shown on the box."));
    return;
  }
  for (const box of boxesOf(subgraph, workflowNodes(rootGraph()))) syncBoxCards(box);
  syncRows(state);
  app.canvas?.setDirty?.(true, true);
  notifyQgChange();
  loraToast(zh("The rows now show on the box. Each copy of the box keeps its own rows."));
}

// Put the rows back inside the loader. It keeps the rows of the box the
// user came in through; every copy of the box runs those from then on.
function rowsBackInside(state) {
  const node = state.node;
  const subgraph = node.graph;
  const name = rowsInputName(node);
  const input = (subgraph?.inputs ?? []).find((item) => item.name === name);
  if (!input) return;
  const own = node.widgets?.find((item) => item.name === "loras");
  const shown = rowsSource(state).widget;
  const keep = shown && shown !== own ? shown.value : null;
  // A box whose input is wired from outside keeps its input; only the link
  // inside goes, as the frontend does it.
  const wired = boxesOf(subgraph, workflowNodes(rootGraph())).some((box) => {
    const index = (box.inputs ?? []).findIndex((item) => item.name === name);
    return index >= 0 && box.isInputConnected?.(index);
  });
  if (wired) input.disconnect();
  else subgraph.removeInput(input);
  if (own && typeof keep === "string") own.value = keep;
  syncRows(state);
  app.canvas?.setDirty?.(true, true);
  notifyQgChange();
  loraToast(zh("The rows are back inside the loader."));
}

// A box shows one card for each loader inside whose rows came up to it.
function syncBoxCards(box) {
  if (!box?.isSubgraphNode?.() || !box.graph) return;
  box.__qgLoraCards ??= new Map();
  const cards = box.__qgLoraCards;
  const wanted = new Set();
  for (const { name, loader } of boxRowInputs(box, isLoader)) {
    if (!boxRowsWidget(box, name)) continue;
    wanted.add(name);
    const card = cards.get(name);
    if (card) card.box.loader = loader;
    else {
      const state = mountCard(box, { box: { inputName: name, loader } });
      if (state) cards.set(name, state);
    }
  }
  for (const [name, state] of cards) {
    if (wanted.has(name)) continue;
    cards.delete(name);
    unmountCard(state);
  }
}

function watchBox(box) {
  if (!box?.isSubgraphNode?.() || box.__qgLoraWatch) return;
  const abort = new AbortController();
  box.__qgLoraWatch = abort;
  watchedBoxes.add(box);
  const later = () => requestAnimationFrame(() => syncBoxCards(box));
  for (const type of ["widget-promoted", "widget-demoted", "input-added", "removing-input"]) {
    box.subgraph?.events?.addEventListener?.(type, later, { signal: abort.signal });
  }
  chainCallback(box, "onConfigure", later);
  chainCallback(box, "onRemoved", () => {
    abort.abort();
    watchedBoxes.delete(box);
    for (const state of box.__qgLoraCards?.values() ?? []) unmountCard(state, { resize: false });
    box.__qgLoraCards?.clear();
  });
  later();
}

function unmountCard(state, { resize = true } = {}) {
  liveCards.delete(state);
  state.disposed = true;
  unwatchVueShell(state.node, state.box?.inputName ?? "rows");
  state.nameObserver?.disconnect();
  closePopup();
  try {
    state.node.removeWidget?.(state.domWidget);
  } catch {
    state.domWidget?.onRemove?.();
  }
  if (resize) {
    state.node.setSize?.([state.node.size[0], state.node.computeSize?.()[1] ?? state.node.size[1]]);
    state.node.setDirtyCanvas?.(true, true);
  }
}

// ---------- node install ----------

// The row card, on a LoRA Loader or on a box that holds one (`box`:
// { inputName, loader }). Returns its state.
function mountCard(node, { box = null, separatorWidget = null, onMissingWidget = null } = {}) {
  installStyles();
  const settings = loadSettings(SETTINGS_SCOPE, SETTINGS_SCHEMA);
  // Unified strengths are the hard default: separate_strengths is per-node
  // (persist:false in the schema), so any stored value is legacy noise from
  // before it stopped persisting - never a reason to split a fresh node.
  settings.separate_strengths = false;
  const panel = el("div", "qgtools-lora-panel");
  // A box card sits under the box's own slots: a box's slots are whatever
  // its subgraph has, so there is no empty band to climb into.
  const reclaim = box ? 0 : BAND_RECLAIM;
  const state = { node, box, widget: null, owner: null, panel, rows: [], settings, renderedValue: null, reclaim,
    lockSignature: null, separatorWidget: null, onMissingWidget: null, domWidget: null, disposed: false };
  const source = rowsSource(state);
  if (!source.widget) return null;
  state.widget = source.widget;
  state.owner = source.owner;
  state.note = source.note;
  state.readOnly = Boolean(source.readOnly);
  if (box) hideWidget(source.widget);
  state.rows = parseRows(state.widget.value);
  state.renderedValue = state.widget.value;
  state.toggleSnapshot = snapshotEnabled(state.rows);
  installStackKeyboard(state);
  if (!box && node.properties && node.properties.qgLoraLinked === undefined) {
    node.properties.qgLoraLinked = true;
  }
  state.separatorWidget = separatorWidget;
  // A missing file reads the way its loader is set to treat it.
  state.onMissingWidget = box ? box.loader?.widgets?.find((item) => item.name === "on_missing") : onMissingWidget;
  if (box && state.onMissingWidget) hideWidget(state.onMissingWidget);

  const domWidget = node.addDOMWidget(box ? `qg_lora_rows:${box.inputName}` : "qg_lora_rows", "qg_lora_rows", panel, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => panelHeight(state) + WIDGET_FRAME - reclaim,
  });
  keepDomWidgetWidthAuto(domWidget);
  // Not saved with the workflow either: options.serialize only keeps it out
  // of the prompt, and saved values come back by position.
  domWidget.serialize = false;
  state.domWidget = domWidget;
  // fillNodeHeight, not a pinned computeSize: the panel joins the layout's
  // free-space split, follows the node when it is dragged taller (the add
  // button stays on the bottom edge), and a floor that carries WIDGET_FRAME
  // guarantees the element box never comes up short of the rows. The width
  // minimum rides the same call so the node cannot shrink to where the row's
  // fixed-width controls would hang past its right edge. The floor sheds
  // the reclaimed pixels because they come out of the slot band, not out of
  // the space below it. exactMinWidth: the floor is the node's own width,
  // without the frontend's padding on top (panel_layout.mjs), so a compact
  // stack really goes down to it.
  fillNodeHeight(domWidget, {
    minWidth: () => panelMinWidth(state),
    minHeight: () => panelHeight(state) + WIDGET_FRAME - reclaim,
    minNodeSize: [PANEL_MIN_WIDTH, 160],
    exactMinWidth: true,
  });
  if (reclaim) {
    // Climb the panel up into the slot band. The layout
    // assigns this widget a y below the last output slot and a height from
    // the free-space split; these getters show the element BAND_RECLAIM
    // higher and taller than assigned, in canvas units, so the offset scales
    // with zoom and the panel's bottom edge stays exactly where the layout
    // put it. Writes keep landing in the backing values, so the layout's own
    // accounting never sees the shift.
    let assignedY = Number(domWidget.y) || 0;
    Object.defineProperty(domWidget, "y", {
      configurable: true,
      get: () => Math.max(14, assignedY - reclaim),
      set: (value) => { assignedY = Number(value) || 0; },
    });
    // The wrapper's height still comes from the layout (its computedHeight
    // feeds node sizing, so it cannot be inflated without a feedback loop);
    // the y pin moves the whole box up, leaving it reclaim short at the
    // bottom. The panel stretches past its wrapper by exactly that much -
    // inner CSS pixels are pre-transform canvas units, so this stays correct
    // at every zoom.
    panel.style.height = `calc(100% + ${reclaim}px)`;
  }

  // Nodes 2.0：外壳只有下限，面板一长就把节点顶高。Vue 里槽行是独立几行 DOM、
  // 还带内边距，比经典版式多占几十像素，所以两手一起：先用节点高度给面板加上限
  // （面板永远不超过节点给它的空间），再让 size 跟上外壳 —— 最后剩下的是面板
  // 自己的 min-height 地板（列表至少要看得到几行），那点差额只有 4px，交给 size。
  const panelOf = () => state.domWidget?.element ?? panel;
  const syncPanelFit = () => {
    if (!pinPanelToNodeHeight(node, panelOf(), (state.vueFit ??= {}))) return;
    fitNodeToPanelHeight(node, panelOf(), state.vueFit);
  };
  watchVueShell(node, panelOf, syncPanelFit, box?.inputName ?? "rows");

  renderRows(state);
  refreshAvailable(state);
  placeWidgetSlots(node);
  node.setSize?.([Math.max(336, node.size?.[0] || 336), node.computeSize?.()[1] || 220]);
  liveCards.add(state);
  ensureRedrawHook();

  // Workflow restore and undo may commit values after onConfigure. Reconcile
  // from the widget after that commit and before the next visible frame.
  const sync = () => { if (!state.disposed) syncRows(state); };
  chainCallback(node, "onConfigure", function () {
    queueMicrotask(() => { sync(); if (!state.disposed) refreshAvailable(state); });
    requestAnimationFrame(() => { sync(); if (!state.disposed) fitNode(state); });
  });
  chainCallback(node, "onDrawForeground", sync);
  // Another node may rewrite the rows (the Workflow Note's Use it, a
  // Workflow Switches switch). Nodes 2.0 does not draw this node on the
  // canvas, so follow the change itself.
  chainCallback(node, "onWidgetChanged", function (name) {
    if (name === state.widget?.name || name === "loras") sync();
  });
  chainCallback(node, "onRemoved", () => {
    liveCards.delete(state);
    closePopup();
    state.nameObserver?.disconnect();
  });
  // ComfyUI's R refresh re-reads node definitions; ride it so files that
  // moved or came back reconnect without touching the node by hand.
  chainCallback(node, "refreshComboInNode", function () {
    if (!state.disposed) runReconnect(state, { quiet: true });
  });
  return state;
}

function installLoraNode(node) {
  const widget = node.widgets?.find((item) => item.name === "loras");
  if (!widget) return;
  hideWidget(widget);
  if (node.properties && node.properties.qgLoraLinked === undefined) {
    node.properties.qgLoraLinked = true;
  }
  const settings = loadSettings(SETTINGS_SCOPE, SETTINGS_SCHEMA);
  // The separator rides a hidden standard widget so save/load and the API
  // format see it; a workflow restore overwrites this seed right after.
  const separatorWidget = node.widgets?.find((item) => item.name === "trigger_separator");
  if (separatorWidget) {
    hideWidget(separatorWidget);
    separatorWidget.value = settings.separator;
  }
  // Same arrangement for the missing-file policy: a hidden standard combo
  // carries "skip" | "error" through save/load and the API format.
  const onMissingWidget = node.widgets?.find((item) => item.name === "on_missing");
  if (onMissingWidget) {
    hideWidget(onMissingWidget);
    onMissingWidget.value = settings.strict_missing ? "error" : "skip";
  }
  const state = mountCard(node, { separatorWidget, onMissingWidget });
  if (state) node.__qgLoraState = state;
}

app.registerExtension({
  name: "QG.LoraLoader",
  setup() {
    watchEnteredBoxes();
    ensureRedrawHook();
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    hideInputsInDef(nodeData, ["loras", "trigger_separator", "on_missing"]);
    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      installLoraNode(this);
    });
    chainCallback(nodeType.prototype, "onConfigure", function () {
      resetUnknownValues(this.widgets, RESET_UNKNOWN);
    });
  },
  // A box (subgraph node) shows the rows of a loader inside once they come
  // up to it, from the loader's gear or the frontend's own widget list.
  nodeCreated(node) {
    if (node?.isSubgraphNode?.()) watchBox(node);
  },
  loadedGraphNode(node) {
    if (node?.isSubgraphNode?.()) watchBox(node);
  },
});

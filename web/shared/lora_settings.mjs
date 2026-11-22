// LoRA 加载器与 LoRA 堆共用的齿轮设置表。
//
// scope 固定为 "lora_loader"：用户 2026-11-20 明确要求两个节点共用同一份
// 偏好，改一处就一起生效。separate_strengths 是 per-node 的（persist:false），
// 由各节点自己的 properties.qgLoraLinked 决定，不写进这份持久化表。
//
// 🔴 这份表以前只住在 web/lora_loader/index.js。两个节点都要开同一个设置面板，
// 必须只有这一份真相源，否则改了步长 / 分隔符只影响其中一个节点。

export const LORA_SETTINGS_SCOPE = "lora_loader";

export const LORA_SETTINGS_SCHEMA = [
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
    hint: "Two strength boxes per row on this node. New nodes always start unified.",
  },
  {
    key: "strength_bars", label: "Strength bars", type: "toggle",
    default: true,
    hint: "Center-zero bar behind each name: teal grows right for positive strength, red grows left for negative, scaled so the stack's largest magnitude spans the field (never less than 1.0).",
  },
  {
    key: "separator", label: "Trigger word separator", type: "text",
    default: ", ", placeholder: '", "',
    hint: "Joins the triggers output. This node now, new nodes later.",
  },
  {
    key: "strict_missing", label: "Stop on missing LoRA", type: "toggle",
    default: true,
    hint: "On (the default): fail the run before sampling when an enabled row's file cannot be found, with an error naming it. Off: skip that row with a console warning and render without it. This node now, new nodes later.",
  },
  {
    key: "hide_extension", label: "Hide file extension", type: "toggle",
    default: true,
    hint: "Show LoRA names without .safetensors.",
  },
  {
    key: "hide_folders", label: "Hide folder names", type: "toggle",
    default: true,
    hint: "Rows show just the file name; the full path stays in the tooltip and the picker keeps its folders.",
  },
  {
    key: "civitai_lookup", label: "Civitai lookup button", type: "toggle",
    default: true,
    hint: "Offer a Fetch Civitai info button in the info card. Clicking it asks civitai.com about that one file, from this browser, and saves the answer next to the LoRA. Nothing is sent until you click.",
  },
  {
    key: "civitai_picture", label: "Civitai picture", type: "choice",
    options: ["off", "PG-13", "any"], default: "PG-13",
    hint: "Fetch Civitai info also saves the LoRA's first picture next to the file, so hovering the LoRA shows it. PG-13 skips pictures Civitai rates R or above. A picture you already have is never replaced.",
  },
  {
    key: "name_cut", label: "Long names", type: "choice",
    options: ["end", "middle"], default: "end",
    hint: "How a row shortens a name that does not fit. middle keeps the end in view, where checkpoint numbers like _000004000 usually are.",
  },
  {
    key: "name_scrub", label: "Scrub strength on the name", type: "toggle",
    default: true,
    hint: "Drag left/right on a row's name to change its model strength - the bar rides along. A plain click still opens the picker.",
  },
  {
    key: "thumbnails", label: "Preview thumbnails", type: "toggle",
    default: true,
    hint: "Poster image beside the picker while hovering a LoRA.",
  },
];

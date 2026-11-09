// LoRA 栈的纯状态逻辑：行的规整、强度拖拽的数学、选择器的过滤与键盘模型、
// 强度条的画法、吸收整条加载链、移动过的文件如何找回、主开关的记忆。
// DOM 接线全在 web/lora_loader/index.js；这个文件零 DOM、零 ComfyUI 依赖，
// 所以 tools/_check_lora_stack.mjs 能直接跑它。

import { zhCount, zhPair, zhSep, zhEnd } from "./zh.mjs?v=2026110902";

export const STRENGTH_MIN = -10;
export const STRENGTH_MAX = 10;
export const DEFAULT_STEP = 0.05;
export const FINE_STEP = 0.01;
// 拖一个强度步长要横移多少像素：小到不费力，大到手抖点一下不会改值。
export const SCRUB_PIXELS_PER_STEP = 4;
export const SCRUB_DEAD_ZONE = 3;

let rowSerial = 0;

export function clampStrength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, number));
}

export function roundStrength(value) {
  return Math.round(clampStrength(value) * 100) / 100;
}

// 🔴 存档里的坏强度不能变成 0。`clampStrength` 把非有限值收成 0，那是给
// 拖拽用的（拖不出 NaN）；但读一个 `"abc"` 或 `null` 的强度如果也落到 0，
// 这一行的 LoRA 就静默不生效了 —— 面板上看着还在、权重却是 0。后端
// `_qg_lora_helpers.clean_strength` 对同一个坏值退回默认 1.0，两边得一致。
function keptStrength(value, fallback) {
  // 🔴 `Number(null)` 和 `Number("")` 都是 0，不是 NaN —— 少了这一句，存档里
  // 一个 `strength: null`（或者空串）会被当成「用户就是要 0」，于是这一行的
  // LoRA 静默不生效，看起来却和坏值退回默认完全不一样。
  if (value === null || value === undefined || value === "") return roundStrength(fallback);
  const number = Number(value);
  return roundStrength(Number.isFinite(number) ? number : fallback);
}

export function newRow() {
  rowSerial += 1;
  return {
    id: `r${Date.now().toString(36)}${rowSerial}`,
    name: "",
    strength: 1,
    strength_clip: 1,
    enabled: true,
    triggers: "",
  };
}

// 一行会不会真的加载：本行没被关掉，它所在的组也没被关掉。
// 与后端 `_qg_lora_helpers.loaded_rows` 是同一条判定。面板没有分组的编辑
// 界面，所以 group_off 只在「从别的插件转过来的栈」里出现 —— 但后端认它，
// 这里也得认，否则前端算出来的东西跟实际跑的对不上。
export function rowRuns(row) {
  // 没有行就没有东西会跑。`undefined !== false` 是真，不先拦一下，一行空槽
  // 也会被算成「会加载」。
  if (!row) return false;
  if (row.enabled === false || row.group_off === true) return false;
  // 第三条判据：模型强度和 CLIP 强度**都是 0** 时这行什么都不做，后端
  // loaded_rows 直接跳过、连文件都不去加载。以前这里只有前两条，注释却写着
  // 「与后端是同一条判定」—— 一行 0/0 的 LoRA 会被前端算成「会跑」。
  // 后端在没接 CLIP 时按 clip=0 算，那层前端不知道，这里按「接了 CLIP」算。
  // 缺字段不算 0（Number(undefined) 是 NaN），与后端 parse 时补默认值一致。
  const strength = Number(row.strength);
  const clip = Number(row.strength_clip);
  return !(strength === 0 && clip === 0);
}

export function normalizeRows(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => {
    const fresh = newRow();
    if (!entry || typeof entry !== "object") return fresh;
    // 🔴 未知字段原样带过。从别的插件转来的栈里带着 group / group_off，
    // 本面板不编辑分组，但后端按 group_off 决定这一行跑不跑 —— 只保留已知
    // 字段的话，用户在这里动一下强度，那两个字段就被抹掉了，后端随后会把
    // 本该关掉的组重新跑起来。存档是别人的数据，不认得的键也该原样写回。
    return {
      ...entry,
      id: typeof entry.id === "string" && entry.id ? entry.id : fresh.id,
      name: typeof entry.name === "string" ? entry.name : "",
      strength: keptStrength(entry.strength, 1),
      strength_clip: keptStrength(entry.strength_clip, keptStrength(entry.strength, 1)),
      enabled: entry.enabled !== false,
      triggers: typeof entry.triggers === "string" ? entry.triggers : "",
    };
  });
}

// 读 widget 里那段 JSON。解析失败与「本来就是空栈」不是一回事：前者是
// 别人的格式或者手改坏了，如果当成空栈处理，用户看到的是一张空面板，
// 随手加一行就把它覆盖了 —— 而那段原文他再也没见过。
// 所以另给一个能说清楚的版本，调用方拿它决定要不要在面板上提示。
export function parseRowsDetailed(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { rows: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { rows: [], error: String(error?.message ?? error) };
  }
  if (!Array.isArray(parsed)) {
    return { rows: [], error: "not an array" };
  }
  return { rows: normalizeRows(parsed), error: null };
}

export function parseRows(raw) {
  return parseRowsDetailed(raw).rows;
}

export function serializeRows(rows) {
  return JSON.stringify(rows);
}

export function reorderRows(rows, from, to) {
  if (from === to) return rows;
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) return rows;
  const next = rows.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

export function moveRow(rows, index, delta) {
  return reorderRows(rows, index, index + delta);
}

// 拖动排序的模型：给出一串行在屏幕上的纵向中心，指针落在哪个槽位。
// 越过最后一个中心就是最后一个槽位；空栈没有槽位。
export function hoverRowIndex(centers, y) {
  for (let i = 0; i < centers.length; i += 1) {
    if (y < centers[i]) return i;
  }
  return centers.length - 1;
}

// 悬停缩略图的位置：光标右下，靠近视口边缘就翻到左边，绝不出屏。
// `edge` 是缩略图最长边加上留白。
export function thumbPosition(x, y, viewportWidth, viewportHeight, edge = 188, offset = 14) {
  let left = x + offset;
  if (left + edge > viewportWidth) left = Math.max(4, x - edge - offset);
  let top = y + offset;
  if (top + edge > viewportHeight) top = Math.max(4, viewportHeight - edge);
  return { left, top };
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "";
  let value = size;
  let unit = "B";
  for (const next of ["KB", "MB", "GB", "TB"]) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  const text =
    unit === "B" ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${unit}`;
}

// 🔴 下标越界时原样返回，不能写进 next[index]。`next[index] = {...next[index]}`
// 在越界时不会报错：它把数组拉长，中间是空洞，序列化出来就是若干 `null` 行
// 加一条只有强度、没有名字的残缺行 —— 一次卡顿就够写坏存档。
// 面板已经改成按行 id 找行，这里是最后一道门。
export function setStrength(rows, index, value, linked) {
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return rows;
  const next = rows.slice();
  const row = { ...next[index], strength: roundStrength(value) };
  if (linked) row.strength_clip = row.strength;
  next[index] = row;
  return next;
}

// 拖拽模型：值跟着「指针相对按下点的横向距离」走。死区内不动，所以一次
// 普通点击还是点击。粗步长可以在齿轮菜单里配（Strength step），Shift 永远
// 走细步长。
export function scrubValue(startValue, deltaX, fine = false, coarseStep = DEFAULT_STEP) {
  if (Math.abs(deltaX) <= SCRUB_DEAD_ZONE) return roundStrength(startValue);
  const coarse = Number.isFinite(coarseStep) && coarseStep > 0 ? coarseStep : DEFAULT_STEP;
  const step = fine ? FINE_STEP : coarse;
  const travel = deltaX - Math.sign(deltaX) * SCRUB_DEAD_ZONE;
  const steps = Math.round(travel / SCRUB_PIXELS_PER_STEP);
  return roundStrength(startValue + steps * step);
}

export function isScrubbing(deltaX, deltaY) {
  return Math.abs(deltaX) > SCRUB_DEAD_ZONE && Math.abs(deltaX) >= Math.abs(deltaY);
}

export function filterLoras(names, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return names.slice();
  return names.filter((name) => name.toLowerCase().includes(needle));
}

// 选择器的键盘模型：在被过滤后的列表上维护一个高亮下标。方向键绕回，
// Home/End 跳两端，过滤变短时高亮仍有效；Enter 取高亮的名字（列表空时 null）。
export function moveHighlight(index, delta, length) {
  if (length <= 0) return -1;
  if (index < 0) return delta >= 0 ? 0 : length - 1;
  return (index + delta + length) % length;
}

export function clampHighlight(index, length) {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, length - 1);
}

export function highlightedName(names, index) {
  return index >= 0 && index < names.length ? names[index] : null;
}

// 只算行的键盘意图；DOM 焦点和提交留在面板里。加号按钮是最后一个落点，
// 下标等于行数。正在编辑的字段、输入法组合、带修饰键的快捷键都不归这里。
// onControl：按键发生在这一行自己的按钮或输入框上，不是行本身 —— 那 Enter
// 和空格归那个控件，跟任何按钮一样。
export function loraStackKeyAction(event, { index, rowCount, atAdd = false, editing = false, onControl = false }) {
  if (editing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
      || event.isComposing || event.keyCode === 229) return null;
  const current = atAdd ? rowCount : index;
  if (!Number.isInteger(rowCount) || rowCount < 0
      || !Number.isInteger(current) || current < 0 || current > rowCount) return null;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const direction = event.key === "ArrowUp" ? -1 : 1;
    return { kind: "focus", index: Math.max(0, Math.min(rowCount, current + direction)) };
  }
  // ComfyUI 在图里任何位置按下这两个键都会删掉选中的节点。栈握着键盘时
  // 把它们吞掉，于是「删掉这一行」这个动作永远不可能删掉节点。
  if (event.key === "Delete" || event.key === "Backspace") return { kind: "block" };
  if (onControl && (event.key === "Enter" || event.key === " ")) return null;
  if (event.key === "Enter") return { kind: "pick" };
  if (current === rowCount) return null;
  if (event.key === " " && !event.repeat) return { kind: "toggle" };
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    return { kind: "strength", direction: event.key === "ArrowLeft" ? -1 : 1, fine: !!event.shiftKey };
  }
  return null;
}

// 一行把自己的触发词存成一串逗号分隔的文本，而一个触发词本身可能带逗号
// （Civitai 上整句就是触发词）。所以要在文本里按「它会拆成的那一段」去找，
// 绝不能按单个片段找。
function triggerParts(text) {
  return String(text || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function findTrigger(parts, wanted) {
  if (!wanted.length) return -1;
  for (let start = 0; start + wanted.length <= parts.length; start += 1) {
    if (wanted.every((part, offset) => parts[start + offset].toLowerCase() === part.toLowerCase())) {
      return start;
    }
  }
  return -1;
}

export function hasTrigger(triggers, word) {
  return findTrigger(triggerParts(triggers), triggerParts(word)) >= 0;
}

/**
 * 幂等的「加进去」：已经在里面就原样返回。
 *
 * 🔴 信息卡的「添加自定义触发词」必须用这个，不能用 toggleTrigger ——
 * toggle 的语义是「有则拿掉」，而同一个按钮同时还在往服务端追加一份
 * 自定义词。两者语义相反就会出现：行里的词被删掉、服务端却多存了一条，
 * 点两次之后卡片上列出两个一模一样的 chip（实测存出 6 份）。
 */
export function appendTrigger(triggers, word) {
  const parts = triggerParts(triggers);
  const wanted = triggerParts(word);
  if (!wanted.length || findTrigger(parts, wanted) >= 0) return parts.join(", ");
  return parts.concat(wanted).join(", ");
}

export function toggleTrigger(triggers, word) {
  const parts = triggerParts(triggers);
  const wanted = triggerParts(word);
  let existing = findTrigger(parts, wanted);
  if (existing < 0) parts.push(...wanted);
  // 关掉时把每一份都拿掉，所以存了两次的触发词一次点击就清干净。
  for (; existing >= 0; existing = findTrigger(parts, wanted)) parts.splice(existing, wanted.length);
  return parts.join(", ");
}

export function summarizeRows(rows) {
  const on = rows.filter((row) => row.enabled && row.name).length;
  const total = rows.filter((row) => row.name).length;
  // "enabled" 那个词由调用方当独立的文本节点补上，翻译器才能把它当静态串匹配。
  return total === 0 ? "no LoRAs" : `${on} / ${total}`;
}

// 主开关模型：有名字的行全都开着是 "on"，全关是 "off"，其余是 "mixed"。
// 空行不投票。
export function toggleAllState(rows) {
  const named = rows.filter((row) => row.name);
  if (!named.length) return "off";
  const on = named.filter((row) => row.enabled).length;
  return on === 0 ? "off" : on === named.length ? "on" : "mixed";
}

// 点主开关：只要没全开就全开；已经全开就全关。
export function toggleAllRows(rows) {
  const enabled = toggleAllState(rows) !== "on";
  return rows.map((row) => (row.name ? { ...row, enabled } : row));
}

// 所有显示名共有的最长文件夹前缀（只按整段算），于是选择器里一整屏的
// "styles/wan22/x.safetensors" 读起来只剩 "x"。
export function commonFolderPrefix(names) {
  if (names.length < 2) return "";
  const split = names.map((name) => name.split("/"));
  const first = split[0];
  let depth = 0;
  while (
    depth < first.length - 1 &&
    split.every((parts) => parts.length > depth + 1 && parts[depth] === first[depth])
  ) {
    depth += 1;
  }
  return depth ? first.slice(0, depth).join("/") + "/" : "";
}

// 选择器「按文件夹浏览」用的分组：按顶层文件夹分桶，顺序按首次出现；
// 根目录下的文件归到 ""。
export function groupByFolder(names) {
  const groups = [];
  const index = new Map();
  for (const name of names) {
    const slash = name.indexOf("/");
    const folder = slash >= 0 ? name.slice(0, slash) : "";
    if (!index.has(folder)) {
      index.set(folder, { folder, names: [] });
      groups.push(index.get(folder));
    }
    index.get(folder).names.push(name);
  }
  return groups;
}

// 每个登记过的子文件夹都可选，包括只在下级有文件的父目录。文件夹顺序按
// 每条分支首次出现；每个文件夹里的文件保持服务端给的名字与顺序。只归一化
// 分隔符：大小写在 Linux 上能区分文件。
function loraPath(name) {
  return name.replaceAll("\\", "/");
}

export function loraFolders(names) {
  const tree = new Map();
  for (const name of names) {
    const parts = loraPath(name).split("/");
    let branch = tree;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const part = parts[depth];
      if (!branch.has(part)) {
        branch.set(part, { folder: parts.slice(0, depth + 1).join("/"), names: [], children: new Map() });
      }
      const entry = branch.get(part);
      entry.names.push(name);
      branch = entry.children;
    }
  }
  const folders = [];
  const visit = (branch) => {
    for (const { folder, names, children } of branch.values()) {
      folders.push({ folder, names });
      visit(children);
    }
  };
  visit(tree);
  return folders;
}

// 浏览与键盘共用一套顺序：可选的文件夹标题和文件混在一条列表里。搜索会
// 藏掉不匹配的文件，但标题仍按整个文件夹计数：点标题永远是加整个文件夹，
// 不是只加搜索结果。折叠会藏掉下级，但偏好仍留在调用方的 Set 里；搜索时
// 传一个空 Set 就能展开全部匹配。
export function loraPickerEntries(names, query = "", collapsedFolders = new Set()) {
  const tree = { entries: [], folders: new Map() };
  for (const name of names) {
    const parts = loraPath(name).split("/");
    let branch = tree;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const label = parts[depth];
      if (!branch.folders.has(label)) {
        const folder = {
          entry: { kind: "folder", name: parts.slice(0, depth + 1).join("/"), label, depth, count: 0 },
          children: { entries: [], folders: new Map() },
        };
        branch.folders.set(label, folder);
        branch.entries.push(folder);
      }
      const folder = branch.folders.get(label);
      folder.entry.count += 1;
      branch = folder.children;
    }
    branch.entries.push({ entry: { kind: "file", name, label: parts.at(-1), depth: parts.length - 1 } });
  }
  const needle = loraPath(String(query || "")).trim().toLowerCase();
  const collapsed = new Set([...collapsedFolders].map(loraPath));
  const visit = (branch) => {
    const entries = [];
    for (const { entry, children } of branch.entries) {
      if (children) {
        const descendants = visit(children);
        if (descendants.length) {
          entries.push(entry);
          if (!collapsed.has(entry.name)) entries.push(...descendants);
        }
      } else if (loraPath(entry.name).toLowerCase().includes(needle)) {
        entries.push(entry);
      }
    }
    return entries;
  };
  return visit(tree);
}

// 加一整个文件夹是一次追加，不再有行数上限。已有的行（包括重复的、关掉的
// 和空槽）原样留着。按完整路径去重，绝不按主干名或「可能是移动过的文件」
// 去猜。
export function appendFolderRows(rows, names, defaultStrength = 1) {
  const seen = new Set(rows.map((row) => loraPath(row.name)));
  const pending = [];
  let skipped = 0;
  for (const name of names) {
    const key = loraPath(name);
    if (seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    pending.push(name);
  }
  if (!pending.length) return { rows, added: 0, skipped };
  const strength = roundStrength(defaultStrength);
  const addedRows = pending.map((name) => ({ ...newRow(), name, strength, strength_clip: strength }));
  return { rows: [...rows, ...addedRows], added: addedRows.length, skipped };
}

// ---------- 模板 ----------
// 模板是行栈的一份具名快照：{ name, rows }，行里不存 id（id 是每个节点自己的
// 身份，不属于配方）。

export function templateFromRows(name, rows) {
  const label = String(name ?? "").trim();
  if (!label) return null;
  return {
    name: label,
    rows: normalizeRows(rows).map(({ id, ...rest }) => rest),
  };
}

export function applyTemplate(template) {
  return normalizeRows(template?.rows);
}

// 同名模板（不分大小写）替换、否则追加；存的时候排好序，菜单顺序就稳定。
export function upsertTemplate(list, template) {
  if (!template) return Array.isArray(list) ? list : [];
  const base = Array.isArray(list) ? list : [];
  const key = template.name.toLowerCase();
  const next = base.filter((entry) => entry?.name?.toLowerCase() !== key);
  next.push(template);
  next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return next;
}

export function removeTemplate(list, name) {
  const key = String(name ?? "").toLowerCase();
  return (Array.isArray(list) ? list : []).filter(
    (entry) => entry?.name?.toLowerCase() !== key
  );
}

export function parseTemplates(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => templateFromRows(entry?.name, entry?.rows))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// 建议范围只是建议：缺边或非有限的边界不算越界。
export function strengthOutOfRange(value, range) {
  if (!range) return false;
  const low = Number.isFinite(range.min) ? range.min : null;
  const high = Number.isFinite(range.max) ? range.max : null;
  if (low !== null && value < low) return true;
  if (high !== null && value > high) return true;
  return false;
}

// ---------- 强度条 ----------
//
// 每行的名字框背后画一条以中间为零点的条：正的模型强度往右长，负的往左长。
// 整个栈共用一个刻度，下限 1.0，于是日常的 0..1 读起来是绝对值，而某一行
// 到 2.0 会让所有条一起缩放，不会撞边截断。颜色压着，文件名仍是前景。

export const BAR_COLORS = {
  positiveFill: "rgba(0, 180, 170, 0.28)",
  positiveCap: "rgba(0, 220, 205, 0.9)",
  negativeFill: "rgba(235, 106, 96, 0.26)",
  negativeCap: "rgba(255, 138, 128, 0.9)",
  tick: "rgba(215, 221, 226, 0.30)",
  base: "#23272c",
};

// 这么接近 0 的值不画条，只留中间的刻度。
const BAR_EPSILON = 0.005;

// 条的刻度：取最大的启用强度，绝不小于 1。关掉的行变暗并退出，于是关掉一行
// 会让其余的按「还在场的最大值」重新缩放（它自己的条此刻顶在边上）。
export function strengthBarScale(rows) {
  let peak = 0;
  for (const row of rows ?? []) {
    if (!row?.name || row.enabled === false) continue;
    const value = Math.abs(Number(row.strength));
    if (Number.isFinite(value)) peak = Math.max(peak, value);
  }
  return Math.max(1, peak);
}

// 条的范围，按字段宽度的百分比算，50 就是零点。
export function strengthBarSpan(value, scale) {
  const magnitude = Math.abs(Number(value)) / (Number(scale) || 1);
  const half = 50 * Math.min(1, Number.isFinite(magnitude) ? magnitude : 0);
  return Number(value) >= 0
    ? { from: 50, to: 50 + half }
    : { from: 50 - half, to: 50 };
}

const pct = (value) => `${Number(value.toFixed(2))}%`;

// 一整个 CSS background 值：外缘的端帽（2px）、中间刻度（1px）、半透明填充、
// 底色。空名字的行和关掉强度条的情况由调用方处理，它会把内联样式清掉。
export function strengthBarBackground(value, scale, colors = BAR_COLORS) {
  const tick =
    `linear-gradient(to right, transparent calc(50% - 0.5px), ${colors.tick} ` +
    `calc(50% - 0.5px), ${colors.tick} calc(50% + 0.5px), transparent calc(50% + 0.5px))`;
  if (Math.abs(Number(value)) < BAR_EPSILON || !Number.isFinite(Number(value))) {
    return `${tick} ${colors.base}`;
  }
  const span = strengthBarSpan(value, scale);
  const positive = Number(value) >= 0;
  const fill = positive ? colors.positiveFill : colors.negativeFill;
  const capColor = positive ? colors.positiveCap : colors.negativeCap;
  const bar =
    `linear-gradient(to right, transparent ${pct(span.from)}, ${fill} ` +
    `${pct(span.from)}, ${fill} ${pct(span.to)}, transparent ${pct(span.to)})`;
  const cap = positive
    ? `linear-gradient(to right, transparent calc(${pct(span.to)} - 2px), ` +
      `${capColor} calc(${pct(span.to)} - 2px), ${capColor} ${pct(span.to)}, ` +
      `transparent ${pct(span.to)})`
    : `linear-gradient(to right, transparent ${pct(span.from)}, ${capColor} ` +
      `${pct(span.from)}, ${capColor} calc(${pct(span.from)} + 2px), ` +
      `transparent calc(${pct(span.from)} + 2px))`;
  return `${cap}, ${tick}, ${bar} ${colors.base}`;
}

// ---------- 显示名 ----------

// 一行显示出来的名字；序列化时永远存完整路径。藏文件夹与藏扩展名是两项
// 独立的偏好。
//
// 扩展名表比 `stripExt` 宽一格：那个函数给「按主干名找回移动过的文件」用，
// 认得越少越好（把 a.pth 和 a.safetensors 都剥成 a 只会多出一次歧义）；这里
// 只负责显示，核心支持的 .pt2/.bin/.pth 都该藏掉。
export function shortLoraName(name, { hideFolders = true, hideExtension = true } = {}) {
  let text = String(name ?? "");
  if (hideFolders) text = text.split("/").pop().split("\\").pop();
  if (hideExtension) text = text.replace(/\.(safetensors|sft|ckpt|pt2|pth|bin|pt)$/i, "");
  return text;
}

// 长名字从中间截断，不截尾巴：LoRA 文件名的结尾通常才是区分 checkpoint 的
// 部分（_v1_000004000、-000012、_epoch_10），所以它拿更大的一份。`measure`
// 返回与 maxWidth 同单位的宽度（浏览器里是 canvas 的 measureText），这样
// 这段逻辑可测。
const ELLIPSIS = "\u2026";
const TAIL_SHARE = 0.6;

export function middleEllipsis(text, maxWidth, measure) {
  const value = String(text ?? "");
  if (measure(value) <= maxWidth) return value;
  const build = (keep) => {
    const tail = Math.ceil(keep * TAIL_SHARE);
    return value.slice(0, keep - tail) + ELLIPSIS + value.slice(value.length - tail);
  };
  // 放得下的最宽截法：留下的字符只会让宽度变大，所以能二分。
  let low = 0;
  let high = value.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(build(mid)) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

// 路径先让出文件夹：文件夹从尾部缩（"krea2/sty…/"），只有文件名单独都放不下
// 时才把文件名自己从中间截断、并把文件夹整个去掉。返回要显示的两段，好让
// 文件夹那段可以变暗。
export function fitLoraLabel(label, maxWidth, measure) {
  const text = String(label ?? "");
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const folder = text.slice(0, slash + 1);
  const name = text.slice(slash + 1);
  if (measure(text) <= maxWidth) return { folder, name };
  if (folder.length > 2) {
    const room = maxWidth - measure(name);
    const marker = ELLIPSIS + folder.slice(-1);
    const shortened = (keep) => folder.slice(0, keep) + marker;
    if (measure(shortened(1)) <= room) {
      // 放得下的最长文件夹前缀，二分找。
      let low = 1;
      let high = folder.length - 2;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (measure(shortened(mid)) <= room) low = mid;
        else high = mid - 1;
      }
      return { folder: shortened(low), name };
    }
  }
  return { folder: "", name: middleEllipsis(name, maxWidth, measure) };
}

// 选择器宽度跟着最长的名字长，窄工作区里长名字也能整读；超过上限交给中间
// 省略号。绝不小于它原本打开时的宽度（260，或者名字框加 80 直到 380），
// 也绝不超过窗口。
export const PICKER_MIN_WIDTH = 260;
export const PICKER_MAX_WIDTH = 560;
export function pickerWidth(widestLabel, anchorWidth, viewportWidth, chrome = 48) {
  const floor = Math.max(PICKER_MIN_WIDTH, Math.min(380, (Number(anchorWidth) || 0) + 80));
  const wanted = Math.max(floor, Math.ceil((Number(widestLabel) || 0) + chrome));
  const cap = Math.min(PICKER_MAX_WIDTH, (Number(viewportWidth) || PICKER_MAX_WIDTH) - 16);
  return Math.min(wanted, cap);
}

// ---------- 重复行 ----------

// 出现在不止一行上的完整名字（不分大小写）。每一份都标出来 —— 对称，用户
// 自己挑留哪个。同一个文件在两个不同文件夹下不算重复：栈会两个都加载，
// 这件事该如实显示。
export function duplicateLoraKeys(rows) {
  const counts = new Map();
  for (const row of rows ?? []) {
    if (!row?.name) continue;
    const key = row.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  );
}

// ---------- 主开关的记忆 ----------

// 主开关的循环：mixed -> 全开 -> 全关 -> 记住的那个 mixed -> 全开 -> …
// 每当循环离开一个 mixed 状态就抓一次快照，而每次单独开关都会刷新它（调用方
// 把 snapshotEnabled 递回去），所以手滑点一下主开关，永远只差一次点击就能
// 回到被毁掉的那套设置里。

export function snapshotEnabled(rows) {
  const map = {};
  for (const row of rows ?? []) {
    if (row?.name) map[row.id] = row.enabled !== false;
  }
  return map;
}

export function cycleMasterToggle(rows, snapshot) {
  const set = (enabled) =>
    rows.map((row) => (row.name ? { ...row, enabled } : row));
  const state = toggleAllState(rows);
  if (state === "mixed") return { rows: set(true), snapshot: snapshotEnabled(rows) };
  if (state === "on") return { rows: set(false), snapshot };
  // 全关：记住的那套如果还能点亮什么就恢复，否则这就是一次普通的二选一，
  // 全部打开。
  const restored = rows.map((row) =>
    row.name && snapshot && row.id in snapshot
      ? { ...row, enabled: snapshot[row.id] }
      : row,
  );
  const remembersAnything = restored.some((row) => row.name && row.enabled);
  return remembersAnything ? { rows: restored, snapshot } : { rows: set(true), snapshot };
}

// ---------- 吸收整条加载链 ----------
//
// 齿轮菜单里的吸收动作走这条节点两侧的模型链，把每个认得的加载器的行抬进
// 栈里，并把原来那些节点 bypass 掉 —— 于是老工作流的加载链收成一个 QG-tools
// 节点，而图算出来的东西不变。

// LiteGraph 的节点模式：4 = bypass（直通），2 = mute。
export const BYPASS_MODE = 4;
export const MUTE_MODE = 2;

const widgetValue = (nodeLike, name) =>
  nodeLike?.widgets?.find((widget) => widget?.name === name)?.value;

const cleanStrength = (value, fallback = 1) => {
  const number = Number(value);
  return roundStrength(Number.isFinite(number) ? number : fallback);
};

function entry(name, strength, strengthClip, enabled = true, triggers = "") {
  return {
    name: String(name),
    strength: cleanStrength(strength),
    strength_clip: cleanStrength(strengthClip, cleanStrength(strength)),
    enabled: enabled !== false,
    triggers: String(triggers ?? ""),
  };
}

// 一个认得的节点贡献的行，按它自己的应用顺序。这个导入不认识的类型返回
// null —— 调用方到那里就停止往上走。nodeLike 是个普通形状：
// { type, widgets: [{ name, value }] }。
export function loaderLoraEntries(nodeLike) {
  const type = String(nodeLike?.type ?? "");
  if (type === "LoraLoader" || type === "Lora Loader (JPS)") {
    const name = widgetValue(nodeLike, "lora_name");
    if (!name || name === "None") return [];
    return [entry(name, widgetValue(nodeLike, "strength_model"),
                  widgetValue(nodeLike, "strength_clip"),
                  type !== "Lora Loader (JPS)" || widgetValue(nodeLike, "switch") === "On")];
  }
  if (type === "LoraLoaderModelOnly") {
    const name = widgetValue(nodeLike, "lora_name");
    if (!name || name === "None") return [];
    // 只管模型意味着 CLIP 没动：CLIP 强度写 0 能如实复现这一点，即使这个
    // 节点身上接着 CLIP。
    return [entry(name, widgetValue(nodeLike, "strength_model"), 0)];
  }
  if (type === "Lora Loader Stack (rgthree)") {
    return (nodeLike.widgets ?? [])
      .filter((widget) => /^lora_\d+$/.test(widget.name) && widget.value && widget.value !== "None")
      .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)))
      .map((widget) => {
        const strength = widgetValue(nodeLike, `strength_${widget.name.slice(5)}`);
        return entry(widget.value, strength, strength);
      });
  }
  if (type === "Power Lora Loader (rgthree)") {
    const rows = [];
    for (const widget of nodeLike?.widgets ?? []) {
      const value = widget?.value;
      if (!value || typeof value !== "object" || !value.lora) continue;
      if (value.lora === "None") continue;
      const two = value.strengthTwo == null ? NaN : Number(value.strengthTwo);
      rows.push(entry(
        value.lora,
        value.strength,
        Number.isFinite(two) ? two : value.strength,
        value.on !== false,
      ));
    }
    return rows;
  }
  if (type === "PixaromaLoraLoader") {
    // 与 Pixaroma 加载器序列化下来的面板状态互通：一个 widget（"loras_ui"）
    // 装着 { loras: [{ name, on, sm, sc }] }。
    const panelState = widgetValue(nodeLike, "loras_ui");
    const list = panelState && typeof panelState === "object" ? panelState.loras : null;
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && typeof item === "object" && item.name && item.name !== "None")
      .map((item) => entry(item.name, item.sm, item.sc, item.on !== false));
  }
  if (type === "QG_LoraLoader" || type === "AUSBOSS_LAB_LoraLoader") {
    try {
      const parsed = JSON.parse(String(widgetValue(nodeLike, "loras") ?? "[]"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((row) => row && typeof row === "object" && row.name)
        .map((row) => entry(row.name, row.strength,
                            row.strength_clip ?? row.strength,
                            row.enabled, row.triggers));
    } catch {
      return [];
    }
  }
  return null;
}

const baseName = (path) =>
  String(path).split("/").pop().split("\\").pop().toLowerCase();
const stripExt = (name) =>
  name.replace(/\.(safetensors|sft|ckpt|pt)$/i, "");

// 把外来的 lora 路径对到本机的列表上。完全一致优先；然后是不分大小写的
// 完整路径唯一命中；再是不看扩展名的主干名唯一命中 —— 最后这条让「在别的
// 机器的目录结构下存的」工作流能落到本机的同一个文件上。
export function resolveLoraName(name, available) {
  const list = Array.isArray(available) ? available : [];
  if (list.includes(name)) return { name, status: "exact" };
  const lower = String(name).toLowerCase();
  const fullMatches = list.filter((candidate) => candidate.toLowerCase() === lower);
  if (fullMatches.length === 1) return { name: fullMatches[0], status: "remapped" };
  const wanted = stripExt(baseName(name));
  const baseMatches = list.filter(
    (candidate) => stripExt(baseName(candidate)) === wanted,
  );
  if (baseMatches.length === 1) return { name: baseMatches[0], status: "remapped" };
  if (baseMatches.length > 1) return { name, status: "ambiguous" };
  return { name, status: "missing" };
}

// 导入时合并行。吸收一条活着的链要 deduplicate=false：重复的文件名是分别
// 打的补丁，必须全都留下。
export function mergeImportedRows(existing, imported,
                                  { makeRow = newRow, position = "before", deduplicate = true } = {}) {
  const have = new Set(
    (existing ?? []).filter((row) => row?.name)
      .map((row) => row.name.toLowerCase()),
  );
  const added = [];
  let skipped = 0;
  for (const item of imported ?? []) {
    const key = String(item.name).toLowerCase();
    if (deduplicate && have.has(key)) {
      skipped += 1;
      continue;
    }
    have.add(key);
    added.push({ ...makeRow(), ...item });
  }
  const rows = position === "after"
    ? [...(existing ?? []), ...added]
    : [...added, ...(existing ?? [])];
  return { rows, added: added.length, skipped };
}

// 联动模式下一行只显示一个强度；导入进来的行如果模型和 CLIP 打的不一样
// （只管模型的加载器、rgthree 的双强度行），就必须分开显示，否则这个差别
// 看不见，第一次拖就被抹平了。
export function importNeedsSeparateStrengths(entries) {
  return (entries ?? []).some(
    (item) => Number(item.strength) !== Number(item.strength_clip),
  );
}

// Toast 的摘要由 "{n}" 模板拼出来（见 shared/zh.mjs），这样汉化插件的词典
// 能逐段翻译；计数在翻译之前就填好了，所以不会破坏整串匹配。
const SUMMARY_SEGMENTS = {
  empty: "No LoRA loaders found in the model chain.",
  imported1: "Imported {n} LoRA",
  importedN: "Imported {n} LoRAs",
  bypassed1: "bypassed {n} loader node",
  bypassedN: "bypassed {n} loader nodes",
  skipped: "skipped {n} already in the stack",
  remapped1: "{n} path remapped to this install",
  remappedN: "{n} paths remapped to this install",
  broken1: "{n} name not resolved - check the red rows",
  brokenN: "{n} names not resolved - check the red rows",
};

function segment(key, n) {
  return zhCount(SUMMARY_SEGMENTS[key], SUMMARY_SEGMENTS[key], n);
}

export function importSummary({ added = 0, skipped = 0, bypassed = 0,
                                remapped = 0, missing = 0, ambiguous = 0 } = {}) {
  if (!added && !skipped && !bypassed) return segment("empty", 0);
  const parts = [segment(added === 1 ? "imported1" : "importedN", added)];
  if (bypassed) parts.push(segment(bypassed === 1 ? "bypassed1" : "bypassedN", bypassed));
  if (skipped) parts.push(segment("skipped", skipped));
  if (remapped) parts.push(segment(remapped === 1 ? "remapped1" : "remappedN", remapped));
  const broken = missing + ambiguous;
  if (broken) parts.push(segment(broken === 1 ? "broken1" : "brokenN", broken));
  return `${parts.join(zhSep())}${zhEnd()}`;
}

function upstreamModelNode(node) {
  const graph = node.graph;
  if (!graph) return null;
  const input = node.inputs?.find((entry) =>
    String(entry?.type).toUpperCase() === "MODEL" || String(entry?.name).toLowerCase() === "model",
  ) ?? node.inputs?.[0];
  const linkId = input?.link;
  if (linkId === null || linkId === undefined) return null;
  const link = graph.links?.[linkId] ?? graph._links?.get?.(linkId);
  if (!link) return null;
  return graph.getNodeById?.(link.origin_id) ?? null;
}

// 喂给模型输入的那些加载器节点，最近的先。转接点会穿过去；已经 bypass 的
// 加载器仍留在链上（bypass 会把模型直通过去，所以还得继续往上走），但不
// 贡献任何行。
export function collectUpstreamLoaders(node) {
  const chain = [];
  const seen = new Set([node.id]);
  let current = upstreamModelNode(node);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const type = String(current.type ?? current.comfyClass ?? "");
    if (type === "Reroute") {
      current = upstreamModelNode(current);
      continue;
    }
    if (loaderLoraEntries({ type, widgets: current.widgets }) === null) break;
    chain.push(current);
    current = upstreamModelNode(current);
  }
  return chain;
}

// 这个节点的模型输出喂给的那一个节点 —— 且只在正好喂一个的时候。扇出就
// 停止：bypass 其中一条分支上的加载器会悄悄改掉其它每条分支算出来的东西。
function downstreamModelNode(node) {
  const graph = node.graph;
  if (!graph) return null;
  const output = node.outputs?.find((entry) =>
    String(entry?.type).toUpperCase() === "MODEL" || String(entry?.name).toLowerCase() === "model",
  ) ?? node.outputs?.[0];
  const links = output?.links;
  if (!Array.isArray(links) || links.length !== 1) return null;
  const link = graph.links?.[links[0]] ?? graph._links?.get?.(links[0]);
  if (!link) return null;
  return graph.getNodeById?.(link.target_id) ?? null;
}

// 模型输出喂过去的那些加载器，最近的先（＝它们的应用顺序）。规则同上：
// 转接点穿过去，不认得的类型或扇出就停。
export function collectDownstreamLoaders(node) {
  const chain = [];
  const seen = new Set([node.id]);
  let current = downstreamModelNode(node);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const type = String(current.type ?? current.comfyClass ?? "");
    if (type === "Reroute") {
      current = downstreamModelNode(current);
      continue;
    }
    if (loaderLoraEntries({ type, widgets: current.widgets }) === null) break;
    chain.push(current);
    current = downstreamModelNode(current);
  }
  return chain;
}

// 吸收会把补丁搬走、把原来的主人 bypass 掉。只有串行的一条路径才能让每个
// 消费者看到同样的补丁，包括 CLIP 的消费者。
export function absorbChainIssue(node, upstream, downstream) {
  // 这五句直接进 loraToast：toast 是 PrimeVue，挂在 app root 外面，汉化插件的
  // DOM 翻译器看不到它（zh.mjs 的注释里记着这件事）。所以文案在这里就得备好
  // 两份，不能指望下游去翻。
  if ([2, 4].includes(node.mode ?? 0)) {
    return zhPair("Enable this LoRA Loader before absorbing a chain.",
                  "先启用这个 LoRA 加载器，再吸收整条链。");
  }
  if (node.inputs?.some(input => input.name === "loras" && input.link != null)) {
    return zhPair(
      "This stack is supplied by a connected input. Disconnect it before absorbing; nothing was changed.",
      "这一摞是由接线输入提供的。先断开它再吸收；什么都没改。",
    );
  }
  const chain = [...upstream].reverse().concat(node, downstream);
  const active = item => ![2, 4].includes(item.mode ?? 0);
  const slotOf = (item, direction, type) => item[direction]?.find(slot => String(slot.type).toUpperCase() === type);
  const feedsOnly = (source, target, type) => {
    const seen = new Set();
    let output = slotOf(source, "outputs", type);
    while (output?.links?.length === 1) {
      const id = output.links[0];
      if (seen.has(id)) return false;
      seen.add(id);
      const graph = source.graph;
      const link = graph?.links?.[id] ?? graph?._links?.get?.(id);
      const next = graph?.getNodeById?.(link?.target_id);
      if (next === target) return target.inputs?.[link.target_slot] === slotOf(target, "inputs", type);
      if (next?.type !== "Reroute") return false;
      output = next.outputs?.[0];
    }
    return false;
  };
  for (let index = 1; index < chain.length; index++) {
    if (!feedsOnly(chain[index - 1], chain[index], "MODEL")) {
      return zhPair(
        "The model chain branches or changes before reaching this stack. Keep shared loaders separate; nothing was absorbed.",
        "模型链在到达这一摞之前就分叉或换道了。共享的加载器请各自留着；什么都没吸收。",
      );
    }
  }
  const sources = [...upstream, ...downstream].filter(active);
  if (sources.some(source => source.outputs?.some(output =>
    !["MODEL", "CLIP"].includes(String(output.type).toUpperCase()) && output.links?.length))) {
    return zhPair(
      "A source loader has another connected output, such as trigger words. Bypassing it would break that connection; nothing was absorbed.",
      "有一个来源加载器还接了别的输出（比如触发词）。旁通它会断开那根线；什么都没吸收。",
    );
  }
  const movesClip = sources.some(source => slotOf(source, "inputs", "CLIP")?.link != null &&
    loaderLoraEntries({type: source.type, widgets: source.widgets})?.some(row => row.enabled && row.strength_clip !== 0));
  if (movesClip) {
    const clipChain = chain.filter(item => slotOf(item, "outputs", "CLIP"));
    if (slotOf(node, "inputs", "CLIP")?.link == null || clipChain.some((item, index) =>
      index > 0 && !feedsOnly(clipChain[index - 1], item, "CLIP"))) {
      return zhPair(
        "CLIP must follow the same serial loader chain as MODEL to preserve its patches. Nothing was absorbed.",
        "为了保住 CLIP 的补丁，CLIP 必须和 MODEL 走同一条串行加载链。什么都没吸收。",
      );
    }
  }
  return null;
}

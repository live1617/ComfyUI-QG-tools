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

// 有些节点的输入是「同一类、成串出现」的：QG_Math 声明了 a–z 共 26 个变量
// （前端默认只放出 3 个，接满一个才长出下一个），QG_AnySwitch 是 any_01…any_16。
// 帮助卡是按注册表逐个列输入的实现，几十行「变量 a … 变量 z」会把整张卡刷成一片噪声
// —— 这里折叠成一行讲清楚。
//
// 🔴 折叠文案是我们自己写的，不在语言包里，所以中英各留一份：英文界面下
// 用 detailEn，中文界面（传了 zhNode）用 detail。少写 detailEn 会让英文界面
// 冒出中文。
const FOLDED_INPUTS = {
  QG_Math: {
    match: /^[a-z]$/,
    term: "a–z",
    detail:
      "变量槽：默认露 3 个空槽，接满一个自动长出下一个（最多到 z）；" +
      "整数、小数、布尔都能接，没连线按 0。",
    detailEn:
      "Variable slots: three are shown at first and the next one appears once " +
      "one is filled (up to z). Numbers and booleans both fit; unmapped slots read 0.",
  },
  QG_AnySwitch: {
    match: /^any_\d+$/,
    term: "任意 01–16",
    termEn: "any 01–16",
    detail: "任意类型的输入槽，最多 16 个。上下两个都接上才有得选；没接的槽不参与。",
    detailEn:
      "Any-type input slots, up to 16. The switch only has something to pick when " +
      "at least two are connected; empty slots are ignored.",
  },
};

// 前端注入、后端 schema 里没有的输入名（LoadImage / CropRotatePad 上那个上传控件）。
// 它们不能写进 locales/zh/nodeDefs.json —— 那份字典的 inputs 键必须与
// INPUT_TYPES 的参数名严格一致，多一条 verify_i18n 立刻报「不一致」。
// 所以译文只能留在帮助卡自己这儿，按输入名兜底。
const INJECTED_INPUTS = {
  upload: {
    name: "上传图像",
    tooltip: "从这里选 ComfyUI 输入目录里的图，或者把新图片直接拖进来。",
  },
};

function inputItems(inputSpec, nodeName, zhNode) {
  const fold = FOLDED_INPUTS[nodeName];
  const items = [];
  let folded = false;
  for (const group of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(inputSpec?.[group] ?? {})) {
      if (fold && fold.match.test(name)) {
        if (!folded) {
          items.push({
            term: zhNode ? fold.term : fold.termEn || fold.term,
            detail: zhNode ? fold.detail : fold.detailEn || fold.detail,
          });
          folded = true;
        }
        continue;
      }
      const zhEntry = zhNode?.inputs?.[name] || (zhNode ? INJECTED_INPUTS[name] : null);
      const options = Array.isArray(spec) ? spec[1] : undefined;
      const detail =
        zhEntry?.tooltip ||
        (options && typeof options === "object" ? options.tooltip : undefined);
      items.push({ term: zhEntry?.name || name, detail: detail || undefined });
    }
  }
  return items;
}

// Sections for the help card.
//
// 数据源有两份，按语言二选一：
//   - 英文：节点注册的 schema（DESCRIPTION / 输入 tooltip / output_tooltips）。
//     后端 tooltip 一律英文是既定规矩，官方 i18n 也不翻 tooltip，所以这条路
//     永远出英文 —— 中文界面下卡片全英文就是没人给 zhDefs 的后果。
//   - 中文：locales/zh/nodeDefs.json 的对应条目（由 zh_node_defs.mjs 带到前端）。
//     输入/输出槽用**槽名**对齐，输出槽用索引字符串（"0"/"1"）对齐 ——
//     这正是官方 i18n 那份字典的写法，别改成别的键。
//
// zhDefs 为 null / 缺该节点时整体回落英文，所以英文界面和不认识的新节点都安全。
export function helpSections(nodeData, zhDefs) {
  const zhNode = zhDefs?.[nodeData?.name] ?? null;
  const sections = [];
  const description = zhNode?.description || nodeData?.description;
  if (description) sections.push({ text: description });
  const inputs = inputItems(nodeData?.input, nodeData?.name, zhNode);
  if (inputs.length) {
    sections.push({ heading: zhNode ? "输入" : "Inputs", items: inputs });
  }
  const names = nodeData?.output_name ?? [];
  const tooltips = nodeData?.output_tooltips ?? [];
  const outputs = names.map((name, index) => {
    const zhEntry = zhNode?.outputs?.[String(index)];
    return {
      term: zhEntry?.name || name,
      detail: zhEntry?.tooltip || tooltips[index] || undefined,
    };
  });
  if (outputs.length) {
    sections.push({ heading: zhNode ? "输出" : "Outputs", items: outputs });
  }
  return sections;
}

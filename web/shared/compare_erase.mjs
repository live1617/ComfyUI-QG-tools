// 「图像对比」橡皮擦模式的纯逻辑：这里不碰 DOM，画布和按钮在
// compare_erase_stage.mjs 里，所以这一份能单独测。
//
// 橡皮擦模式下，一张图压在另一张上面，画笔把上面那张擦掉一块。存下来的是
// **笔画**，不是画好的位图：面板用它们画预览，服务端用同一批笔画按原图尺寸
// 拼出要保存的混合图（nodes/_qg_compare_helpers.py 里是同一套数字）。
//
// 一笔是 { o, d, s, p }：o 为 1 擦掉上面那张、0 画回来；d 是笔宽（图上像素）；
// s 是软度（百分数）；p 是路径，x0, y0, x1, y1 ...（图上像素）。
//
// 移植自 ComfyUI-AusBoss（MIT，js/shared/compare_erase.mjs）；
// thinStroke / extendStroke 从上游 touch_math.mjs 里摘出来内联在此，免得为两个
// 函数拖进上千行。
// 后端对应文件：nodes/_qg_compare_helpers.py（两边数字必须一致）。

import { BRUSH_SOFT_DEFAULT, clampBrushSize, clampSoft, steppedBrushSize } from "./brush.mjs?v=2026102002";

// 画笔本身就是全包共用那一支（brush.mjs）。
export {
  ADJUST_DEAD_ZONE,
  ADJUST_TURN,
  adjustAxis,
  adjustedBrush,
  brushCore,
  brushSigma,
  clampSoft,
  moveAdjust,
  startAdjust,
  steppedSoft,
} from "./brush.mjs?v=2026102002";

export const ERASE_SIZE = [2, 2000];
export const ERASE_MAX_STROKES = 400;
export const ERASE_MAX_STROKE_POINTS = 600;
export const ERASE_MAX_POINTS = 40000;
// 按住鼠标时路径可以跑出画面，但不能跑得太远。
export const ERASE_OUTSIDE = 4096;
export const ERASE_SOFT_DEFAULT = BRUSH_SOFT_DEFAULT;
// 面板画预览用的遮罩，长边最多这么大。保存的混合图和它无关：服务端会按原图
// 尺寸重画这些笔画。
export const PREVIEW_SIDE = 2048;

const STROKE_MAX_POINTS = 20000;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function clampSize(value) {
  return clampBrushSize(value, ERASE_SIZE);
}

// 一张图打开时笔多大：大约长边的二十四分之一。
export function defaultBrushSize(width, height) {
  const side = Math.max(Number(width) || 0, Number(height) || 0);
  return side > 0 ? clampSize(Math.round(side / 24) * 2) : 64;
}

export function normalizeTop(value) {
  return value === "B" ? "B" : "A";
}

// 存下来的一笔，校验一遍。不是笔画的东西一律 null：工作流里存的是别人写的
// 文本，什么都可能有。
export function cleanStroke(raw, width, height) {
  const path = raw?.p;
  if (!Array.isArray(path) || path.length < 2 || path.length % 2) return null;
  if (path.length / 2 > ERASE_MAX_STROKE_POINTS) return null;
  const points = [];
  for (let index = 0; index < path.length; index += 2) {
    const x = Number(path[index]);
    const y = Number(path[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push(
      clamp(Math.round(x), -ERASE_OUTSIDE, width + ERASE_OUTSIDE),
      clamp(Math.round(y), -ERASE_OUTSIDE, height + ERASE_OUTSIDE),
    );
  }
  return { o: raw.o === 0 ? 0 : 1, d: clampSize(raw.d), s: clampSoft(raw.s), p: points };
}

export function pointCount(strokes) {
  return strokes.reduce((total, stroke) => total + stroke.p.length / 2, 0);
}

// 再添一笔还塞得下吗？
export function strokeFits(strokes, stroke) {
  if (strokes.length + 1 > ERASE_MAX_STROKES) return false;
  return pointCount(strokes) + stroke.p.length / 2 <= ERASE_MAX_POINTS;
}

// 节点随工作流一起存下的笔迹：笔画，外加它们画在哪张尺寸的图上。画在别的
// 尺寸上的笔迹直接丢掉——那些位置已经没有意义了。
export function readPaint(raw, width, height) {
  const empty = { w: width, h: height, strokes: [] };
  if (!raw || raw.w !== width || raw.h !== height || !Array.isArray(raw.strokes)) return empty;
  const strokes = [];
  for (const item of raw.strokes.slice(0, ERASE_MAX_STROKES)) {
    const stroke = cleanStroke(item, width, height);
    if (stroke && strokeFits(strokes, stroke)) strokes.push(stroke);
  }
  return { w: width, h: height, strokes };
}

function distanceToSegment(point, from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const span = dx * dx + dy * dy;
  const along = span ? clamp(((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / span, 0, 1) : 0;
  return Math.hypot(point[0] - (from[0] + dx * along), point[1] - (from[1] + dy * along));
}

// 把离「前后两点之间那条线」不到 `tolerance` 的点丢掉（常见的折线简化），
// 如果还超过 `limit` 就均匀地再稀一遍。两头永远留着。
export function thinStroke(points, tolerance, limit = STROKE_MAX_POINTS) {
  if (points.length <= 2) return points.map((pair) => [pair[0], pair[1]]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const spans = [[0, points.length - 1]];
  while (spans.length) {
    const [from, to] = spans.pop();
    let worst = 0;
    let at = -1;
    for (let index = from + 1; index < to; index += 1) {
      const distance = distanceToSegment(points[index], points[from], points[to]);
      if (distance > worst) { worst = distance; at = index; }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1;
      spans.push([from, at], [at, to]);
    }
  }
  let kept = points.filter((_, index) => keep[index]);
  if (kept.length > limit) {
    const step = (kept.length - 1) / (limit - 1);
    kept = Array.from({ length: limit }, (_, index) => kept[Math.round(index * step)]);
  }
  return kept.map((pair) => [pair[0], pair[1]]);
}

// 指针移动时往笔画里加点：离上一个点不到 `gap` 就不加（宽笔不需要那么密）。
// 加了返回 true。
export function extendStroke(points, x, y, gap) {
  const last = points[points.length - 1];
  if (last) {
    const dx = x - last[0];
    const dy = y - last[1];
    if (dx * dx + dy * dy < gap * gap) return false;
  }
  points.push([x, y]);
  return true;
}

// 指针留下的点收成一笔，坐标是图上像素。加不出线的点会丢掉，笔越粗丢得越多
// ——细笔看得出来的抖动，粗笔本来就盖住了。
export function makeStroke(points, { erase = true, size, soft }, width, height) {
  const d = clampSize(size);
  const thinned = thinStroke(points, Math.max(0.75, d / 40), ERASE_MAX_STROKE_POINTS);
  return cleanStroke({ o: erase ? 1 : 0, d, s: clampSoft(soft), p: thinned.flat() }, width, height);
}

// 一张图整个居中放进一个盒子时占哪块地方。
export function fitRect(boxWidth, boxHeight, width, height) {
  if (!(boxWidth > 0) || !(boxHeight > 0) || !(width > 0) || !(height > 0)) {
    return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const fitWidth = width * scale;
  const fitHeight = height * scale;
  return { left: (boxWidth - fitWidth) / 2, top: (boxHeight - fitHeight) / 2, width: fitWidth, height: fitHeight, scale };
}

// 盒子里的一个位置，换成图上的位置（图上像素）。
export function toPicture(fit, x, y) {
  if (!(fit?.scale > 0)) return null;
  return [(x - fit.left) / fit.scale, (y - fit.top) / fit.scale];
}

// 面板自己那张遮罩比原图小多少。
export function previewScale(width, height, cap = PREVIEW_SIDE) {
  const side = Math.max(width, height);
  return side > cap ? cap / side : 1;
}

// [ 和 ] 之后下一个笔宽。
export function steppedSize(size, up) {
  return steppedBrushSize(size, up, ERASE_SIZE);
}

// 没给名字时保存的文件叫这个，以及名字最长多少（后端
// nodes/_qg_compare_helpers.py 里是同样两个）。
export const SAVE_NAME = "compare";
export const SAVE_NAME_MAX = 80;

// 名字框里能打进去的东西：字母、数字、空格、点、横线、下划线留着，别的都不
// 进，所以目录永远不可能混进名字里。服务端按同样的规矩再查一遍，不合格就拒。
export function typedName(text) {
  return String(text ?? "").replace(/[^\p{L}\p{N}_ .\-]/gu, "").replace(/\.{2,}/g, ".").replace(/^[ .]+/, "").slice(0, SAVE_NAME_MAX);
}

// 文件最后会叫什么，给指针下面那行提示用。
export function nameHint(name, layers) {
  const base = typedName(name).trim().replace(/[ .]+$/, "") || SAVE_NAME;
  return layers ? `${base}_00001.png，另加 ${base}_00001.psd 和 ${base}_00001_mask.png` : `${base}_00001.png`;
}

// 点保存时发出去的东西：这轮运行那两张图的键（从不指名要读文件），加上给新
// 文件打的名字。
export function saveRequest({ pair, top, strokes, layers, name }) {
  return {
    pair: typeof pair === "string" ? pair : "",
    top: normalizeTop(top),
    strokes: strokes ?? [],
    layers: layers === true,
    name: typedName(name).trim(),
  };
}

// 保存完了面板上说的那句。
export function savedMessage(files) {
  const names = (files ?? []).map((file) => (file?.subfolder ? `${file.subfolder}/${file.filename}` : file?.filename)).filter(Boolean);
  if (!names.length) return "已保存。";
  return names.length > 1
    ? `已保存 ${names[0]}，连同它的 PSD 和遮罩，都在 output 目录里。`
    : `已保存 ${names[0]}，在 output 目录里。`;
}

// 保存出来的文件，做成图下面那排小链接，这样在另一台机器上做的混合图也能从
// 节点上下载。
export function savedLinks(files) {
  return (files ?? []).filter((file) => file?.filename).map((file) => {
    const name = String(file.filename).toLowerCase();
    const label = name.endsWith("_mask.png") ? "遮罩" : name.endsWith(".psd") ? "PSD" : "PNG";
    return { label, file };
  });
}

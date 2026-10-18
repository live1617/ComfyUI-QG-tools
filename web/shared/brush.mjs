// QG 全包共用的一支画笔：图像对比的橡皮擦用它，按触摸画遮罩也用它。
// 一支笔是怎么回事（实心中间 + 软边）、键盘和拖拽怎么调它、哪个按键做什么，
// 都放在这一份里，两个节点就不会各跑各的。这里不碰 DOM，所以能单独测。
//
// 一支笔有 `size`（宽度，单位是图上像素）和 `soft`（边缘多软，0 到 100）。
//
// 移植自 ComfyUI-AusBoss（MIT，js/shared/brush.mjs）。

// 笔宽能到的最大范围。范围更窄的节点传自己的进来。
export const BRUSH_SIZE = [2, 2000];
export const BRUSH_SOFT_DEFAULT = 50;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// 笔芯（实心部分）的半径。`soft` 取 0~1。
export function brushCore(size, soft) {
  return (size / 2) * (1 - soft / 2);
}

// 软边模糊的幅度：硬笔是 0，最软时是笔宽的八分之一。模糊大约会往外铺三个
// 这样的幅度，所以笔在指针画的那个圈附近淡出。
export function brushSigma(size, soft) {
  return (soft * size) / 8;
}

export function clampBrushSize(value, range = BRUSH_SIZE) {
  const number = Number(value);
  return clamp(Number.isFinite(number) ? Math.round(number) : range[0], range[0], range[1]);
}

export function clampSoft(value, fallback = BRUSH_SOFT_DEFAULT) {
  const number = Number(value);
  return clamp(Number.isFinite(number) ? Math.round(number) : fallback, 0, 100);
}

// [ 和 ] 一次跳到多大的笔宽：上下五分之一，但每次至少变两像素。
export function steppedBrushSize(size, up, range = BRUSH_SIZE) {
  const next = up ? Math.max(size + 2, Math.round((size * 1.2) / 2) * 2) : Math.min(size - 2, Math.round(size / 1.2 / 2) * 2);
  return clampBrushSize(next, range);
}

// Shift + [ 和 Shift + ] 一次改多少软度：软四分之一或硬四分之一。
export function steppedSoft(soft, softer) {
  return clampSoft(soft + (softer ? 25 : -25));
}

// 拖拽着调笔，和 Photoshop 一样：按住 Alt 加鼠标右键，横着拖改大小，上下拖
// 改软边。一次拖只改其中一项，手抖着调大小不会顺带动到软边。开头几个像素
// 决定改哪项，中途换个方向就换成改另一项。
export const ADJUST_DEAD_ZONE = 6;
// 指针往另一个方向走这么远，这次拖拽就换项。
export const ADJUST_TURN = 12;

export function adjustAxis(dx, dy) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < ADJUST_DEAD_ZONE) return null;
  return Math.abs(dx) >= Math.abs(dy) ? "size" : "soft";
}

// 拖了屏幕上的 dx、dy 之后笔长什么样。横着拖时笔的边缘跟着指针走，
// `perPixel` 是一个屏幕像素盖住几个图上像素。往上是变软、往下是变硬，每
// 像素半个百分点，整段范围一小段就拖完了。
export function adjustedBrush({ size, soft }, axis, dx, dy, perPixel = 1, range = BRUSH_SIZE) {
  if (axis === "size") return { size: clampBrushSize(size + 2 * dx * perPixel, range), soft };
  if (axis === "soft") return { size, soft: clampSoft(soft - dy / 2) };
  return { size, soft };
}

// 在屏幕的 x、y 开始一次调笔的拖拽。
export function startAdjust(x, y, { size, soft }, range = BRUSH_SIZE) {
  return { axis: null, origin: [x, y], base: { size, soft }, trail: [x, y], brush: { size, soft }, range };
}

// 指针移到 x、y 之后这次拖拽的样子。`trail` 落后指针几个像素：当「从 trail
// 到指针」这段明显掉头（反方向走的是正方向两倍远），就当这次拖拽换项了。
// 已经调好的值留着，另一项从指针这里重新开始算。
export function moveAdjust(state, x, y, perPixel = 1) {
  let { axis, origin, base, trail } = state;
  const range = state.range ?? BRUSH_SIZE;
  const tx = x - trail[0];
  const ty = y - trail[1];
  if (Math.hypot(tx, ty) >= ADJUST_TURN) {
    const heading = Math.abs(tx) >= 2 * Math.abs(ty) ? "size" : Math.abs(ty) >= 2 * Math.abs(tx) ? "soft" : null;
    if (axis && heading && heading !== axis) {
      base = adjustedBrush(base, axis, x - origin[0], y - origin[1], perPixel, range);
      origin = [x, y];
      axis = heading;
    }
    trail = [x, y];
  }
  axis ??= adjustAxis(x - origin[0], y - origin[1]);
  return { axis, origin, base, trail, range, brush: adjustedBrush(base, axis, x - origin[0], y - origin[1], perPixel, range) };
}

// ---- 按哪个键算哪件事 ---------------------------------------------------------
//
// 全包一支笔一套规矩：按住 Ctrl，或者按鼠标右键，在按着的时候做「当前工具的
// 反面」——画的时候擦、擦的时候画。Alt 归笔自己：Alt 加右键拖，调它的大小和
// 软边。

// 这一下按下去是不是开始调笔的拖拽。Mac 上按住 Control 点一下就是右键，
// 所以 Control 加 Option 点击也算。
export function brushAdjusts(event) {
  return Boolean(event?.altKey) && (event.button === 2 || Boolean(event.ctrlKey));
}

// 这一下按下去是不是做当前工具的反面。
export function brushFlips(event) {
  return !brushAdjusts(event) && (event?.button === 2 || Boolean(event?.ctrlKey));
}

// 按键要笔做什么：[ 和 ] 改大小，加 Shift 改软边，和 Photoshop 一样。也按
// 键位认，因为按住 Shift 打出来的是 { 和 }。别的键返回 null。
export function brushKey(event) {
  const smaller = event?.code === "BracketLeft" || event?.key === "[" || event?.key === "{";
  const larger = event?.code === "BracketRight" || event?.key === "]" || event?.key === "}";
  if (!smaller && !larger) return null;
  return event.shiftKey ? { what: "soft", up: smaller } : { what: "size", up: larger };
}

// 一个工具一个字母，和 Photoshop 一样：W 快速选择（拾取）、B 画笔、
// E 橡皮。按字母认，也按键位认（键盘上不是拉丁字母的也照用）。别的键，
// 以及带 Ctrl / Alt / Cmd 打的字母，都不认——那是别人的快捷键。
export function toolKey(event) {
  if (!event || event.ctrlKey || event.altKey || event.metaKey) return null;
  const letter = String(event.key ?? "").toLowerCase();
  const place = { KeyW: "w", KeyB: "b", KeyE: "e" }[event.code] ?? "";
  const chosen = /^[a-z]$/.test(letter) ? letter : place;
  return { w: "pick", b: "paint", e: "erase" }[chosen] ?? null;
}

// 笔的一下按在离笔心 `distance` 的地方，盖住多少（0~1）：笔芯里是实的，到
// 边缘按模糊的样子淡出。用来把笔的形状画在指针下面；真正的笔迹由
// brushStroke 和服务端画。
export function brushProfile(distance, size, soft) {
  const core = brushCore(size, soft);
  const sigma = brushSigma(size, soft);
  if (!(sigma >= 0.25)) return distance <= size / 2 ? 1 : 0;
  // 模糊圆盘的边缘，够用了：沿边缘做半个 erfc。
  const x = (distance - core) / (sigma * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return clamp(0.5 * (1 - Math.sign(x) * erf), 0, 1);
}

// 笔的一下能影响到多远：硬笔是那个圈，软笔是笔芯外再加三个模糊幅度。
export function brushReach(size, soft) {
  const sigma = brushSigma(size, soft);
  return sigma >= 0.25 ? Math.max(size / 2, brushCore(size, soft) + 3 * sigma) : size / 2;
}

// 正在调笔时，指针下面那行字里的两个值。
export function brushWords(size, soft) {
  return [`笔宽 ${size} px`, `软度 ${soft}%`];
}

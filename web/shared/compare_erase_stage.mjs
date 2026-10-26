// 「图像对比」橡皮擦模式：画布、画笔和工具行。
//
// 一张图压在另一张上面，画笔把上面那张擦掉一块。节点存的是笔画
// （compare_erase.mjs），这个文件负责把它们画出来：一张遮罩画布记着被擦掉的
// 地方，视图把底下那张画出来，再把「上面那张减去遮罩」盖上去。保存时把笔画
// 发给服务端，由它按原图尺寸拼出混合图。
//
// 移植自 ComfyUI-AusBoss（MIT，js/shared/compare_erase_stage.mjs）。

import { api } from "/scripts/api.js";
import { BRAND, notifyQgChange, showToast } from "./index.mjs?v=2026102571";
import { brushAdjusts, brushFlips, brushKey, brushWords, toolKey } from "./brush.mjs?v=2026102571";
import { keepKeyInField } from "./canvas_passthrough.mjs?v=2026102571";
import { makeScrubInput } from "./scrub_input.mjs?v=2026102571";
import { makeSlideSwitch } from "./slide_switch.mjs?v=2026102571";
import { extendStroke } from "./compare_erase.mjs?v=2026102571";
import {
  ERASE_OUTSIDE,
  ERASE_SIZE,
  ERASE_SOFT_DEFAULT,
  brushCore,
  brushSigma,
  clampSize,
  clampSoft,
  defaultBrushSize,
  fitRect,
  makeStroke,
  moveAdjust,
  nameHint,
  normalizeTop,
  previewScale,
  readPaint,
  saveRequest,
  savedMessage,
  startAdjust,
  steppedSize,
  steppedSoft,
  strokeFits,
  typedName,
} from "./compare_erase.mjs?v=2026102571";

// 图上面那行工具、图下面那行保存，各有多高。节点窄的时候这两行会折成两行，
// 而不是把节点撑宽——地方从图上出。
export const ERASE_BAR_HEIGHT = 24;
export const SAVE_ROW_HEIGHT = 28;

// 跟着工作流一起存：笔迹、手动调过的笔、哪张图在上面、保存时要不要带图层。
const PAINT_PROPERTY = "qg_compare_paint";
const SIZE_PROPERTY = "qg_compare_brush";
const SOFT_PROPERTY = "qg_compare_soft";
const TOP_PROPERTY = "qg_compare_top";
const LAYERS_PROPERTY = "qg_compare_layers";
const NAME_PROPERTY = "qg_compare_name";
// 一张软盘，在这里画：切掉的角、标签、滑盖。
const SAVE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'
  + '<path d="M2.5 2.5h8.4l2.6 2.6v8.4h-11z"/><path d="M5.2 2.7v3.3h4.6V2.7"/><path d="M4.9 13.3V9.6h6.2v3.7"/></svg>';
// 两张纸，一张压在另一张上，在这里画。
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'
  + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
const SAVE_ROUTE = "/qg/compare/save";
const ALIGN_ROUTE = "/qg/compare/align";
const UNDO_KEPT = 60;
// 视图按它在屏幕上的大小画，最多这么多像素。
const VIEW_SIDE = 2600;
// 指针外面画的那个笔圈：擦掉时是 QG 的青，画回来时是珊瑚色。
const RUB_TINT = BRAND;
const RUB_RING = "#78fff0";
const BACK_TINT = "#ff9678";
const BACK_RING = "#ffb49c";
// 笔的形状压在图上有多重：瞄着的时候淡，正在调笔的时候重。
const TINT_AIMING = 0.4;
const TINT_SETTING = 0.62;

// 浏览器能直接给 canvas 加滤镜的一次调用；不能的时候（Safari）用一层画在画布
// 之外的自带影子。
const CAN_FILTER = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

export const ERASE_CSS = `
.qgtools-compare-erasebar{display:none;box-sizing:border-box;flex-wrap:wrap;align-items:center;gap:4px 6px;flex:none;min-height:${ERASE_BAR_HEIGHT}px;}
.qgtools-compare-root.is-erasing .qgtools-compare-erasebar{display:flex;}
.qgtools-compare-erasebar .qgtools-scrub{flex:none;}
.qgtools-compare-field{display:flex;align-items:center;gap:4px;flex:none;}
.qgtools-compare-label{flex:none;color:#9fb6b4;font-size:10px;line-height:22px;white-space:nowrap;user-select:none;}
.qgtools-compare-steps{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto;}
.qgtools-compare-saverow{display:none;box-sizing:border-box;flex-wrap:wrap;align-items:center;gap:4px 8px;flex:none;min-height:${SAVE_ROW_HEIGHT}px;}
.qgtools-compare-root.is-erasing .qgtools-compare-saverow{display:flex;}
.qgtools-compare-saveend{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px 8px;flex:none;max-width:100%;margin-left:auto;}
.qgtools-compare-stage.is-erasing{min-height:32px;}
.qgtools-compare-name{flex:1 1 110px;min-width:0;display:flex;align-items:center;gap:4px;}
.qgtools-compare-name input{box-sizing:border-box;flex:1 1 auto;min-width:40px;width:40px;height:24px;padding:0 7px;border:1px solid #3a4047;border-radius:5px;background:#0f1516;color:#d8eeee;font:11px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;outline:none;}
.qgtools-compare-name input:focus{border-color:${BRAND};}
.qgtools-compare-name input:disabled{color:#7f9896;border-style:dashed;}
.qgtools-compare-name input::placeholder{color:#5f7674;}
.qgtools-compare-savebtn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;gap:6px;height:${SAVE_ROW_HEIGHT}px;padding:0 14px 0 11px;border:1px solid ${BRAND};border-radius:6px;background:${BRAND};color:#04201d;font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.04em;cursor:pointer;box-shadow:0 0 9px rgba(0,180,170,.32);}
.qgtools-compare-savebtn:hover{background:#19cdc2;border-color:#19cdc2;}
.qgtools-compare-savebtn:disabled{background:#16302e;border-color:#23504c;color:#5f8a86;box-shadow:none;cursor:default;}
.qgtools-compare-copybtn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;gap:6px;height:${SAVE_ROW_HEIGHT}px;padding:0 12px 0 10px;border:1px solid rgba(0,180,170,.7);border-radius:6px;background:transparent;color:#7fe6dd;font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.04em;cursor:pointer;}
.qgtools-compare-copybtn:hover{background:rgba(0,180,170,.14);border-color:${BRAND};color:#b6fff8;}
.qgtools-compare-copybtn:disabled{border-color:#23504c;color:#5f8a86;background:transparent;cursor:default;}
.qgtools-compare-tool{box-sizing:border-box;height:22px;min-width:24px;padding:0 6px;border:1px solid rgba(0,180,170,.52);border-radius:4px;background:rgba(0,0,0,.66);color:#c8dddd;font:700 9px/20px "Segoe UI",sans-serif;cursor:pointer;}
.qgtools-compare-tool:hover{border-color:${BRAND};color:#fff;background:rgba(0,79,75,.78);}
.qgtools-compare-tool.active{border-color:${BRAND};background:${BRAND};color:#04201d;}
.qgtools-compare-tool:disabled{opacity:.42;cursor:default;pointer-events:none;}
.qgtools-compare-erase{position:absolute;inset:0;width:100%;height:100%;display:none;cursor:crosshair;touch-action:none;}
.qgtools-compare-stage.is-erasing:not(.is-empty) .qgtools-compare-erase{display:block;}
.qgtools-compare-stage.is-erasing img,.qgtools-compare-stage.is-erasing .qgtools-compare-seam,.qgtools-compare-stage.is-erasing .qgtools-compare-identity{display:none;}
`;

function sized(canvas, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return canvas.getContext("2d");
}

// 一笔画到遮罩上，`scale` 是一个遮罩像素对应几个图上像素。遮罩记的是上面那张
// 被擦掉多少：擦的一笔往上加，画回来的一笔往下减，各按自己的实心笔芯、模糊
// 到软边。
function drawStroke(ctx, stroke, scale) {
  const soft = stroke.s / 100;
  const core = Math.max(0.01, brushCore(stroke.d, soft) * scale);
  const sigma = brushSigma(stroke.d, soft) * scale;
  const path = stroke.p;
  let shift = 0;
  ctx.save();
  ctx.globalCompositeOperation = stroke.o ? "source-over" : "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = core * 2;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  if (sigma >= 0.25) {
    if (CAN_FILTER) {
      ctx.filter = `blur(${sigma.toFixed(3)}px)`;
    } else {
      // 挪得够远，笔迹本身永远落不到画布上。
      shift = Math.ceil(ctx.canvas.width + 2 * (ERASE_OUTSIDE * scale + core + 3 * sigma) + 16);
      ctx.shadowColor = "#000";
      ctx.shadowBlur = sigma * 2;
      ctx.shadowOffsetX = shift;
    }
  }
  ctx.beginPath();
  if (path.length === 2) {
    ctx.arc(path[0] * scale - shift, path[1] * scale, core, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(path[0] * scale - shift, path[1] * scale);
    for (let index = 2; index < path.length; index += 2) ctx.lineTo(path[index] * scale - shift, path[index + 1] * scale);
    ctx.stroke();
  }
  ctx.restore();
}

// 笔的一下，染成一个颜色：它的实心笔芯加软边，大小按视图里的来。笔或视图没变
// 就留着上次画的。
function dabOf(er, size, soft, scale, colour) {
  const key = `${size}|${soft}|${scale.toFixed(5)}|${colour}`;
  const reach = Math.ceil((brushCore(size, soft / 100) + 3 * brushSigma(size, soft / 100)) * scale) + 2;
  if (reach * 2 > 4096) return null;
  if (er.dabKey !== key) {
    const ctx = sized(er.dab, reach * 2, reach * 2);
    ctx.clearRect(0, 0, reach * 2, reach * 2);
    drawStroke(ctx, { o: 1, d: size, s: soft, p: [reach / scale, reach / scale] }, scale);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, reach * 2, reach * 2);
    ctx.globalCompositeOperation = "source-over";
    er.dabKey = key;
  }
  return { canvas: er.dab, reach };
}

function topOf(er) {
  return normalizeTop(er.node.properties?.[TOP_PROPERTY]);
}

function brushSize(er) {
  const stored = Number(er.node.properties?.[SIZE_PROPERTY]);
  // 没手动调过之前，笔跟着图走。
  return Number.isFinite(stored) && stored > 0 ? clampSize(stored) : defaultBrushSize(er.width, er.height);
}

function brushSoft(er) {
  const stored = er.node.properties?.[SOFT_PROPERTY];
  return stored == null ? ERASE_SOFT_DEFAULT : clampSoft(stored);
}

function setProperty(er, name, value) {
  er.node.properties ??= {};
  er.node.properties[name] = value;
}

// 把留着的每一笔重画一遍，拼出遮罩。
function rebuildMask(er) {
  const scale = er.maskScale = previewScale(er.width, er.height);
  const ctx = sized(er.mask, Math.max(1, Math.round(er.width * scale)), Math.max(1, Math.round(er.height * scale)));
  ctx.clearRect(0, 0, er.mask.width, er.mask.height);
  for (const stroke of er.strokes) drawStroke(ctx, stroke, scale);
}

function schedule(er) {
  if (er.frame || !er.active) return;
  er.frame = requestAnimationFrame(() => draw(er));
}

// 视图的像素跟着它在屏幕上的大小走，图放大看也清楚，但不会小于它的布局尺寸。
function sizeView(er) {
  const rect = er.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  let width = Math.max(rect.width, er.canvas.clientWidth) * ratio;
  let height = Math.max(rect.height, er.canvas.clientHeight) * ratio;
  const over = Math.max(width, height) / VIEW_SIDE;
  if (over > 1) {
    width /= over;
    height /= over;
  }
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  // 差几个像素不值得换一张画布。
  if (Math.abs(er.canvas.width - width) > 2 || Math.abs(er.canvas.height - height) > 2) {
    er.canvas.width = width;
    er.canvas.height = height;
  }
}

function draw(er) {
  er.frame = 0;
  if (!er.active || !er.refs) return;
  sizeView(er);
  const { canvas } = er;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const box = fitRect(canvas.width, canvas.height, er.width, er.height);
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const fit = er.fit = { left: Math.round(box.left), top: Math.round(box.top), width, height, scale: width / er.width };
  const [top, under] = topOf(er) === "B" ? [er.imageB, er.imageA] : [er.imageA, er.imageB];

  // 当前的遮罩：留着的笔画，加上正在画的那一笔。
  let mask = er.mask;
  if (er.stroke) {
    const live = sized(er.live, width, height);
    live.globalCompositeOperation = "copy";
    live.drawImage(er.mask, 0, 0, width, height);
    drawStroke(live, { o: er.stroke.back ? 0 : 1, d: er.stroke.size, s: er.stroke.soft, p: er.stroke.points.flat() }, fit.scale);
    mask = er.live;
  }
  // 上面那张减去遮罩，压到下面那张上。尺寸不同的图按 A 的尺寸贴，和保存时
  // 的混合一样。
  const cut = sized(er.cut, width, height);
  cut.globalCompositeOperation = "copy";
  cut.drawImage(top, 0, 0, width, height);
  cut.globalCompositeOperation = "destination-out";
  cut.drawImage(mask, 0, 0, width, height);
  ctx.drawImage(under, fit.left, fit.top, width, height);
  ctx.drawImage(er.cut, fit.left, fit.top);

  // 指针外面那支笔：形状染成一层（实心笔芯加软边），外加一个按它实际大小的
  // 圈。正在画的时候只留那个圈，免得盖住刚画的东西。
  const setting = er.adjust;
  const at = setting ? setting.anchor : er.pointer;
  if (at) {
    const size = er.stroke?.size ?? brushSize(er);
    const soft = er.stroke?.soft ?? brushSoft(er);
    const back = !setting && (er.stroke ? er.stroke.back : er.back !== Boolean(er.flipKey));
    const x = fit.left + at[0] * fit.scale;
    const y = fit.top + at[1] * fit.scale;
    const line = Math.max(1, canvas.width / Math.max(1, canvas.getBoundingClientRect().width));
    const dab = er.stroke ? null : dabOf(er, size, soft, fit.scale, back ? BACK_TINT : RUB_TINT);
    if (dab) {
      ctx.globalAlpha = setting ? TINT_SETTING : TINT_AIMING;
      ctx.drawImage(dab.canvas, Math.round(x - dab.reach), Math.round(y - dab.reach));
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, (size / 2) * fit.scale), 0, Math.PI * 2);
    ctx.lineWidth = 3 * line;
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.stroke();
    ctx.lineWidth = 1.3 * line;
    ctx.strokeStyle = back ? BACK_RING : RUB_RING;
    ctx.stroke();
    if (setting) {
      // 实心笔芯到头的地方：软边变软变硬时，动的是这个圈。
      const core = brushCore(size, soft / 100) * fit.scale;
      if (core >= 2) {
        ctx.beginPath();
        ctx.arc(x, y, core, 0, Math.PI * 2);
        ctx.setLineDash([4 * line, 4 * line]);
        ctx.lineWidth = 1.2 * line;
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 两个值写在笔下面，正在调的那个是白的。
      const axis = setting.drag.axis;
      const words = brushWords(size, soft);
      const parts = [[words[0], axis !== "soft"], [words[1], axis !== "size"]];
      ctx.font = `600 ${Math.round(11 * line)}px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const gap = 10 * line;
      const widths = parts.map(([text]) => ctx.measureText(text).width);
      const width = widths[0] + widths[1] + gap + 14 * line;
      const height = 18 * line;
      const rim = Math.max(1.5, (size / 2) * fit.scale);
      const below = y + rim + 8 * line + height <= canvas.height;
      const top = Math.max(2 * line, below ? y + rim + 8 * line : y - height / 2);
      const left = Math.min(canvas.width - width - 2 * line, Math.max(2 * line, x - width / 2));
      ctx.fillStyle = "rgba(0,0,0,.74)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(left, top, width, height, 4 * line);
      else ctx.rect(left, top, width, height);
      ctx.fill();
      let textLeft = left + 7 * line;
      parts.forEach(([text, lit], index) => {
        ctx.fillStyle = lit ? "#eafffd" : "#7f9896";
        ctx.fillText(text, textLeft, top + height / 2 + line * 0.5);
        textLeft += widths[index] + gap;
      });
    }
  }
}

// 指针在图上的位置，单位是图上像素。
function pointOf(er, event) {
  const rect = er.canvas.getBoundingClientRect();
  const fit = er.fit;
  if (!(rect.width > 0) || !(rect.height > 0) || !(fit?.scale > 0)) return null;
  const x = ((event.clientX - rect.left) / rect.width) * er.canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * er.canvas.height;
  return [(x - fit.left) / fit.scale, (y - fit.top) / fit.scale];
}

// 节点的 filename 输入上接着线吗？接着的话文件名由这次运行说了算，节点上的
// 名字框只显示它。
function nameIsWired(er) {
  return er.node.inputs?.some((input) => input?.name === "filename" && input.link != null) ?? false;
}

function syncTools(er) {
  const ready = Boolean(er.refs);
  const top = topOf(er);
  const other = top === "A" ? "B" : "A";
  er.kindSwitch.set(er.back !== Boolean(er.flipKey) ? "restore" : "erase");
  er.kindSwitch.describe("erase", { title: `画笔把 ${top} 擦掉，露出 ${other}。按住 Ctrl，或按鼠标右键，改成画回来。` });
  er.kindSwitch.describe("restore", { title: `画笔把 ${top} 画回来。按住 Ctrl，或按鼠标右键，改成擦掉。` });
  er.topSwitch.set(top);
  const layers = er.node.properties?.[LAYERS_PROPERTY] === true;
  er.layersSwitch.set(layers ? "on" : "off");
  const aligned = Boolean(er.refs?.aligned);
  er.alignButton.disabled = !ready || er.aligning;
  er.alignButton.textContent = er.aligning ? "对齐中" : "对齐";
  er.alignButton.classList.toggle("active", aligned);
  er.alignButton.title = !ready
    ? "先运行一次工作流：对齐需要那两张图。"
    : aligned
      ? "B 已经对齐到 A 了。再点一下回到 B 原来的样子。"
      : "对齐：模型把图画得偏了一点或放大了一点时，把 B 对齐到 A。再点一下撤销。";
  er.undoButton.disabled = !er.history.length && !er.strokes.length;
  er.clearButton.disabled = !er.strokes.length;
  er.saveButton.disabled = !ready || er.saving;
  er.saveLabel.textContent = er.saving ? "保存中" : "保存";
  er.copyButton.disabled = !ready || er.copying;
  er.copyLabel.textContent = er.copying ? "复制中" : "复制";
  er.copyButton.title = ready
    ? "把这张混合图按原尺寸复制到剪贴板，可以直接粘进编辑器或聊天窗。不会存文件。"
    : "先运行一次工作流：复制需要那两张图。";
  // 名字：在这里打，或者显示运行从输入里拿到的那个。
  const wired = nameIsWired(er);
  const typed = String(er.node.properties?.[NAME_PROPERTY] ?? "");
  er.nameInput.disabled = wired;
  if (wired) er.nameInput.value = er.refs?.name || "";
  else if (document.activeElement !== er.nameInput) er.nameInput.value = typed;
  er.nameInput.placeholder = wired ? "来自 filename 输入" : "compare";
  const hint = nameHint(wired ? er.refs?.name : typed, layers);
  er.nameInput.title = wired
    ? `文件名由 filename 输入决定：${hint}。它们写进 ComfyUI 的 output 目录。`
    : `保存的文件叫什么。保存会把 ${hint} 写进 ComfyUI 的 output 目录，编号会往后数。可用字母、数字、空格、点、横线和下划线。`;
  er.saveButton.title = ready
    ? `把这张混合图存进 ComfyUI 的 output 目录，文件名 ${hint}。不会重新运行。`
    : "先运行一次工作流：保存需要那两张图。";
}

// 笔画跟着节点存，这样切标签页或者 ComfyUI 自己撤销时还找得回来。
function keep(er) {
  setProperty(er, PAINT_PROPERTY, { w: er.width, h: er.height, strokes: er.strokes });
  notifyQgChange();
}

function change(er, strokes) {
  er.history.push(er.strokes);
  if (er.history.length > UNDO_KEPT) er.history.shift();
  er.strokes = strokes;
  keep(er);
  syncTools(er);
}

function finishStroke(er, event, cancelled) {
  const stroke = er.stroke;
  if (!stroke || (event && event.pointerId !== stroke.id)) return;
  er.stroke = null;
  try { er.canvas.releasePointerCapture?.(stroke.id); } catch { /* 已经松开了 */ }
  if (!cancelled) {
    const made = makeStroke(stroke.points, { erase: !stroke.back, size: stroke.size, soft: stroke.soft }, er.width, er.height);
    if (made && strokeFits(er.strokes, made)) {
      change(er, [...er.strokes, made]);
      drawStroke(er.mask.getContext("2d"), made, er.maskScale);
    } else if (made) {
      showToast({ severity: "warn", detail: "这张混合图能装下的笔迹已经到顶了。先保存，或者按「清空」重来。" });
    }
  }
  schedule(er);
}

function setSize(er, size) {
  const next = clampSize(size);
  if (er.node.properties?.[SIZE_PROPERTY] === next) return;
  setProperty(er, SIZE_PROPERTY, next);
  er.sizeBox.set(next);
  schedule(er);
}

function setSoft(er, soft) {
  const next = clampSoft(soft);
  if (er.node.properties?.[SOFT_PROPERTY] === next) return;
  setProperty(er, SOFT_PROPERTY, next);
  er.softBox.set(next);
  schedule(er);
}

// 调笔的拖拽结束了：留下它调出来的值，或者把笔放回去。
function finishAdjust(er, event, cancelled) {
  const adjust = er.adjust;
  if (!adjust || (event && event.pointerId !== adjust.id)) return;
  er.adjust = null;
  try { er.canvas.releasePointerCapture?.(adjust.id); } catch { /* 已经松开了 */ }
  if (cancelled) {
    setSize(er, adjust.size);
    setSoft(er, adjust.soft);
  } else if (brushSize(er) !== adjust.size || brushSoft(er) !== adjust.soft) {
    notifyQgChange();
  }
  schedule(er);
}

function onKey(er, event, down) {
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  // Alt 是调笔的拖拽用的键。拦住浏览器，不然它会弹出自己的菜单。
  if (event.key === "Alt") {
    event.preventDefault();
    return;
  }
  // Ctrl 按着的时候做当前工具的反面。
  if (event.key === "Control") {
    er.flipKey = down;
    syncTools(er);
    schedule(er);
    return;
  }
  // Ctrl+Z 和 Ctrl+Y 还是 ComfyUI 自己的：一笔也是对这个图的一次改动，它的
  // 撤销连笔画一起退。
  if (!down || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape" && (er.stroke || er.adjust)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    finishStroke(er, null, true);
    finishAdjust(er, null, true);
    return;
  }
  // [ 和 ] 改大小，加 Shift 改软边，和 Photoshop 一样。
  const key = brushKey(event);
  if (key) {
    event.preventDefault();
    event.stopPropagation();
    if (key.what === "soft") setSoft(er, steppedSoft(brushSoft(er), key.up));
    else setSize(er, steppedSize(brushSize(er), key.up));
    notifyQgChange();
    return;
  }
  // E 擦、B 把上面那张画回来，和「按触摸画遮罩」一致。
  const tool = toolKey(event);
  if ((tool === "erase" || tool === "paint") && !er.stroke && !er.adjust) {
    event.preventDefault();
    event.stopPropagation();
    er.back = tool === "paint";
    syncTools(er);
    schedule(er);
  }
}

function installPointer(er, signal) {
  const { canvas } = er;
  canvas.addEventListener("pointerdown", (event) => {
    // 中键平移画布，和其它地方一样。
    if (!er.refs || (event.button !== 0 && event.button !== 2) || er.stroke || er.adjust) return;
    const point = pointOf(er, event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    try { canvas.setPointerCapture?.(event.pointerId); } catch { /* 指针已经没了 */ }
    er.pointer = point;
    // Alt 加右键一起按下是调笔（Mac 上是 Control 加 Option 点一下）。只有 Ctrl
    // 或只有右键，是做当前工具的反面。
    if (brushAdjusts(event)) {
      const rect = canvas.getBoundingClientRect();
      er.adjust = {
        id: event.pointerId,
        // 按下去之前的笔，给 Escape 用，以及正在走的这次拖拽。
        size: brushSize(er),
        soft: brushSoft(er),
        drag: startAdjust(event.clientX, event.clientY, { size: brushSize(er), soft: brushSoft(er) }),
        anchor: point,
        // 屏幕一个像素对应几个图上像素。
        perPixel: canvas.width / Math.max(1, rect.width) / er.fit.scale,
      };
      schedule(er);
      return;
    }
    er.stroke = {
      id: event.pointerId,
      back: er.back !== brushFlips(event),
      size: brushSize(er),
      soft: brushSoft(er),
      points: [point],
    };
    schedule(er);
  }, { signal });
  canvas.addEventListener("pointermove", (event) => {
    const point = pointOf(er, event);
    if (!point) return;
    er.pointer = point;
    const adjust = er.adjust;
    if (adjust && event.pointerId === adjust.id) {
      adjust.drag = moveAdjust(adjust.drag, event.clientX, event.clientY, adjust.perPixel);
      setSize(er, adjust.drag.brush.size);
      setSoft(er, adjust.drag.brush.soft);
      schedule(er);
      return;
    }
    if (er.flipKey !== event.ctrlKey) {
      er.flipKey = event.ctrlKey;
      syncTools(er);
    }
    const stroke = er.stroke;
    if (stroke && event.pointerId === stroke.id) extendStroke(stroke.points, point[0], point[1], Math.max(1, stroke.size / 12));
    schedule(er);
  }, { signal });
  canvas.addEventListener("pointerup", (event) => { finishStroke(er, event, false); finishAdjust(er, event, false); }, { signal });
  canvas.addEventListener("pointercancel", (event) => { finishStroke(er, event, true); finishAdjust(er, event, true); }, { signal });
  canvas.addEventListener("pointerenter", () => {
    if (er.keys) return;
    er.keys = new AbortController();
    const options = { signal: er.keys.signal, capture: true };
    window.addEventListener("keydown", (event) => onKey(er, event, true), options);
    window.addEventListener("keyup", (event) => onKey(er, event, false), options);
  }, { signal });
  canvas.addEventListener("pointerleave", () => {
    if (er.stroke || er.adjust) return;
    er.keys?.abort();
    er.keys = null;
    er.pointer = null;
    er.flipKey = false;
    syncTools(er);
    schedule(er);
  }, { signal });
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { signal });
  signal.addEventListener("abort", () => er.keys?.abort());
}

async function save(er) {
  if (er.saving || !er.refs) return;
  er.saving = true;
  syncTools(er);
  try {
    const response = await api.fetchApi(SAVE_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saveRequest({
        pair: er.refs.pair,
        top: topOf(er),
        strokes: er.strokes,
        layers: er.node.properties?.[LAYERS_PROPERTY] === true,
        name: er.node.properties?.[NAME_PROPERTY],
      })),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok) {
      // 路由没话可说：这个 ComfyUI 是在更新之前启动的。
      const missing = (response.status === 404 || response.status === 405) && !answer?.error;
      throw new Error(missing ? "重启一次 ComfyUI 再保存：这次更新只加载了一半。" : (answer?.error || `服务器答复 ${response.status}。`));
    }
    showToast({ severity: "success", summary: "图像对比", detail: savedMessage(answer?.files) });
    er.onSaved?.(answer?.files ?? []);
  } catch (error) {
    showToast({ severity: "error", summary: "图像对比", detail: String(error?.message ?? error), life: 8000 });
  } finally {
    er.saving = false;
    syncTools(er);
  }
}

// 把混合图做成 PNG，在这里按原图尺寸拼：笔画照视图的算法画，一个遮罩像素对
// 一个图上像素。
function mixBlob(er) {
  const { width, height } = er;
  const [top, under] = topOf(er) === "B" ? [er.imageB, er.imageA] : [er.imageA, er.imageB];
  const mask = document.createElement("canvas");
  const maskCtx = sized(mask, width, height);
  for (const stroke of er.strokes) drawStroke(maskCtx, stroke, 1);
  const cut = document.createElement("canvas");
  const cutCtx = sized(cut, width, height);
  cutCtx.drawImage(top, 0, 0, width, height);
  cutCtx.globalCompositeOperation = "destination-out";
  cutCtx.drawImage(mask, 0, 0);
  const out = document.createElement("canvas");
  const ctx = sized(out, width, height);
  ctx.drawImage(under, 0, 0, width, height);
  ctx.drawImage(cut, 0, 0);
  return new Promise((resolve, reject) => {
    out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("浏览器没能做出这张图。"))), "image/png");
  });
}

// 让服务器把 B 对齐到 A（用的就是「对齐到原图」那套量法），或者退回 B 原来的
// 样子。面板自己换图；之后的保存和复制用的都是对齐后的 B，笔画留在原地。
async function align(er) {
  if (er.aligning || !er.refs) return;
  if (er.refs.aligned) {
    er.onAligned?.(er.refs.original);
    return;
  }
  er.aligning = true;
  syncTools(er);
  try {
    const response = await api.fetchApi(ALIGN_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pair: er.refs.pair }),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok) {
      // 路由没有回话：这个 ComfyUI 是在更新之前启动的。
      const missing = (response.status === 404 || response.status === 405) && !answer?.error;
      throw new Error(missing ? "重启一次 ComfyUI 再对齐：QG-tools 的更新只加载了一半。" : (answer?.error || `服务器回了 ${response.status}。`));
    }
    if (answer?.aligned && answer.b?.filename && typeof answer.pair === "string") {
      showToast({ severity: "success", summary: "图像对比", detail: answer.message, life: 4000 });
      er.onAligned?.({ ...er.refs, b: answer.b, pair: answer.pair, aligned: true, original: er.refs });
    } else {
      showToast({ severity: "info", summary: "图像对比", detail: answer?.message || "B 保持原样。", life: 6000 });
    }
  } catch (error) {
    showToast({ severity: "error", summary: "图像对比", detail: String(error?.message ?? error), life: 8000 });
  } finally {
    er.aligning = false;
    syncTools(er);
  }
}

// 把混合图复制到剪贴板。浏览器只允许以 localhost 或 https 打开的页面往剪贴板
// 写图片。
function copy(er) {
  if (er.copying || !er.refs) return;
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    showToast({
      severity: "warn",
      summary: "图像对比",
      detail: "这个浏览器只允许以 localhost 或 https 打开的页面复制图片。保存不受影响，哪里都能用。",
      life: 8000,
    });
    return;
  }
  er.copying = true;
  syncTools(er);
  const picture = mixBlob(er);
  // 图片要在这次点击里就开始写：Safari 只认点击，而大图要算一会儿。
  let write;
  try {
    write = navigator.clipboard.write([new ClipboardItem({ "image/png": picture })]);
  } catch {
    write = picture.then((blob) => navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]));
  }
  write.then(
    () => showToast({ severity: "success", summary: "图像对比", detail: "混合图已经在剪贴板里了，粘进编辑器或聊天窗就行。", life: 3000 }),
    (error) => showToast({
      severity: "error",
      summary: "图像对比",
      detail: error?.name === "NotAllowedError"
        ? "浏览器没让这个页面复制图片。保存不受影响，哪里都能用。"
        : `复制混合图失败：${error?.message ?? error}`,
      life: 8000,
    }),
  ).finally(() => {
    er.copying = false;
    syncTools(er);
  });
}

function makeToolButton(label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "qgtools-compare-tool";
  button.textContent = label;
  button.title = title;
  return button;
}

// 给一个对比面板做一套橡皮擦工具。`onSaved` 会拿到保存写了哪些文件。调用方
// 把 `bar` 放在台面上方、`saveRow` 放在它下面一行，模式或图片变了就告诉它。
export function makeEraser({ node, root, stage, imageA, imageB, signal, onSaved, onAligned }) {
  const er = {
    node, root, stage, imageA, imageB, onSaved, onAligned,
    canvas: document.createElement("canvas"),
    mask: document.createElement("canvas"),
    live: document.createElement("canvas"),
    cut: document.createElement("canvas"),
    dab: document.createElement("canvas"),
    dabKey: "",
    maskScale: 1,
    refs: null, width: 0, height: 0, fit: null,
    strokes: [], history: [],
    active: false, stroke: null, adjust: null, pointer: null, back: false, flipKey: false,
    saving: false, copying: false, aligning: false, frame: 0, keys: null,
  };
  er.canvas.className = "qgtools-compare-erase";
  stage.append(er.canvas);

  const click = (button, action) => {
    button.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action(event);
    }, { signal });
    return button;
  };

  const labelled = (name, help, ...controls) => {
    const wrap = document.createElement("div");
    wrap.className = "qgtools-compare-field";
    const label = document.createElement("span");
    label.className = "qgtools-compare-label";
    label.textContent = name;
    label.title = help;
    wrap.append(label, ...controls);
    return { wrap, label };
  };

  // 图上面那行工具：画笔画什么、它多大、边多软、哪张图在上面，以及撤销。
  er.bar = document.createElement("div");
  er.bar.className = "qgtools-compare-erasebar";
  er.kindSwitch = makeSlideSwitch({
    label: "画笔做什么",
    options: [{ value: "erase", label: "擦掉" }, { value: "restore", label: "画回" }],
    value: "erase",
    signal,
    onChange: (value) => { er.back = value === "restore"; syncTools(er); schedule(er); },
  });
  const SIZE_HELP = "笔有多宽，单位是图上像素。在这里或数字上拖动就能改。也可以用 [ 和 ] 键，或者按住 Alt 加鼠标右键在图上左右拖。";
  const SOFT_HELP = "笔边有多软：0 是硬边，100 从最中间就开始淡。在这里或数字上拖动就能改。也可以用 Shift 加 [ ]，或者按住 Alt 加鼠标右键在图上上下拖（往上软、往下硬）。";
  er.sizeBox = makeScrubInput({
    value: brushSize(er),
    min: ERASE_SIZE[0],
    max: ERASE_SIZE[1],
    step: 2,
    fineStep: 1,
    decimals: 0,
    width: 66,
    unit: "px",
    title: SIZE_HELP,
    onChange: (value) => setSize(er, value),
    onSettle: () => notifyQgChange(),
  });
  er.softBox = makeScrubInput({
    value: brushSoft(er),
    min: 0,
    max: 100,
    step: 5,
    fineStep: 1,
    decimals: 0,
    width: 58,
    unit: "%",
    title: SOFT_HELP,
    onChange: (value) => { setProperty(er, SOFT_PROPERTY, clampSoft(value)); schedule(er); },
    onSettle: () => notifyQgChange(),
  });
  // 每个数字前面带自己的名字。名字也能拖着改数字，盒子里的单位也算：整个字段
  // 就是一个把手。
  const scrubField = (name, box, help) => {
    const { wrap, label } = labelled(name, help, box.root);
    box.input.setAttribute("aria-label", name);
    box.handle(label);
    box.handle(box.root);
    wrap.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    return wrap;
  };
  const sizeField = scrubField("笔宽", er.sizeBox, SIZE_HELP);
  const softField = scrubField("软度", er.softBox, SOFT_HELP);
  const TOP_HELP = "从哪张图开始看。画笔把另一张透出来。换的时候画好的笔迹留着。";
  er.topSwitch = makeSlideSwitch({
    label: "上面那张图",
    options: [{ value: "A", label: "A", title: "A 在上面；画笔露出 B。" }, { value: "B", label: "B", title: "B 在上面；画笔露出 A。" }],
    value: topOf(er),
    signal,
    onChange: (value) => {
      if (value === topOf(er)) return;
      setProperty(er, TOP_PROPERTY, value);
      notifyQgChange();
      syncTools(er);
      schedule(er);
    },
  });
  const topField = labelled("在上面", TOP_HELP, er.topSwitch.root).wrap;
  // 对齐、撤销、清空贴在一起，放在右端，折行时也还在一起。
  const steps = document.createElement("div");
  steps.className = "qgtools-compare-steps";
  er.undoButton = click(makeToolButton("撤销", "撤掉最后一笔，或者一次清空。"), () => {
    if (!er.history.length && !er.strokes.length) return;
    // 跟着工作流一起进来的笔迹没有自己的步骤可退：就把它最后一笔拿掉。
    er.strokes = er.history.length ? er.history.pop() : er.strokes.slice(0, -1);
    keep(er);
    rebuildMask(er);
    syncTools(er);
    schedule(er);
  });
  er.clearButton = click(makeToolButton("清空", "把笔迹全去掉。撤销能拿回来。"), () => {
    if (!er.strokes.length) return;
    change(er, []);
    rebuildMask(er);
    schedule(er);
  });
  er.alignButton = click(makeToolButton("对齐", ""), () => align(er));
  steps.append(er.alignButton, er.undoButton, er.clearButton);
  er.bar.append(er.kindSwitch.root, sizeField, softField, topField, steps);

  // 图下面那行保存：名字、要不要图层、右端（眼睛最后落到的地方）的保存。
  er.saveRow = document.createElement("div");
  er.saveRow.className = "qgtools-compare-saverow";
  const nameField = labelled("名字", "保存的文件叫什么。");
  nameField.wrap.classList.add("qgtools-compare-name");
  er.nameInput = document.createElement("input");
  er.nameInput.type = "text";
  er.nameInput.spellcheck = false;
  er.nameInput.maxLength = 80;
  er.nameInput.setAttribute("aria-label", "文件名");
  er.nameInput.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
  er.nameInput.addEventListener("keydown", (event) => {
    keepKeyInField(event);
    if (event.key === "Enter" || event.key === "Escape") er.nameInput.blur();
  }, { signal });
  er.nameInput.addEventListener("input", () => {
    // 只有文件名能装下的字符留得下来，边打边筛。
    const clean = typedName(er.nameInput.value);
    if (clean !== er.nameInput.value) er.nameInput.value = clean;
    setProperty(er, NAME_PROPERTY, clean);
  }, { signal });
  er.nameInput.addEventListener("change", () => { notifyQgChange(); syncTools(er); }, { signal });
  nameField.wrap.append(er.nameInput);
  const LAYERS_HELP = "开：保存时另写一个 PSD，两张图各一层、笔迹作上面那层的图层蒙版，给 Photoshop 或 GIMP 用，遮罩再单独存一张 PNG。关：只存 PNG。";
  er.layersSwitch = makeSlideSwitch({
    label: "另存一个带图层的 PSD",
    offLeft: true,
    options: [{ value: "off", label: "关", title: LAYERS_HELP }, { value: "on", label: "开", title: LAYERS_HELP }],
    value: "off",
    signal,
    onChange: (value) => {
      setProperty(er, LAYERS_PROPERTY, value === "on");
      notifyQgChange();
      syncTools(er);
    },
  });
  const layersField = labelled("PSD", LAYERS_HELP, er.layersSwitch.root).wrap;
  er.saveButton = document.createElement("button");
  er.saveButton.type = "button";
  er.saveButton.className = "qgtools-compare-savebtn";
  er.saveButton.innerHTML = SAVE_ICON;
  er.saveLabel = document.createElement("span");
  er.saveLabel.textContent = "保存";
  er.saveButton.append(er.saveLabel);
  click(er.saveButton, () => save(er));
  er.copyButton = document.createElement("button");
  er.copyButton.type = "button";
  er.copyButton.className = "qgtools-compare-copybtn";
  er.copyButton.innerHTML = COPY_ICON;
  er.copyLabel = document.createElement("span");
  er.copyLabel.textContent = "复制";
  er.copyButton.append(er.copyLabel);
  click(er.copyButton, () => copy(er));
  // PSD 开关、复制和保存贴在右端一起。
  const saveEnd = document.createElement("div");
  saveEnd.className = "qgtools-compare-saveend";
  saveEnd.append(layersField, er.copyButton, er.saveButton);
  er.saveRow.append(nameField.wrap, saveEnd);

  installPointer(er, signal);
  const resized = new ResizeObserver(() => schedule(er));
  resized.observe(stage);
  signal.addEventListener("abort", () => {
    resized.disconnect();
    if (er.frame) cancelAnimationFrame(er.frame);
    er.frame = 0;
    er.active = false;
  });
  syncTools(er);

  return {
    bar: er.bar,
    saveRow: er.saveRow,
    get active() { return er.active; },
    // 开 / 关橡皮擦模式。
    setActive(on) {
      er.active = Boolean(on);
      root.classList.toggle("is-erasing", er.active);
      stage.classList.toggle("is-erasing", er.active);
      if (!er.active) {
        finishStroke(er, null, true);
        finishAdjust(er, null, true);
      }
      syncTools(er);
      schedule(er);
    },
    // 两张图都上来了（或者传 null，表示正在来）。笔迹从节点上读，只在图的尺寸
    // 没变时留下。
    setPictures(refs) {
      const ready = Boolean(refs && imageA.naturalWidth > 0 && imageB.naturalWidth > 0);
      er.refs = ready ? refs : null;
      finishStroke(er, null, true);
      finishAdjust(er, null, true);
      if (ready) {
        const width = imageA.naturalWidth;
        const height = imageA.naturalHeight;
        const stored = er.node.properties?.[PAINT_PROPERTY];
        // 还是同一张尺寸的图，笔迹也是这块面板自己写进去的：不用重读，撤销
        // 的步骤也留着。
        const same = width === er.width && height === er.height && stored?.strokes === er.strokes;
        er.width = width;
        er.height = height;
        er.fit = null;
        if (!same) {
          er.strokes = readPaint(stored, width, height).strokes;
          er.history = [];
          rebuildMask(er);
        }
      }
      er.sizeBox.set(brushSize(er));
      er.softBox.set(brushSoft(er));
      syncTools(er);
      schedule(er);
    },
    redraw: () => schedule(er),
    // 外面有东西改了工具该显示的状态（filename 输入上接了一根线）。
    refresh: () => syncTools(er),
  };
}

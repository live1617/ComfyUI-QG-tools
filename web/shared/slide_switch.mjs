// 一个并排选项、带滑块标记的切换条：图像对比的模式行用它。
// 各选项等宽时标记只要平移；`fit` 时每个选项按自己的字宽，标记要量。
//
// 移植自 ComfyUI-AusBoss（MIT，js/shared/slide_switch.mjs）。

import { BRAND } from "./index.mjs?v=2026102420";

const CSS_ID = "qgtools-slide-switch-css";

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.qgtools-slide{position:relative;box-sizing:border-box;flex:none;display:grid;grid-auto-flow:column;grid-auto-columns:1fr;height:24px;padding:2px;border:1px solid #2a3437;border-radius:6px;background:#0f1516;}
.qgtools-slide.fit{grid-auto-columns:max-content;}
.qgtools-slide.fit button{padding:0 7px;}
.qgtools-slide-mark{position:absolute;top:2px;bottom:2px;left:2px;border-radius:4px;background:${BRAND};box-shadow:0 0 7px rgba(0,180,170,.3);transition:transform .16s ease,width .16s ease;pointer-events:none;}
.qgtools-slide.none .qgtools-slide-mark{display:none;}
.qgtools-slide button{position:relative;box-sizing:border-box;min-width:0;height:100%;margin:0;padding:0 9px;border:none;border-radius:4px;background:transparent;color:#8ba3a1;font:700 10px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em;white-space:nowrap;cursor:pointer;transition:color .16s ease;}
.qgtools-slide button:hover{color:#fff;}
.qgtools-slide button.on,.qgtools-slide button.on:hover{color:#04201d;}
.qgtools-slide.off-left button.on:first-of-type,.qgtools-slide.off-left button.on:first-of-type:hover{color:#d8eeee;}
.qgtools-slide.off-left.is-off .qgtools-slide-mark{background:#33423f;box-shadow:none;}
.qgtools-slide button:focus-visible{outline:1px solid ${BRAND};outline-offset:1px;}
@media (prefers-reduced-motion: reduce){.qgtools-slide-mark,.qgtools-slide button{transition:none;}}
`;
  document.head.appendChild(style);
}

// options: [{ value, label, title }]。`label` 是给读屏用的整条名字。
// `offLeft` 给「关 | 开」这种一对：关着时标记是灰的，只有「开」是青色。
// onChange(value) 在点某个选项时触发，点已选中的那个也触发。
export function makeSlideSwitch({ options, value, label = "", offLeft = false, fit = false, onChange, signal } = {}) {
  ensureCss();
  const root = document.createElement("div");
  root.className = `qgtools-slide${offLeft ? " off-left" : ""}${fit ? " fit" : ""}`;
  root.setAttribute("role", "radiogroup");
  if (label) root.setAttribute("aria-label", label);
  const mark = document.createElement("div");
  mark.className = "qgtools-slide-mark";
  if (!fit) mark.style.width = `calc((100% - 4px) / ${options.length})`;
  root.append(mark);
  const buttons = new Map();
  let current;
  // 选项各按自己的字宽：标记取选中那个的位置和宽度，从页面上量。
  const measure = () => {
    const button = buttons.get(current);
    if (!fit || !button || !button.offsetWidth) return;
    mark.style.width = `${button.offsetWidth}px`;
    mark.style.transform = `translateX(${button.offsetLeft - 2}px)`;
  };
  const show = (next) => {
    current = next;
    const index = options.findIndex((option) => option.value === next);
    root.classList.toggle("none", index < 0);
    root.classList.toggle("is-off", index === 0);
    if (fit) measure();
    else mark.style.transform = `translateX(${Math.max(0, index) * 100}%)`;
    for (const [key, button] of buttons) {
      const on = key === next;
      button.classList.toggle("on", on);
      button.setAttribute("aria-checked", String(on));
    }
  };
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.textContent = option.label;
    if (option.title) button.title = option.title;
    // 在这里拦住，按切换条不会顺手拖动节点。
    button.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onChange?.(option.value);
    }, { signal });
    buttons.set(option.value, button);
    root.append(button);
  }
  show(value);
  if (fit && typeof ResizeObserver !== "undefined") {
    // 还没上页面时量不到任何东西。
    const seen = new ResizeObserver(measure);
    seen.observe(root);
    signal?.addEventListener("abort", () => seen.disconnect());
  }
  return {
    root,
    get: () => current,
    // 只挪标记，不触发 onChange：点什么、点完停在哪由调用方决定。
    set: show,
    // 选项的字可以跟着节点状态变（比如哪张图在上面）。
    describe(key, { label: text, title } = {}) {
      const button = buttons.get(key);
      if (!button) return;
      if (text !== undefined) button.textContent = text;
      if (title !== undefined) button.title = title;
    },
    disable(disabled) {
      for (const button of buttons.values()) button.disabled = Boolean(disabled);
    },
  };
}

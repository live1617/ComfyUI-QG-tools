// Show/hide standard canvas widgets in place. Hiding keeps the widget (and
// its serialized value) in the widgets array — only its rendering collapses —
// so widgets_values order never changes and saved workflows stay compatible.
// Pure widget-object surgery, no DOM: testable under node:test.
//
// Two renderers, two switches. The classic canvas lays widgets out by
// computeSize / computeLayoutSize and paints them with draw, so those are
// zeroed. The Nodes 2.0 renderer ignores all of that and filters its widget
// list on `widget.options.hidden` instead, so that flag is set as well - a
// panel's hidden storage widget stays hidden whichever renderer is on.

const STASH = "__qgVisibilityStash";

// Collapse a widget to zero height. Returns true when this call changed
// visibility, false when it was already hidden (callers use the return to
// skip a needless node resize).
export function hideWidget(widget) {
  if (!widget) return false;
  if (widget[STASH]) {
    // Already hidden: re-assert the renderer flag, which the frontend
    // drops whenever it rebuilds the options object from the node spec.
    if (widget.options) widget.options.hidden = true;
    return false;
  }
  let options = widget.options ?? {};
  widget[STASH] = {
    computeSize: widget.computeSize,
    computeLayoutSize: widget.computeLayoutSize,
    draw: widget.draw,
    hidden: widget.hidden,
    optionsHidden: options.hidden,
    optionsDescriptor: Object.getOwnPropertyDescriptor(widget, "options"),
  };
  widget.hidden = true;
  options.hidden = true;
  // The frontend swaps a widget's options object after creation (the
  // after-generate control does, and so does a workflow restore), which
  // would drop the flag. An accessor keeps re-applying it to whatever
  // object is assigned, so the widget stays hidden under Nodes 2.0.
  try {
    Object.defineProperty(widget, "options", {
      configurable: true,
      enumerable: true,
      get: () => options,
      set: (next) => {
        options = next ?? {};
        options.hidden = true;
      },
    });
  } catch {
    widget.options = options;
  }
  widget.computeSize = () => [0, -4];
  widget.computeLayoutSize = () => ({ minWidth: 0, minHeight: 0 });
  widget.draw = () => {};
  return true;
}

// Restore a widget hidden by hideWidget. Returns true when this call changed
// visibility, false when the widget was never hidden.
export function showWidget(widget) {
  const stash = widget?.[STASH];
  if (!stash) return false;
  widget.computeSize = stash.computeSize;
  widget.computeLayoutSize = stash.computeLayoutSize;
  widget.draw = stash.draw;
  widget.hidden = stash.hidden;
  const options = widget.options;
  try {
    delete widget.options; // drop the accessor, then put a plain property back
  } catch {
    // Not configurable: the accessor stays and keeps the flag; nothing to do.
  }
  if (stash.optionsDescriptor && "value" in stash.optionsDescriptor) {
    Object.defineProperty(widget, "options", { ...stash.optionsDescriptor, value: options });
  } else {
    widget.options = options;
  }
  if (widget.options) {
    if (stash.optionsHidden === undefined) delete widget.options.hidden;
    else widget.options.hidden = stash.optionsHidden;
  }
  widget[STASH] = undefined;
  return true;
}

// Drive a widget toward a target visibility; true when anything changed.
export function setWidgetVisible(widget, visible) {
  return visible ? showWidget(widget) : hideWidget(widget);
}

// Core's image-upload helper installs a preview widget under this name and
// keeps a `node.imgs` list beside it; it draws both.
const CORE_IMAGE_PREVIEW_WIDGET = "$$canvas-image-preview";

// Keep only a node's own picture. This drops core's preview widget, refuses a
// later one (the helper can add it after a node's creation hook), and turns
// `imgs` into a no-op that still reports "a picture arrived" — the mask editor
// sets it right after it writes the file it saved, which is exactly when a
// panel has to reload. `followImage` is that callback.
export function suppressCoreImagePreview(node, followImage = null) {
  if (!node) return;
  const previewIndex = node.widgets?.findIndex((item) => item.name === CORE_IMAGE_PREVIEW_WIDGET) ?? -1;
  if (previewIndex >= 0) {
    node.widgets[previewIndex].onRemove?.();
    node.widgets.splice(previewIndex, 1);
  }
  if (node.__qgImgsSuppressed) {
    if (followImage) node.__qgFollowImage = followImage;
    return;
  }
  node.__qgImgsSuppressed = true;
  node.__qgFollowImage = followImage;
  node.__qgAddCustomWidget = node.addCustomWidget;
  if (typeof node.addCustomWidget === "function") {
    node.addCustomWidget = function (customWidget) {
      if (customWidget?.name === CORE_IMAGE_PREVIEW_WIDGET) hideWidget(customWidget);
      return node.__qgAddCustomWidget.call(this, customWidget);
    };
  }
  node.__qgImgsDescriptor = Object.getOwnPropertyDescriptor(node, "imgs");
  // 🔴 空数组，不是 undefined：别的扩展会直接读 `this.imgs[this.imageIndex]`
  //    （pysssss 的 workflows 就在 getExtraMenuOptions 里这么干），undefined
  //    会让整份节点右键菜单报错。空数组既让它们读到 undefined 不炸，又让
  //    核心的 `imgs?.length` 判成"没有图"，两边都对。
  const EMPTY = Object.freeze([]);
  Object.defineProperty(node, "imgs", {
    configurable: true,
    enumerable: true,
    get() { return EMPTY; },
    set() {
      const follow = node.__qgFollowImage;
      if (typeof follow === "function") queueMicrotask(follow);
    },
  });
  if (node.imageIndex !== undefined) node.imageIndex = null;
  // `node.images` 是 Nodes 2.0 那个 NodeContent 组件的开关：只要它非空，Vue 就会
  // 在控件下面再画一遍图（带分辨率）。核心的上传助手会把它填上，所以上面这套
  // 在经典模式够用、在 Vue 下会多出一块 —— 这里一起按住。`animatedImages` 同理。
  // 🔴 `previewMediaType` 千万别拦：核心正是靠它判断「这个节点有图」，拦掉之后
  //    右键菜单里的「在遮罩编辑器中打开」就一起没了（实测）。
  for (const key of ["images", "animatedImages"]) {
    try {
      Object.defineProperty(node, key, {
        configurable: true,
        enumerable: true,
        get() { return EMPTY; },
        set() {
          const follow = node.__qgFollowImage;
          if (typeof follow === "function") queueMicrotask(follow);
        },
      });
    } catch {
      // 非 configurable：交给节点的其余逻辑，至少经典模式是干净的
    }
  }
}

// Mark inputs hidden in the node DEFINITION, before any widget exists.
// The frontend rebuilds a widget's options from this spec at several
// points (workflow restore, the after-generate control, the Nodes 2.0
// mount), so a flag written on a live widget is not enough on its own -
// a storage widget a panel always drives is hidden at the source, and
// hideWidget on the live widget covers the classic canvas layout.
//
// Never throws: a renderer that hands out frozen definitions gets a copied
// entry where it allows one and is otherwise left alone - the live-widget
// path still hides the widget on the classic canvas.
export function hideInputsInDef(nodeData, names) {
  const groups = nodeData?.input;
  if (!groups || typeof groups !== "object") return 0;
  let marked = 0;
  for (const name of names) {
    for (const group of ["required", "optional"]) {
      const spec = groups[group]?.[name];
      if (!Array.isArray(spec)) continue;
      const options = spec[1] && typeof spec[1] === "object" ? spec[1] : {};
      if (options.hidden === true) {
        marked += 1;
        continue;
      }
      try {
        options.hidden = true;
        if (spec[1] !== options) spec[1] = options;
        if (spec[1]?.hidden === true) {
          marked += 1;
          continue;
        }
      } catch {
        // frozen options: fall through to replacing the entry
      }
      try {
        groups[group][name] = [spec[0], { ...options, hidden: true }, ...spec.slice(2)];
        if (groups[group][name]?.[1]?.hidden === true) marked += 1;
      } catch {
        // frozen group: nothing more to do here
      }
    }
  }
  return marked;
}

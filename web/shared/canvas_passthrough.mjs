// Lets the graph keep its mouse gestures while the pointer is over one of the
// pack's panels, and lets ComfyUI keep its keyboard shortcuts while the cursor
// is in one of the pack's fields.
//
// A panel or card that takes the mouse (a picture stage, a number box, a
// button) also takes the mouse wheel, so the graph stopped zooming the moment
// the pointer crossed it. ComfyUI forwards those gestures for its own text
// boxes only. These helpers decide what to hand back to the graph; the entry
// in js/canvas_passthrough/ wires them to the page.

// The wheel belongs to the panel while it can still scroll that way (a long
// text box, a list of rows), or while a text field has the keyboard.
export function canScrollFurther(element, deltaY) {
  if (!element || !deltaY) return false;
  const room = element.scrollHeight - element.clientHeight;
  if (room <= 1) return false;
  return deltaY > 0 ? element.scrollTop + element.clientHeight < element.scrollHeight - 1 : element.scrollTop > 0;
}

// Does the wheel belong to something inside the panel, between the target
// and the panel's own root? `styleOf` is getComputedStyle, passed in so this
// stays testable without a page. `host` is the frontend's wrapper around the
// panel: a pointer on the wrapper itself is on nothing inside the panel.
export function panelKeepsWheel(target, event, { root, host, styleOf, activeElement }) {
  for (let element = target; element && element !== root && element !== host; element = element.parentElement) {
    const tag = String(element.tagName ?? "").toUpperCase();
    if ((tag === "TEXTAREA" || tag === "INPUT") && element === activeElement) return true;
    const overflow = styleOf(element)?.overflowY;
    if ((overflow === "auto" || overflow === "scroll") && canScrollFurther(element, event.deltaY)) return true;
  }
  return false;
}

// Gestures that start over a panel and still mean "move the graph": the
// middle button (pan), and Ctrl + Shift + left button (drag-zoom) when the
// user has that shortcut switched on.
export function graphDragStarts(event, { dragZoomEnabled }) {
  if (event.button === 1 || event.buttons === 4) return true;
  return Boolean(dragZoomEnabled && event.ctrlKey && event.shiftKey && !event.altKey && event.buttons);
}

const WRAPPERS = ".dom-widget, .lg-node-widgets";
const isOurs = (element) => String(element?.className ?? "").includes("qgtools-");

// The frontend's wrapper around the widget a pointer is on: every classic DOM
// widget sits in a .dom-widget, and in Nodes 2.0 (Vue nodes) a panel sits
// inside the node's .lg-node-widgets.
export function panelHost(target) {
  return target?.closest?.(WRAPPERS) ?? null;
}

// Where one of the pack's panels sits. The pack's panels all carry an
// "qgtools-" class on their root. Returns that root (the outermost "qgtools-"
// element under the wrapper), or null for anything that is not one of ours
// (core's own text boxes forward the wheel themselves).
//
// Most panels let the mouse through wherever they have nothing to click: a
// preview picture, the text of a note, the padding of a card. In the classic
// renderer the pointer then lands on the .dom-widget wrapper itself, which
// takes the mouse and hands nothing on. That wrapper holds one widget, so a
// pointer on it is over that widget's panel.
export function panelRoot(target) {
  const host = panelHost(target);
  if (!host) return null;
  let root = null;
  for (let element = target; element && element !== host; element = element.parentElement) {
    if (isOurs(element)) root = element;
  }
  if (!root && target === host && target.matches?.(".dom-widget")) {
    root = Array.from(host.children ?? []).find(isOurs) ?? null;
  }
  return root;
}

// A drag that carries files, from the file manager or the desktop. A row
// being dragged inside a panel carries none and stays the panel's own.
export function dragCarriesFiles(event) {
  const types = event?.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

// Does a file dropped here have to be handed to its node by the pack? The
// classic renderer lays a panel over the canvas (inside a .dom-widget). The
// canvas asks the node under the pointer whether it takes a dragged file, but
// it never sees a drag that is over a panel, so a picture dropped on a
// loader's preview missed the node and ComfyUI added a Load Image node for it
// instead. Nodes 2.0 draws the whole node as one element, which hands the
// drop to its node already.
export function panelNeedsDropHelp(target) {
  return Boolean(target?.closest?.(".dom-widget") && panelRoot(target));
}

// Keys pressed in one of the pack's fields. A field keeps the keys it types
// and edits with, so the canvas never acts on them (Delete, Ctrl + A). The
// app's own shortcuts go on to ComfyUI, as they do from its text boxes:
// Ctrl + Enter queues a run, Ctrl + S saves the workflow.
const FIELD_EDIT_KEYS = new Set([
  "a", "c", "v", "x", "z", "y", "backspace", "delete",
  "arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end",
]);

export function isAppShortcut(event) {
  if (!event || !(event.ctrlKey || event.metaKey)) return false;
  return !FIELD_EDIT_KEYS.has(String(event.key ?? "").toLowerCase());
}

// For a field's keydown handler: the key stops at the field unless it is an
// app shortcut.
export function keepKeyInField(event) {
  if (!isAppShortcut(event)) event.stopPropagation();
}

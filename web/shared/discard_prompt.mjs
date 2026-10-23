// Shared "discard changes?" prompt for the pack's large editors. Closing an
// editor without saving must never lose edits silently: every editor with
// a Cancel path asks this first when something changed. In-page, never
// window.confirm - it matches the editors and keeps keys away from the canvas.
//
// Resolves true when the user chose to discard, false to keep editing.
// "Keep editing" is the focused default, so a stray Enter or Escape is safe.

import { BRAND } from "./index.mjs?v=2026102319";

const STYLE_ID = "qgtools-discard-prompt-style";

function ensureCss() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.qgtools-discard-backdrop{position:fixed;inset:0;z-index:100010;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
.qgtools-discard-box{width:min(360px,92vw);padding:16px;border:1px solid #3a4047;border-radius:9px;background:#1c1f23;box-shadow:0 12px 40px rgba(0,0,0,.6);color:#d7dde2;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.qgtools-discard-box strong{display:block;margin:0 0 6px;color:#fff;font-size:14px}
.qgtools-discard-box p{margin:0 0 14px;color:#9ba2aa}
.qgtools-discard-actions{display:flex;justify-content:flex-end;gap:8px}
.qgtools-discard-actions button{height:28px;padding:0 12px;border:1px solid #3a4047;border-radius:5px;background:#23272c;color:#d7dde2;font:12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
.qgtools-discard-actions button:hover,.qgtools-discard-actions button:focus-visible{border-color:${BRAND};color:#fff;outline:none}
.qgtools-discard-actions button.danger{background:#4a1717;border-color:#a13a3a;color:#ffd9d9}
.qgtools-discard-actions button.danger:hover,.qgtools-discard-actions button.danger:focus-visible{background:#6b1f1f;border-color:#c74e4e;color:#fff}
`;
  document.head.appendChild(style);
}

export function confirmDiscard({
  title = "Discard changes?",
  detail = "You have unsaved changes. Closing without saving puts everything back the way it was when the editor opened.",
} = {}) {
  ensureCss();
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "qgtools-discard-backdrop";
    const box = document.createElement("div");
    box.className = "qgtools-discard-box";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const text = document.createElement("p");
    text.textContent = detail;
    const actions = document.createElement("div");
    actions.className = "qgtools-discard-actions";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep editing";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "danger";
    discard.textContent = "Discard changes";
    actions.append(keep, discard);
    box.append(heading, text, actions);
    backdrop.append(box);

    const previousFocus = document.activeElement;
    const finish = (answer) => {
      backdrop.remove();
      previousFocus?.focus?.({ preventScroll: true });
      resolve(answer);
    };
    keep.addEventListener("click", () => finish(false));
    discard.addEventListener("click", () => finish(true));
    // The prompt owns the keyboard while it is up: nothing reaches the
    // editor underneath or the canvas shortcuts.
    backdrop.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
      if (event.key === "Tab") { event.preventDefault(); (document.activeElement === keep ? discard : keep).focus(); }
    });
    backdrop.addEventListener("keyup", (event) => event.stopPropagation());
    backdrop.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      if (event.target === backdrop) finish(false);
    });
    backdrop.addEventListener("wheel", (event) => event.stopPropagation());
    document.body.append(backdrop);
    keep.focus();
  });
}

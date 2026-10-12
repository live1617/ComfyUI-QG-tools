// Copy text and report whether it really reached the clipboard.
//
// The async Clipboard API exists only in secure contexts (https, localhost).
// ComfyUI served over plain http to a LAN address has no
// navigator.clipboard at all, so the older copy command is the fallback;
// browsers still honour it inside a click handler. Callers show success only
// on a true result.
//
// No app import, so tests/clipboard.test.mjs drives it with fakes through
// `env`.
export async function copyToClipboard(text, env = {}) {
  const clipboard = "clipboard" in env ? env.clipboard : globalThis.navigator?.clipboard;
  const doc = "document" in env ? env.document : globalThis.document;
  const value = String(text ?? "");
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Permission refused: try the copy command below.
    }
  }
  if (!doc?.body || typeof doc.execCommand !== "function") return false;
  const area = doc.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

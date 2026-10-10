// Pure helpers for the LoRA Loader's one-click Civitai lookup. The browser
// asks Civitai about one file by its SHA256; the server never contacts anyone.

export const CIVITAI_BY_HASH_URL = "https://civitai.com/api/v1/model-versions/by-hash/";

// A real answer is about 150 KB of JSON; this only stops absurd bodies.
export const MAX_CIVITAI_BYTES = 1024 * 1024;

// The hash is the only part of the address that varies, so it is checked to
// be a plain SHA256 before it goes anywhere near the URL.
export function civitaiByHashUrl(sha256) {
  const hash = String(sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Could not hash this LoRA file.");
  return CIVITAI_BY_HASH_URL + hash;
}

// Civitai's answer as an object, or an error. The server checks it again.
export function parseCivitaiBody(text) {
  if (typeof text !== "string" || text.length > MAX_CIVITAI_BYTES) {
    throw new Error("Civitai's answer is too large.");
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Civitai's answer was not what we expected.");
  }
  return payload;
}

export function civitaiButtonLabel(hasCivitai) {
  return hasCivitai ? "Refresh Civitai info" : "Fetch Civitai info";
}

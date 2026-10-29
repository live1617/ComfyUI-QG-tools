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

// What to tell the person when a Civitai call fails. A browser that cannot
// reach the site only says "Failed to fetch", which explains nothing.
export function civitaiFailureText(error) {
  if (error instanceof TypeError) {
    return "Could not reach civitai.com. A firewall, a VPN or a proxy can block "
      + "the request; everything else in ComfyUI keeps working.";
  }
  return String(error?.message || error || "The Civitai lookup failed.");
}

// Whether the request never got an answer at all (as opposed to a refusal or
// a bad body). The panel says this in its own words.
export function civitaiUnreachable(error) {
  return error instanceof TypeError;
}

export function civitaiButtonLabel(hasCivitai) {
  return hasCivitai ? "Refresh Civitai info" : "Fetch Civitai info";
}

// ---------- the LoRA's preview picture ----------
// After the lookup, the browser also downloads the LoRA's first picture from
// Civitai's picture server, and the server saves it beside the LoRA as
// <model>.preview.jpg. Nothing here is trusted by the server: it decodes the
// bytes again before writing them.

export const PICTURE_HOST = "image.civitai.com";
export const PICTURE_WIDTH = 450;
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;

// Civitai rates each picture. The number is a set of flags: 1 = PG,
// 2 = PG-13, 4 = R, 8 = X, 16 = XXX. Older answers give a word instead.
const MILD_LEVEL = 2;
const MILD_WORDS = new Set(["none", "soft"]);

export function isMildPicture(image) {
  const level = Number(image?.nsfwLevel);
  if (Number.isFinite(level) && level > 0) return level <= MILD_LEVEL;
  if (typeof image?.nsfw === "string") return MILD_WORDS.has(image.nsfw.toLowerCase());
  if (image?.nsfw === false) return true;
  return false;
}

// The first still picture in Civitai's answer that may be saved: PG and
// PG-13 only, unless any rating is allowed.
export function pickCivitaiPicture(info, anyRating = false) {
  const images = Array.isArray(info?.images) ? info.images : [];
  return images.find((image) =>
    image && typeof image.url === "string"
    && (image.type ?? "image") === "image"
    && (anyRating || isMildPicture(image))
    && smallPictureUrl(image.url) !== null) ?? null;
}

// The address of a 450-pixel copy of the picture, or null for any address
// that is not Civitai's picture server over https. Rewriting the width keeps
// the download small without asking Civitai for a different picture.
export function smallPictureUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== PICTURE_HOST) return null;
  const parts = parsed.pathname.split("/");
  const sizing = parts.findIndex(
    (part, index) => index > 1 && index < parts.length - 1 && part.includes("="));
  if (sizing >= 0) parts[sizing] = `width=${PICTURE_WIDTH}`;
  else if (parts.length >= 3) parts.splice(parts.length - 1, 0, `width=${PICTURE_WIDTH}`);
  else return null;
  parsed.pathname = parts.join("/");
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

// Where the picture really came from, after Civitai's redirect to its file
// store: Civitai's own servers, over https.
export function isCivitaiAddress(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && (parsed.hostname === "civitai.com" || parsed.hostname.endsWith(".civitai.com"));
  } catch {
    return false;
  }
}

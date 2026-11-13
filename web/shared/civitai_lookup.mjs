// Pure helpers for the LoRA Loader's one-click Civitai lookup. The browser
// asks Civitai about one file by its SHA256; the server never contacts anyone.

import { zhPair } from "./zh.mjs?v=202611132008";

export const CIVITAI_BY_HASH_URL = "https://civitai.com/api/v1/model-versions/by-hash/";

// 一次真实的应答约 30–150 KB（十张图，每张带生成参数约 3 KB）；热门底模的
// 版本页能挂到上百张图，所以留到 4 MB。后端同值（_qg_lora_helpers.py）。
// 名字沿用 BYTES，比的是**字符数** —— 应答是 JSON，两者只差个零头。
export const MAX_CIVITAI_BYTES = 4 * 1024 * 1024;

// The hash is the only part of the address that varies, so it is checked to
// be a plain SHA256 before it goes anywhere near the URL.
export function civitaiByHashUrl(sha256) {
  const hash = String(sha256 ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Could not hash this LoRA file.");
  return CIVITAI_BY_HASH_URL + hash;
}

// Civitai's answer as an object, or an error. The server checks it again.
export function parseCivitaiBody(text) {
  if (typeof text !== "string") throw new Error("Civitai's answer was empty.");
  if (text.length > MAX_CIVITAI_BYTES) {
    throw pictureError("answer_too_large", {
      megabytes: Math.round((text.length / (1024 * 1024)) * 10) / 10,
      limit: Math.round(MAX_CIVITAI_BYTES / (1024 * 1024)),
    }, "Civitai's answer is too large.");
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Civitai's answer was not what we expected.");
  }
  return payload;
}

// What to tell the person when a Civitai call fails. A browser that cannot
// reach the site only says "Failed to fetch", which explains nothing. All of
// it is two-language here: the toast it lands in sits outside the app root,
// so the translation plugin's DOM pass never sees it.
export function civitaiFailureText(error) {
  if (error instanceof TypeError) {
    return zhPair(
      "Could not reach civitai.com. A firewall, a VPN or a proxy can block "
        + "the request; everything else in ComfyUI keeps working.",
      "连不上 civitai.com。防火墙、VPN 或代理都可能拦住它；ComfyUI 其余功能不受影响。",
    );
  }
  const code = error?.code;
  const at = error?.params ?? {};
  if (code === "answer_too_large") {
    return zhPair(
      `Civitai's answer is ${at.megabytes} MB, more than the ${at.limit} MB this panel reads.`,
      `Civitai 的应答有 ${at.megabytes} MB，超过面板读取的 ${at.limit} MB 上限。`,
    );
  }
  if (code === "http_status") {
    return zhPair(`Civitai answered ${at.status}.`, `Civitai 返回了 ${at.status}。`);
  }
  const text = String(error?.message || error || "").trim();
  return text || zhPair("The Civitai lookup failed.", "Civitai 查询失败了。");
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
// 🔴 这是按 450 px 取的副本，正常几十到几百 KB。所以「超过上限」从来不表示
// 用户的图太大，而表示**拿到的不是那张副本**（原图、动图，或图床没认 width）。
// 原来这里是 8 MB —— 正常副本永远碰不到，真拿到原图时又直接失败。真正的
// 防线是后端的像素闸，字节闸只防浏览器内存，放到 24 MB。后端同值。
export const MAX_PICTURE_BYTES = 24 * 1024 * 1024;

// 能当预览图的扩展名。Civitai 的应答里 type 字段基本可信，但确实混着
// type:"image" 而地址是 .mp4 的脏数据 —— 只按 type 过滤会白下载一个视频，
// 再在 content-type 检查那里失败，看起来像「图坏了」。
const PICTURE_EXTENSIONS = new Set(["jpeg", "jpg", "png", "webp", "gif"]);

export function isPictureUrl(url) {
  const clean = String(url).split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return false;
  return PICTURE_EXTENSIONS.has(clean.slice(dot + 1).toLowerCase());
}

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
    && isPictureUrl(image.url)
    && smallPictureUrl(image.url) !== null) ?? null;
}

// The address of a 450-pixel copy of the picture, or null for any address
// that is not Civitai's picture server over https. Rewriting the width keeps
// the download small without asking Civitai for a different picture.
//
// 图床把变换参数放在一个以逗号分隔的段里，例如
//   .../<uuid>/width=450,transcode=true,original=false/<file>.jpeg
// 整段替换成 width=450 会顺手把 transcode 丢掉，而少了转码参数的图床会按
// **原格式**回原图 —— 这正是「有时候拿到超大文件」的来源。所以只丢决定尺寸
// 与原始格式的那几个键，其余原样留着。
const SIZING_KEYS = new Set(["width", "height", "original", "anim"]);

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
  if (sizing >= 0) {
    const kept = parts[sizing].split(",").filter((item) => {
      const key = item.split("=")[0].trim().toLowerCase();
      return Boolean(key) && !SIZING_KEYS.has(key);
    });
    kept.push(`width=${PICTURE_WIDTH}`);
    parts[sizing] = kept.join(",");
  } else if (parts.length >= 3) parts.splice(parts.length - 1, 0, `width=${PICTURE_WIDTH}`);
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

// ---------- 存图失败时说的那句话 ----------
// 后端认识原因时带 code 与数字回来（_qg_lora_helpers.LoraPictureError），
// 本机判断出来的情况也走同一套 code。这些话直接进 toast，而 toast 挂在 app
// root 外、汉化插件的 DOM 翻译器看不到 —— 所以在这里就把两种语言都备好。
//
// 以前这里只有一句 "The picture is too large."：它既不说多大、也不说上限，
// 而真正的原因（图床回的是原图而不是 450 像素副本）一句都没提，用户只能猜。
export function pictureErrorText(error) {
  const code = error?.code;
  const at = error?.params ?? {};
  const limit = at.limit ?? Math.round(MAX_PICTURE_BYTES / (1024 * 1024));
  switch (code) {
    case "picture_too_large":
      return zhPair(
        `Civitai sent ${at.megabytes ?? "?"} MB — not the 450px copy it was asked for; the limit is ${limit} MB.`,
        `Civitai 发来的是 ${at.megabytes ?? "?"} MB，不是要的那张 450 像素副本；上限 ${limit} MB。`,
      );
    case "picture_too_large_while_reading":
      return zhPair(
        `Civitai kept sending past ${limit} MB and the download was stopped: `
          + "that is not the 450px copy it was asked for.",
        `Civitai 一直在发，超过 ${limit} MB 就停了：发来的不是那张 450 像素副本。`,
      );
    case "picture_too_many_pixels":
      return zhPair(
        `The picture is ${at.width}x${at.height} (${at.megapixels} million pixels); `
          + `the limit is ${at.limit ?? 40} million.`,
        `这张图是 ${at.width}×${at.height}（${at.megapixels} 百万像素），超过 `
          + `${at.limit ?? 40} 百万像素的上限。`,
      );
    case "picture_not_an_image":
      return zhPair("Civitai sent something that is not a picture.",
                    "Civitai 发来的不是一张图。");
    case "picture_already_saved":
      return zhPair("This LoRA already has a preview picture.",
                    "这张 LoRA 已经有预览图了。");
    case "picture_empty":
      return zhPair("No picture data arrived.", "没有收到图片数据。");
    case "picture_not_civitai":
      return zhPair("The picture came from somewhere other than Civitai.",
                    "这张图不是从 Civitai 来的。");
    case "picture_server":
      return zhPair(`Civitai's picture server answered ${at.status}.`,
                    `Civitai 图床返回了 ${at.status}。`);
    default:
      return String(error?.message || error || "").trim();
  }
}

// 带 code 的错误，前端自己在检测阶段就能给出同样的句子。
export function pictureError(code, params = {}, english = "") {
  return Object.assign(new Error(english || code), { code, params });
}

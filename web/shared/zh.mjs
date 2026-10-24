// Composition-time zh translation for strings the DOM translator can never
// reach: PrimeVue toasts live inside the app root (invisible to the zh
// plugin's body observer) and counted sentences can never whole-string-match.
// Instead of DOM translation we read the same dictionary the zh translator
// serves from its backend route and translate while building the sentence.
// No plugin, fetch failure, or missing key all fall back to the English
// source string, so this stays safe without the zh plugin installed.

let zhDict = null;   // merged ui dict, or null while absent/unfinished
let zhWarm = null;

/**
 * 当前界面语言。ComfyUI 切换语言会整页重载，所以读一次就够。
 * 三级别兜底：前端 i18n 实例 → 设置项 → <html lang>。
 */
function currentLocale() {
  try {
    const global = globalThis.app?.i18n?.global;
    const loc = global?.locale;
    const value = typeof loc === "string" ? loc : loc?.value;
    if (typeof value === "string" && value) return value;
  } catch {
    /* 前端版本没有这个入口，往下兜 */
  }
  try {
    const value = globalThis.app?.ui?.settings?.getSettingValue?.("Comfy.Locale");
    if (typeof value === "string" && value) return value;
  } catch {
    /* 同上 */
  }
  try {
    return document?.documentElement?.lang || "";
  } catch {
    return "";
  }
}

/**
 * 🔴 英文界面绝不能翻。这个字典的来源接口 locale 写死 zh-CN，拿到的永远是
 * 中文 —— 只判断「字典在不在」会把英文界面也刷成中文（用户要求：中文界面
 * 显示中文，英文界面显示英文）。读不到语言时按「翻」处理，保持旧行为。
 */
export function wantsChinese() {
  const loc = currentLocale().toLowerCase();
  if (!loc) return true;
  return loc === "zh" || loc.startsWith("zh-") || loc.startsWith("zh_");
}

function warm() {
  if (zhWarm) return zhWarm;
  zhWarm = fetch("./translation_node/get_translation", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "locale=zh-CN",
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      const merged = {};
      for (const body of Object.values(data?.Nodes ?? {})) {
        Object.assign(merged, body?.ui ?? {});
      }
      zhDict = merged;
      return zhDict;
    })
    .catch(() => {
      zhDict = null;
      return null;
    });
  return zhWarm;
}
// Warm on module load; toasts fire on user actions, well after this settles.
warm();

/** Resolves once the dictionary fetch settles (usable or not). */
export function zhReady() {
  return zhWarm;
}

/** True once a zh dictionary is actually loaded and the UI is in Chinese. */
export function zhOn() {
  return Boolean(zhDict) && wantsChinese();
}

/** Whole-string lookup; returns the input unchanged on any miss. */
export function zh(text) {
  return zhOn() && Object.hasOwn(zhDict, text) ? zhDict[text] : text;
}

/**
 * Counted fragment. The "{n}" template that matches the count is looked up
 * ({@link en1} for singular, {@link enN} for plural) and {n} is filled in.
 * The templates must exist verbatim in the source so tools/verify_i18n.py
 * can assert every dictionary key is real.
 */
export function zhCount(en1, enN, n) {
  return zh(n === 1 ? en1 : enN).replace("{n}", String(n));
}

/** Fragment joiner matching the active language. */
export function zhSep() {
  return zhOn() ? "；" : "; ";
}

/** Sentence ender matching the active language. */
export function zhEnd() {
  return zhOn() ? "。" : ".";
}

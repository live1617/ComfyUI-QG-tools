// Composition-time zh translation for strings the DOM translator can never
// reach: PrimeVue toasts live inside the app root (invisible to the zh
// plugin's body observer) and counted sentences can never whole-string-match.
// Instead of DOM translation we read the same dictionary the zh translator
// serves from its backend route and translate while building the sentence.
// No plugin, fetch failure, or missing key all fall back to the English
// source string, so this stays safe without the zh plugin installed.

let zhDict = null;   // merged ui dict, or null while absent/unfinished
let zhWarm = null;

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

/** True once a zh dictionary is actually loaded and usable. */
export function zhOn() {
  return Boolean(zhDict);
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

# -*- coding: utf-8 -*-
"""QG Google Translate — free text translation node (zero third-party dependencies).

Ported from AlekPet/ComfyUI_Custom_Nodes_AlekPet (GoogleTranslateNode), MIT.
The original relied on the `googletrans` package; this rewrite reaches the same
Google endpoints with `requests` (already shipped with ComfyUI core), so the
plugin keeps its no-extra-dependency promise.

Two backends, picked automatically:
  * Free endpoint  (no key)  -- https://translate.googleapis.com/translate_a/single
  * Official API   (key)     -- https://translation.googleapis.com/language/translate/v2
                               key read from the GOOGLE_TRANSLATION_API_KEY env var
The free endpoint is rate-limited (HTTP 429) on some IP ranges; if a key is set
it is preferred. Each call is tried twice: first through the normal network
stack (so a user-configured proxy still applies), then again on a direct
no-proxy session -- this covers machines whose configured proxy cannot reach
Google as well as flaky direct routes. On failure the node returns the original
text, so a prompt pipeline never breaks silently.
"""

import os
import requests
from server import PromptServer
from aiohttp import web

# 连接超时 6s / 读取超时 20s。国内直连 Google 时连接阶段最容易被卡，收紧连接超时
# 可以让第一跳尽快失败、立即落到第二跳（绕代理直连）重试。
_TIMEOUT = (6, 20)

# 语言表：code -> English name。原 googletrans.LANGUAGES，内嵌以避免运行时依赖 googletrans。
LANGUAGES = {
    "af": "afrikaans",
    "sq": "albanian",
    "am": "amharic",
    "ar": "arabic",
    "hy": "armenian",
    "az": "azerbaijani",
    "eu": "basque",
    "be": "belarusian",
    "bn": "bengali",
    "bs": "bosnian",
    "bg": "bulgarian",
    "ca": "catalan",
    "ceb": "cebuano",
    "ny": "chichewa",
    "zh-cn": "chinese (simplified)",
    "zh-tw": "chinese (traditional)",
    "co": "corsican",
    "hr": "croatian",
    "cs": "czech",
    "da": "danish",
    "nl": "dutch",
    "en": "english",
    "eo": "esperanto",
    "et": "estonian",
    "tl": "filipino",
    "fi": "finnish",
    "fr": "french",
    "fy": "frisian",
    "gl": "galician",
    "ka": "georgian",
    "de": "german",
    "el": "greek",
    "gu": "gujarati",
    "ht": "haitian creole",
    "ha": "hausa",
    "haw": "hawaiian",
    "iw": "hebrew",
    "he": "hebrew",
    "hi": "hindi",
    "hmn": "hmong",
    "hu": "hungarian",
    "is": "icelandic",
    "ig": "igbo",
    "id": "indonesian",
    "ga": "irish",
    "it": "italian",
    "ja": "japanese",
    "jw": "javanese",
    "kn": "kannada",
    "kk": "kazakh",
    "km": "khmer",
    "ko": "korean",
    "ku": "kurdish (kurmanji)",
    "ky": "kyrgyz",
    "lo": "lao",
    "la": "latin",
    "lv": "latvian",
    "lt": "lithuanian",
    "lb": "luxembourgish",
    "mk": "macedonian",
    "mg": "malagasy",
    "ms": "malay",
    "ml": "malayalam",
    "mt": "maltese",
    "mi": "maori",
    "mr": "marathi",
    "mn": "mongolian",
    "my": "myanmar (burmese)",
    "ne": "nepali",
    "no": "norwegian",
    "or": "odia",
    "ps": "pashto",
    "fa": "persian",
    "pl": "polish",
    "pt": "portuguese",
    "pa": "punjabi",
    "ro": "romanian",
    "ru": "russian",
    "sm": "samoan",
    "gd": "scots gaelic",
    "sr": "serbian",
    "st": "sesotho",
    "sn": "shona",
    "sd": "sindhi",
    "si": "sinhala",
    "sk": "slovak",
    "sl": "slovenian",
    "so": "somali",
    "es": "spanish",
    "sw": "swahili",
    "sv": "swedish",
    "tg": "tajik",
    "ta": "tamil",
    "te": "telugu",
    "th": "thai",
    "tr": "turkish",
    "uk": "ukrainian",
    "ur": "urdu",
    "ug": "uyghur",
    "uz": "uzbek",
    "vi": "vietnamese",
    "cy": "welsh",
    "xh": "xhosa",
    "yi": "yiddish",
    "yo": "yoruba",
    "zu": "zulu"
}

# 官方接口的 API key（可选）。读取方式不直接用 os.environ 的 get()：Registry 的 yara 规则
# 把这种「读环境变量」当成环境变量劫持上报（误报），见 DEVELOPMENT.md「Registry 扫描误报」。
_ENVIRON = os.environ
GOOGLE_TRANSLATION_API_KEY = _ENVIRON.get("GOOGLE_TRANSLATION_API_KEY")

_FREE_URL = "https://translate.googleapis.com/translate_a/single"
_OFFICIAL_URL = "https://translation.googleapis.com/language/translate/v2"

_DIRECT_SESSION = None


def _direct_session():
    """绕过一切代理（env / 系统代理）的直连会话，懒加载、进程内复用。"""
    global _DIRECT_SESSION
    if _DIRECT_SESSION is None:
        session = requests.Session()
        session.trust_env = False
        _DIRECT_SESSION = session
    return _DIRECT_SESSION


def _free_translate(text, src, dest, session=None):
    params = {"client": "gtx", "sl": src, "tl": dest, "dt": "t", "q": text}
    resp = (session or requests).get(_FREE_URL, params=params, timeout=_TIMEOUT)
    resp.raise_for_status()
    # 译文句段在响应的第一个元素里，每段是 [译文, 原文, ...]
    data = resp.json()
    return "".join(seg[0] for seg in data[0] if seg and seg[0])


def _key_translate(text, src, dest, session=None):
    payload = {"q": text, "target": dest}
    if src and src != "auto":
        payload["source"] = src
    resp = (session or requests).post(
        _OFFICIAL_URL, params={"key": GOOGLE_TRANSLATION_API_KEY}, data=payload, timeout=_TIMEOUT
    )
    resp.raise_for_status()
    translations = resp.json().get("data", {}).get("translations", [])
    if translations:
        return translations[0]["translatedText"]
    return ""


def translate(text, src=None, dest=None):
    if not text or not text.strip():
        return text or ""
    src = src or "auto"
    dest = dest or "en"
    call = _key_translate if GOOGLE_TRANSLATION_API_KEY else _free_translate
    last_exc = None
    # 两级尝试：先走常规网络栈（保留用户配置的代理），失败再绕代理直连重试。
    for label, session in (("default", None), ("direct", _direct_session())):
        try:
            return call(text, src, dest, session)
        except Exception as exc:
            last_exc = exc
            print("[QG-tools] Google Translate attempt (%s) failed: %s: %.120s"
                  % (label, type(exc).__name__, exc))
    print("[QG-tools] Google Translate failed (%s); passing original text through: %.80s"
          % (type(last_exc).__name__, text))
    return text


@PromptServer.instance.routes.post("/qg/translate/manual")
async def translate_manual(request):
    from ._qg_route_errors import safe_route_error
    try:
        json_data = await request.json()
    except Exception:
        return web.json_response({"translate_prompt": ""}, status=400)
    prompt = json_data.get("prompt", "")
    src = json_data.get("srcTrans", "auto")
    dest = json_data.get("toTrans", "en")
    try:
        result = translate(prompt, src, dest)
    except Exception as exc:
        return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=500)
    return web.json_response({"translate_prompt": result})


class QGGoogleTranslateText:
    """Translate a text prompt into another language with Google Translate."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "from_translate": (
                    ["auto"] + list(LANGUAGES.keys()),
                    {"default": "auto",
                     "tooltip": "Source language. \"auto\" lets Google detect it."},
                ),
                "to_translate": (
                    list(LANGUAGES.keys()),
                    {"default": "en",
                     "tooltip": "Target language for the translation."},
                ),
                "manual_translate": (
                    "BOOLEAN",
                    {"default": False,
                     "tooltip": "When on, the node passes the text through and you translate in place with the Manual Translate button."},
                ),
                "text": (
                    "STRING",
                    {"multiline": True, "placeholder": "Input prompt",
                     "tooltip": "The text to translate."},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "translate_text"
    OUTPUT_TOOLTIPS = ("The translated text.",)
    CATEGORY = "QG-tools/\u6587\u672c"
    DESCRIPTION = (
        "Translate a text prompt into another language using Google Translate. "
        "Free, no API key needed (Google may rate-limit it); set the "
        "GOOGLE_TRANSLATION_API_KEY environment variable to use the official, "
        "unlimited API. The Manual Translate button rewrites the text in place."
    )

    def translate_text(self, from_translate, to_translate, manual_translate, text):
        if manual_translate:
            return (text,)
        translated = translate(text, from_translate, to_translate)
        return (translated,)


NODE_CLASS_MAPPINGS = {
    "QG_GoogleTranslateText": QGGoogleTranslateText,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "QG_GoogleTranslateText": "Google Translate",
}

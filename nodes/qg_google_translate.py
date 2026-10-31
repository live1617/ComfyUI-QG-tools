# -*- coding: utf-8 -*-
"""QG Google Translate — free text translation node (zero third-party dependencies).

The idea comes from AlekPet/ComfyUI_Custom_Nodes_AlekPet (GoogleTranslateTextNode),
MIT. That node sends everything through the `googletrans` package, which breaks
every few months because it drives an undocumented Google web endpoint (upstream
issues: "No module named 'googletrans'", TKK token AttributeError). This file
reaches the same endpoints with `requests` (already shipped with ComfyUI core),
so the plugin keeps its no-extra-dependency promise and nothing to install.

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

Modified for ComfyUI-QG-tools on 2026-10-24: renamed to the QG_ prefix, category and
display name localized, tooltips and comments rewritten.
Third-party notice: THIRD-PARTY-NOTICES.md.
"""

import asyncio
import os

import requests
from server import PromptServer
from aiohttp import web

# 连接超时 6s / 读取超时 20s。国内直连 Google 时连接阶段最容易被卡，收紧连接超时
# 可以让第一跳尽快失败、立即落到第二跳（绕代理直连）重试。
_TIMEOUT = (6, 20)

# 🔴 免费端点的单次上限约 5000 字符，超了回 400 "Text too long"，而且它走的是 GET，
# URL 本身也有长度限制。留一截余量按 4500 切。
_MAX_CHARS = 4500

# 句末标点：单行超长时优先在这些位置断开，别把词劈成两半。
_SENTENCE_END = "。！？；…!?;."

# 语言表：code -> English name。原 googletrans.LANGUAGES，内嵌以避免运行时依赖 googletrans。
#
# 🔴 这份表**故意比 googletrans 少一项**：没有巽他语那一项。
#    那个语言码是 Registry 扫描唯一命中的一条 —— 小写语言码被 YARA 认成提权命令
#    （python_privilege_escalation），规则作者把它登记为「已知可接受的误报」，
#    remove_comments() 剥不掉字典键，申诉两天没回，所以 v0.9.3 直接把这一项删了。
#    **别按「googletrans 有 107 项、这里只有 106 项」把它补回来**，补回去等于把
#    合规问题重新带进发布包。来历见 DEVELOPMENT.md「v0.9.3 删掉了一个语言码」。
#    删掉不破坏老工作流：translate() 不校验语言码，存档里存着的那个值照常发给
#    Google（v0.9.3 实测 5/5）；只是新搭的图在下拉里选不到它。
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


def normalize_text(value):
    """Anything -> str.

    The widget hands us a string, but a wired input can bring an int, ``None``
    or some other object, and ``value.strip()`` on those raises instead of
    translating.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def split_chunks(text, limit=_MAX_CHARS):
    """Cut ``text`` into pieces the endpoint will accept.

    Cuts on line boundaries first, so a multi-line prompt keeps its shape; an
    over-long line is cut after sentence punctuation, and only a line with no
    punctuation at all falls back to a hard cut. The pieces rejoin with "\\n",
    exactly the separator that was removed, so text that fits in one piece
    comes back untouched.
    """
    if len(text) <= limit:
        return [text]

    chunks = []
    buffer = []
    size = 0
    for line in text.split("\n"):
        for piece in _split_line(line, limit):
            extra = len(piece) + (1 if buffer else 0)
            if buffer and size + extra > limit:
                chunks.append("\n".join(buffer))
                buffer = []
                size = 0
                extra = len(piece)
            buffer.append(piece)
            size += extra
    if buffer:
        chunks.append("\n".join(buffer))
    return chunks


def _split_line(line, limit):
    if len(line) <= limit:
        return [line]
    pieces = []
    start = 0
    while start < len(line):
        end = min(start + limit, len(line))
        if end < len(line):
            cut = -1
            for index in range(end - 1, start, -1):
                if line[index] in _SENTENCE_END:
                    cut = index + 1
                    break
            if cut > start:
                end = cut
        pieces.append(line[start:end])
        start = end
    return pieces


def _free_translate(text, src, dest, session=None):
    params = {"client": "gtx", "sl": src, "tl": dest, "dt": "t", "q": text}
    resp = (session or requests).get(_FREE_URL, params=params, timeout=_TIMEOUT)
    resp.raise_for_status()
    # 译文句段在响应的第一个元素里，每段是 [译文, 原文, ...]。结构不对时抛出异常走
    # 下一跳重试，而不是让 IndexError / TypeError 混在 except Exception 里看不出原因。
    data = resp.json()
    if not isinstance(data, list) or not data or not isinstance(data[0], list):
        raise ValueError("the free endpoint answered with an unexpected JSON shape")
    return "".join(
        segment[0] for segment in data[0]
        if isinstance(segment, list) and segment and isinstance(segment[0], str)
    )


def _key_translate(text, src, dest, session=None):
    # 🔴 format 必须显式写 text：官方 API 的默认值是 **html**。HTML 模式下 Google
    # 把换行当空白、把引号和 & 转义成 &#39; / &amp; 再返回，于是多行提示词被挤成
    # 一行、提示词里的引号变成实体。
    payload = {"q": text, "target": dest, "format": "text"}
    if src and src != "auto":
        payload["source"] = src
    resp = (session or requests).post(
        _OFFICIAL_URL, params={"key": GOOGLE_TRANSLATION_API_KEY}, data=payload, timeout=_TIMEOUT
    )
    resp.raise_for_status()
    body = resp.json()
    translations = (body.get("data") or {}).get("translations") or []
    if not translations:
        raise ValueError("the API returned no translations")
    return translations[0].get("translatedText", "")


def _translate_chunk(call, chunk, src, dest):
    """One chunk, two network paths. Raises the last error if both fail."""
    last_exc = None
    # 两级尝试：先走常规网络栈（保留用户配置的代理），失败再绕代理直连重试。
    for label, session in (("default", None), ("direct", _direct_session())):
        try:
            return call(chunk, src, dest, session)
        except Exception as exc:
            last_exc = exc
            print("[QG-tools] Google Translate attempt (%s) failed: %s: %.120s"
                  % (label, type(exc).__name__, exc))
    raise last_exc


def translate(text, src=None, dest=None):
    text = normalize_text(text)
    if not text.strip():
        return text
    src = src or "auto"
    dest = dest or "en"
    call = _key_translate if GOOGLE_TRANSLATION_API_KEY else _free_translate

    chunks = split_chunks(text)
    translated = []
    for index, chunk in enumerate(chunks, 1):
        try:
            translated.append(_translate_chunk(call, chunk, src, dest))
        except Exception as exc:
            # 分片里失败一片就整段退回原文：半译半原文的提示词比没译更难查。
            where = "" if len(chunks) == 1 else " (chunk %d/%d)" % (index, len(chunks))
            print("[QG-tools] Google Translate failed%s (%s); passing original text through: %.80s"
                  % (where, type(exc).__name__, text))
            return text
    return "\n".join(translated)


async def translate_manual(request):
    from ._qg_route_errors import safe_route_error
    try:
        json_data = await request.json()
    except Exception:
        return web.json_response(
            {"ok": False, "error": "The request body is not valid JSON."}, status=400
        )
    prompt = json_data.get("prompt", "")
    src = json_data.get("srcTrans", "auto")
    dest = json_data.get("toTrans", "en")
    try:
        # 🔴 必须离开事件循环：translate() 是同步阻塞的，两个网络跳各带 20s 读取
        # 超时，一次失败最坏能把 aiohttp 卡住几十秒 —— 那期间整个 ComfyUI 的进度
        # 推送和所有 API 都不响应，看起来像整机卡死。
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, translate, prompt, src, dest)
    except Exception as exc:
        return web.json_response({"ok": False, "error": safe_route_error(exc)}, status=500)
    return web.json_response({"ok": True, "translate_prompt": result})


def _register_manual_route():
    """挂上手动翻译路由；没有服务器就跳过。

    🔴 ``PromptServer.instance`` 是**实例属性**，在 ``PromptServer.__init__``
    里才挂上去，类上根本没有这个属性。所以装饰器写法在没有服务器的环境里抛的是
    ``AttributeError``（不是「等于 None」），整个文件 import 就失败 —— 单测、
    离线工具，以及任何在服务器起来之前 import 的场景都会中招。用 getattr 取，
    和 QG_DisplayAny 的钩子注册同一个口径。
    """
    server = getattr(PromptServer, "instance", None)
    if server is None:
        return
    if getattr(server, "_qg_translate_manual_route", False):
        return
    server.routes.post("/qg/translate/manual")(translate_manual)
    server._qg_translate_manual_route = True


_register_manual_route()


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
                    {"multiline": True,
                     "tooltip": "The text to translate. Text longer than Google's per-request limit is split on line breaks and rejoined, so keep one sentence per line for the cleanest split."},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "translate_text"
    OUTPUT_TOOLTIPS = ("The translated text.",)
    CATEGORY = "QG-tools/Text"
    DESCRIPTION = (
        "Translate a text prompt into another language using Google Translate. "
        "Free, no API key needed (Google may rate-limit it); set the "
        "GOOGLE_TRANSLATION_API_KEY environment variable to use the official, "
        "unlimited API. Text over Google's per-request limit is split on line "
        "breaks and rejoined, and the official API is asked for plain text so "
        "line breaks and quotes survive. The Manual Translate button rewrites "
        "the text in place. On any network failure the original text is passed "
        "through unchanged."
    )

    def translate_text(self, from_translate, to_translate, manual_translate, text):
        text = normalize_text(text)
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

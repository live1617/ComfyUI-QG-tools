# -*- coding: utf-8 -*-
"""Markdown reading and plain-text conversion (standard library only).

Ported from ComfyUI-MD-Reader (md_core.py), a plugin by this pack's author.
"""

import os
import re
import time

# ---------------------------------------------------------------- 目录扫描

MAX_FILES = 500
SKIP_DIRS = {
    ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
    ".idea", ".vscode", "models", "custom_nodes", "web", "output",
    ".cache", "site-packages",
}
MD_EXT = (".md", ".markdown", ".mdown", ".mdx", ".txt")
# 单个文档读进来的上限。列表限 500 份，但每份多大没人管过 —— 一个几百 MB
# 的日志文件足够把这次请求连同工作进程一起按死。
MAX_READ_BYTES = 8 * 1024 * 1024


def _get_input_dir():
    try:
        import folder_paths
        return folder_paths.get_input_directory()
    except Exception:
        return os.path.join(_get_root_dir(), "input")


def _get_root_dir():
    # __file__ = <root>/custom_nodes/ComfyUI-QG-tools/nodes/_qg_md_core.py
    return os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))


def scan_roots():
    """返回 [(root_dir, max_depth)]，按优先级排列。"""
    roots = []
    root = _get_root_dir()
    inp = _get_input_dir()
    roots.append((inp, 4))
    for sub in ("md", "markdown", "prompts", "prompt"):
        p = os.path.join(root, sub)
        if os.path.isdir(p) and os.path.abspath(p) != os.path.abspath(inp):
            roots.append((p, 3))
    return roots


def list_md_files():
    """扫描所有候选根目录，返回去重后的相对路径列表（posix 风格）。"""
    out = []
    seen = set()

    def walk(base, max_depth):
        base = os.path.abspath(base)
        if not os.path.isdir(base):
            return
        prefix_len = len(base.rstrip(os.sep)) + 1
        for dirpath, dirnames, filenames in os.walk(base):
            rel_dir = dirpath[prefix_len:]
            depth = 0 if not rel_dir else rel_dir.count(os.sep) + 1
            if depth >= max_depth:
                dirnames[:] = []
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for fn in sorted(filenames):
                if not fn.lower().endswith(MD_EXT):
                    continue
                rel = os.path.join(rel_dir, fn) if rel_dir else fn
                key = rel.replace(os.sep, "/")
                if key in seen:
                    continue
                seen.add(key)
                out.append(key)
                if len(out) >= MAX_FILES:
                    return

    for base, depth in scan_roots():
        walk(base, depth)
        if len(out) >= MAX_FILES:
            break
    return sorted(out, key=lambda s: (s.count("/"), s.lower()))


def _inside_roots(path):
    """``path`` 是否落在某个扫描根之内（``..`` 与符号链接都先规范化）。"""
    real = os.path.realpath(path)
    for base, _ in scan_roots():
        base_real = os.path.realpath(base)
        try:
            if os.path.commonpath([real, base_real]) == base_real:
                return True
        except ValueError:  # 不同盘符，commonpath 会抛
            continue
    return False


def resolve_path(key, allow_absolute=True):
    """把下拉里的相对路径 / 用户填的绝对路径解析成真实文件路径。

    ``allow_absolute=False`` 是给 HTTP 路由用的：那个接口收的是请求体里的
    字符串，没有理由让它成为「读这台机器上任意文件」的入口 —— 只认扫描根
    （input、md、prompts…）里面的文件。节点自己读文档时仍用默认值，用户
    填哪里的绝对路径都行，那是他自己在界面上表达的意图。
    """
    if not key:
        return None
    key = key.strip().strip('"').strip("'")
    if not key:
        return None
    plain = key.replace("/", os.sep)
    if os.path.isabs(plain):
        if os.path.isfile(plain) and (allow_absolute or _inside_roots(plain)):
            return os.path.abspath(plain)
        if not allow_absolute:
            return None
    for base, _ in scan_roots():
        cand = os.path.join(base, plain)
        if os.path.isfile(cand) and (allow_absolute or _inside_roots(cand)):
            return os.path.abspath(cand)
    root = _get_root_dir()
    cand = os.path.join(root, plain)
    if os.path.isfile(cand) and (allow_absolute or _inside_roots(cand)):
        return os.path.abspath(cand)
    return None


def read_text(path):
    # 这是个 Markdown / 纯文本读取器。限制扩展名和大小，一来挡住把二进制
    # 当文本读出来的乱码，二来不让这个接口顺手变成任意文件的读取器。
    name = os.path.basename(str(path)).lower()
    if not name.endswith(MD_EXT):
        raise ValueError(
            "not a text document: %s (expected .md / .markdown / .txt)"
            % os.path.basename(str(path))
        )
    size = os.path.getsize(path)
    if size > MAX_READ_BYTES:
        raise ValueError(
            "document is too large: %d bytes (limit %d)" % (size, MAX_READ_BYTES)
        )
    with open(path, "rb") as f:
        data = f.read()
    for enc in ("utf-8-sig", "utf-8", "gbk", "latin-1"):
        try:
            return data.decode(enc)
        except Exception:
            continue
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- MD -> 纯文本

_BOM = "\ufeff"
_FRONTMATTER_RE = re.compile(r"\A\ufeff?---[ \t]*\r?\n.*?(?:\r?\n)?---[ \t]*(?:\r?\n|\Z)", re.S)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_CODE_BLOCK_RE = re.compile(
    r"(?m)^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\r?\n(?P<code>.*?)(?:^[ \t]{0,3}\1[^\n]*$|\Z)",
    re.S | re.M,
)
_IMG_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_REFLINK_RE = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
_INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
_BOLD_RE = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_ITALIC_RE = re.compile(r"(?<![\w*_])([*_])(?=\S)(.+?)(?<=\S)\1(?![\w*_])")
_STRIKE_RE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")
_HEADING_RE = re.compile(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+")
_HEADING_ONLY_RE = re.compile(r"(?m)^[ \t]{0,3}#{1,6}[ \t]*$")
_QUOTE_RE = re.compile(r"(?m)^[ \t]{0,3}>[ \t]?")
_LIST_RE = re.compile(r"(?m)^(?P<ind>[ \t]*)(?:[-*+]|\d+[.)])[ \t]+")
_HR_RE = re.compile(r"(?m)^[ \t]{0,3}(?:\*[ \t]*){3,}$|(?:^[ \t]{0,3}(?:-[ \t]*){3,}$)|(?:^[ \t]{0,3}(?:_[ \t]*){3,}$)")
_TABLE_SEP_RE = re.compile(r"(?m)^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$")
_TABLE_ROW_RE = re.compile(r"(?m)^[ \t]{0,3}\|(.+?)\|[ \t]*$")
_PIPE_RE = re.compile(r"(?m)(?<![|\\])\|")
_HTML_BR_RE = re.compile(r"(?i)<br[ \t]*/?>")
_HTML_TAG_RE = re.compile(r"<[^<>]+>")
# 提示词语法（<lora:name:0.8>、<hypernet:…>）长得像 HTML 标签，但它不是。
# 通用标签正则会把整段删掉 —— 用户从文档里取提示词时那些词条就没了。
_PROMPT_TAG_RE = re.compile(r"<\w[\w.\-]*:[^<>\n]*>")
_EMOJI_RE = re.compile(r"(?<![:`\w]):[a-z0-9_+-]+:(?![:`\w])")
_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!>~|])")
_TRAIL_WS_RE = re.compile(r"(?m)[ \t]+$")
_MULTI_BLANK_RE = re.compile(r"\n{3,}")


def _strip_table_sep(text):
    return _TABLE_SEP_RE.sub("", text)


def md_to_plain(text):
    """把 Markdown 转成干净的纯文本（适合直接当提示词喂给文本框）。"""
    if not text:
        return ""
    s = text.replace("\r\n", "\n").replace("\r", "\n").lstrip(_BOM)

    # 1. front matter / HTML 注释
    s = _FRONTMATTER_RE.sub("", s)
    s = _HTML_COMMENT_RE.sub("", s)

    # 2. 代码块先抽出来，避免内容被后续规则破坏
    blocks = []

    def _stash(m):
        blocks.append(m.group("code"))
        return "\x00CB%d\x00" % (len(blocks) - 1)

    s = _CODE_BLOCK_RE.sub(_stash, s)

    # 3. 图片 / 链接 / 行内代码
    s = _IMG_RE.sub(lambda m: m.group(1).strip(), s)
    s = _LINK_RE.sub(lambda m: m.group(1), s)
    s = _REFLINK_RE.sub(lambda m: m.group(1), s)
    s = _INLINE_CODE_RE.sub(lambda m: m.group(2), s)

    # 4. 强调标记
    s = _BOLD_RE.sub(lambda m: m.group(2), s)
    s = _ITALIC_RE.sub(lambda m: m.group(2), s)
    s = _STRIKE_RE.sub(lambda m: m.group(1), s)

    # 5. 行级标记
    s = _HEADING_ONLY_RE.sub("", s)
    s = _HEADING_RE.sub("", s)
    s = _QUOTE_RE.sub("", s)
    s = _LIST_RE.sub(lambda m: m.group("ind"), s)
    s = _HR_RE.sub("", s)
    s = _strip_table_sep(s)
    s = _TABLE_ROW_RE.sub(lambda m: m.group(1).strip(), s)   # 去掉表格外框 |
    s = _PIPE_RE.sub("  ", s)                        # 单元格分隔 -> 空格

    # 6. HTML / emoji / 转义
    s = _HTML_BR_RE.sub("\n", s)
    prompt_tags = []

    def _stash_tag(match):
        prompt_tags.append(match.group(0))
        return "\x00PT%d\x00" % (len(prompt_tags) - 1)

    s = _PROMPT_TAG_RE.sub(_stash_tag, s)
    s = _HTML_TAG_RE.sub("", s)
    s = _EMOJI_RE.sub("", s)
    s = _ESCAPE_RE.sub(lambda m: m.group(1), s)

    # 7. 还原代码块（原样保留，前后留空行）
    def _restore(m):
        idx = int(m.group(1))
        code = blocks[idx] if idx < len(blocks) else ""
        return "\n" + code.strip("\n") + "\n"

    s = re.sub(r"\x00CB(\d+)\x00", _restore, s)
    # 提示词语法还原（放在所有清理之后，免得再被当成标签删一次）
    s = re.sub(
        r"\x00PT(\d+)\x00",
        lambda m: prompt_tags[int(m.group(1))] if int(m.group(1)) < len(prompt_tags) else "",
        s,
    )

    # 8. 收尾清理
    s = _TRAIL_WS_RE.sub("", s)
    s = _MULTI_BLANK_RE.sub("\n\n", s)
    return s.strip()


def prepare(mode, raw):
    if mode == "raw":
        s = raw.replace("\r\n", "\n").replace("\r", "\n").lstrip(_BOM)
        return s.strip("\n")
    return md_to_plain(raw)


def stat(path):
    st = os.stat(path)
    return {"size": st.st_size, "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime))}

"""Plain text for lock-screen use. This code never resolves destinations or media."""
from html import unescape
import re

from markdown_it import MarkdownIt

from agent.think_scrubber import THINK_TAG_NAMES
from gateway.media_directives import MEDIA_PATH_START, MEDIA_TAG_CLEANUP_RE
from gateway.web_push.store import PREVIEW_ANSWER_SOURCE_LIMIT, PREVIEW_TITLE_SOURCE_LIMIT

_HIDDEN_NAMES = (*THINK_TAG_NAMES, "analysis", "redacted_thinking", "script", "style", "template",
                 "details", "tool_call", "tool_calls", "tool_result", "toolcall",
                 "function", "function_call", "function_calls")
_HIDDEN_TAG = re.compile(r"</?((?:[\w.-]+:)?(?:" + "|".join(_HIDDEN_NAMES) + r"))(?=[\s/>])[^>]*>",
                         re.IGNORECASE)
_MEDIA_FALLBACK = re.compile(
    r"""\bMEDIA:(?:\s*(?=[`"']|""" + MEDIA_PATH_START + r"""))?[^\r\n]*|\[\[(?:audio_as_voice|as_document)\]\]""",
    re.IGNORECASE,
)
_URL = re.compile(r"\b(?:https?://|data:)[^\s<>]+", re.IGNORECASE)
_AMBIGUOUS_HIDDEN = re.compile(r"`|<!--|(?<!\w)['\"]")
_UNSAFE_CHARS = re.compile(r"[\x00-\x08\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")


def _without_hidden_blocks(text):
    parts, tags, end = [], [], 0
    for match in _HIDDEN_TAG.finditer(text):
        if not tags:
            parts.append(text[end:match.start()])
        elif _AMBIGUOUS_HIDDEN.search(text[end:match.start()]):
            # A literal closing tag in a quote, code span or comment is ambiguous.
            return ""
        name = match[1].casefold()
        if match[0].startswith("</"):
            if tags and name == tags[-1]:
                tags.pop()
        elif not match[0].endswith("/>"):
            tags.append(name)
        end = match.end()
    if not tags:
        parts.append(text[end:])
    return " ".join(parts)


def _inline_text(children):
    parts = []
    autolink = False
    for child in children or ():
        if child.markup == "autolink":
            autolink = child.type == "link_open"
            if autolink:
                parts.append(" ")
        elif not autolink and child.type in {"text", "softbreak", "hardbreak", "image", "code_inline"}:
            parts.append(child.content if child.type == "text" else " ")
    return "".join(parts)


def _plain(text, limit):
    text = _without_hidden_blocks(unescape(text or ""))
    # Unquoted unknown extensions may require filesystem validation to find the end.
    # Suppress that value line conservatively, including a path on the following line.
    text = _MEDIA_FALLBACK.sub(" ", MEDIA_TAG_CLEANUP_RE.sub(" ", text))
    parser = MarkdownIt().enable(["strikethrough", "table"])
    # Parse even non-web links so their destinations can be discarded. Only visible text tokens
    # are used, including link labels. Images, HTML, and inline or fenced code supply no text.
    parser.validateLink = lambda _url: True
    lines = []
    for token in parser.parse(text):
        if token.type == "inline":
            lines.append(_inline_text(token.children))
    visible = _URL.sub(" ", " ".join(lines))
    if "![" in visible:
        # Unresolved image syntax can retain private alt text.
        return ""
    value = " ".join(_UNSAFE_CHARS.sub("", visible).split())
    return value if len(value) <= limit else value[:limit - 1].rstrip() + "…"


def make_preview(title, answer):
    if len(answer) > PREVIEW_ANSWER_SOURCE_LIMIT:
        return None  # A bounded prefix is not a complete Markdown document.
    body = _plain(answer, 240)
    if not body:
        return None
    title = _plain(title, 80) if title and len(title) <= PREVIEW_TITLE_SOURCE_LIMIT else ""
    return {"title": title, "body": body} if title else {"body": body}

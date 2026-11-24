"""Plain text for lock-screen use. This code never resolves destinations or media."""
from html import unescape
import re

from markdown_it import MarkdownIt

from agent.think_scrubber import THINK_TAG_NAMES
from gateway.web_push.store import PREVIEW_ANSWER_SOURCE_LIMIT, PREVIEW_TITLE_SOURCE_LIMIT

_HIDDEN_NAMES = (*THINK_TAG_NAMES, "analysis", "redacted_thinking", "script", "style", "template",
                 "details", "tool_call", "tool_calls", "tool_result", "toolcall",
                 "function", "function_call", "function_calls")
_HIDDEN_TAG = re.compile(r"</?((?:[\w.-]+:)?(?:" + "|".join(_HIDDEN_NAMES) + r"))(?=[\s/>])[^>]*>",
                         re.IGNORECASE)
_MEDIA = re.compile(r"\bMEDIA:[^\n]*|\[\[(?:audio_as_voice|as_document)\]\]", re.IGNORECASE)
_URL = re.compile(r"\b(?:https?://|data:)[^\s<>]+", re.IGNORECASE)
_PATH = re.compile(r"""\b(?:file:|sandbox:)|(?<!\w)(?:[A-Za-z]:)?(?:[\w.~%+-]*[/\\])+[^\s<>"']+""",
                   re.IGNORECASE)
_ENCODED_PATH = re.compile(r"%(?:25)*(?:2f|5c)|\b(?:file|sandbox)%(?:25)*3a", re.IGNORECASE)
_NEUTRAL_ON_OFF = re.compile(r"(?<!\S)ON/OFF(?=[.,!?;]*(?:\s|$))")
_PATH_NEAR_ON_OFF = re.compile(r"[/\\]|\.[\w~%+-]|\b[A-Z](?::|%(?:25)*3a)", re.IGNORECASE)
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


def _plain(text, limit):
    text = _MEDIA.sub(" ", _without_hidden_blocks(unescape(text or "")))
    parser = MarkdownIt().enable(["strikethrough", "table"])
    # Parse even non-web links so their destinations can be discarded. Only visible text tokens
    # are used, including link labels. Images, HTML, and inline or fenced code supply no text.
    parser.validateLink = lambda _url: True
    lines = []
    for token in parser.parse(text):
        if token.type == "inline":
            lines.append("".join(
                child.content if child.type == "text" else " "
                for child in token.children or () if child.type in {"text", "softbreak", "hardbreak", "image", "code_inline"}
            ))
    visible = _URL.sub(" ", " ".join(lines))
    option = _NEUTRAL_ON_OFF.search(visible)
    path_text = visible
    if option:
        path_text = visible[:option.start()] + " " + visible[option.end():]
        if _PATH_NEAR_ON_OFF.search(path_text):
            return ""
    if _PATH.search(path_text) or _ENCODED_PATH.search(path_text) or "![" in visible:
        # A bare path may contain spaces, and unresolved image syntax can retain private alt text.
        return ""
    if option and visible[option.end():].strip().strip(".,!?;"):
        # Even an extensionless path can have a private suffix after the neutral token.
        visible = visible[:option.end()] + "…"
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

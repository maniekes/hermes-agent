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
    r"""MEDIA:(?:\s*(?=[`"']|""" + MEDIA_PATH_START + r"""))?[^\r\n]*|\[\[(?:audio_as_voice|as_document)\]\]""",
    re.IGNORECASE,
)
# MarkdownIt replaces source NULs. Only an excluded code_inline token can supply this placeholder.
_CODE = "\0"
# Opaque markup and boundaries between cells on one source line are non-whitespace
# until the media grammar runs. A synthetic space could end a technical path early.
_OPAQUE = "\x01"
_MEDIA_CODE_VALUE = re.compile(r"MEDIA:\s*" + _CODE, re.IGNORECASE)
_URL = re.compile(r"\b(?:https?://|data:)[^\s<>]+", re.IGNORECASE)
_AMBIGUOUS_HIDDEN = re.compile(r"`|<!--|(?<!\w)['\"]")
_TITLE_TILDE_FENCE = re.compile(r"(?<!\S)~{3,}")
_TITLE_UNPAIRED_FENCE = re.compile(r"(?<!\S)`{3,}")
_UNSAFE_CHARS = re.compile(r"[\x00-\x08\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")


def _opens_hidden(tag):
    return not tag[0].startswith("</")


def _source_tags(text):
    return _HIDDEN_TAG.finditer(unescape(text))


def _hidden_openings(tags):
    return [tag[1].casefold() for tag in tags if _opens_hidden(tag)]


def _comment_slash_openings(token):
    if token.type == "image":
        return []
    comment, end, _ = token.content.partition("-->")
    if not end or not comment.lstrip().startswith("<!--") or "--!>" in comment:
        return []
    # HTML can end an abruptly closed comment at --!> before MarkdownIt does.
    return _hidden_openings(tag for tag in _source_tags(comment) if tag[0].endswith("/>"))


def _content_tokens(blocks):
    previous_map = None
    for block in blocks:
        if block.type == "inline":
            yield _OPAQUE if block.map is not None and block.map == previous_map else "\n"
            yield from block.children or ()
            previous_map = block.map
        elif block.type in {"fence", "code_block", "html_block"}:
            yield "\n"
            yield block
            previous_map = None


def _project(text, blocks, *, title):
    parts, hidden, openings = [], [], []
    quoted = False
    link = None
    for token in _content_tokens(blocks):
        if isinstance(token, str):
            parts.append(token)
        elif token.type in {"softbreak", "hardbreak"}:
            parts.append("\n")
        elif token.type in {"fence", "code_block", "code_inline"}:
            openings.extend(_hidden_openings(_source_tags(token.info + "\n" + token.content)))
            if not hidden:
                parts.append(_CODE if token.type == "code_inline" else _OPAQUE)
        elif token.type == "link_open":
            link = token.markup
        elif token.type == "link_close":
            if link == "autolink" and not hidden:
                parts.append(_OPAQUE)
            link = None
        elif token.type == "html_inline" and link is None and (tag := _HIDDEN_TAG.fullmatch(token.content)):
            # A trailing slash does not make a hidden HTML element empty.
            if quoted or tag[0].endswith("/>"):
                return ""
            name = tag[1].casefold()
            if _opens_hidden(tag):
                openings.append(name)
                hidden.append(name)
            elif token.content.startswith("</") and hidden:
                if hidden.pop() != name:
                    return ""
            parts.append(_OPAQUE)
        elif token.type == "text" and link != "autolink":
            if _HIDDEN_TAG.search(token.content) or (title and _TITLE_UNPAIRED_FENCE.search(token.content)):
                return ""
            if hidden:
                quoted = quoted or bool(_AMBIGUOUS_HIDDEN.search(token.content))
            else:
                parts.append(token.content.replace(_OPAQUE, ""))
        elif token.type in {"image", "html_inline", "html_block"}:
            openings.extend(_comment_slash_openings(token))
            if not hidden:
                parts.append(_OPAQUE)

    # A source opener must be recognized or accounted for in excluded code or comments.
    # In particular, a parser-opaque HTML block or encoded/attribute tag cannot silently
    # drop an opener. Only a complete HTML token can close an active region.
    source_tags = list(_source_tags(text))
    if openings != _hidden_openings(source_tags) or (
        hidden and any(tag[0].startswith("</") and tag[1].casefold() in hidden for tag in source_tags)
    ):
        return ""  # A suppressed potential closer cannot establish the end.
    return "".join(parts)


def _plain(text, limit, *, title=False):
    # A persisted title has collapsed whitespace and cannot prove a tilde fence's boundaries.
    if title and _TITLE_TILDE_FENCE.search(text):
        return ""
    parser = MarkdownIt().enable(["strikethrough", "table"])
    # Parse non-web links too so their destinations are discarded and explicit labels remain.
    parser.validateLink = lambda _url: True
    visible = _project(text, parser.parse(text), title=title)
    if _HIDDEN_TAG.search(visible):
        return ""
    # Clean projected text only. A code token can stand for a backtick-quoted MEDIA value,
    # but its actual content never enters the projection or a second Markdown parse.
    visible = _MEDIA_CODE_VALUE.sub(" ", visible).replace(_CODE, " ")
    visible = _MEDIA_FALLBACK.sub(" ", MEDIA_TAG_CLEANUP_RE.sub(" ", visible))
    visible = _URL.sub(" ", visible.replace(_OPAQUE, " "))
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
    title = _plain(title, 80, title=True) if title and len(title) <= PREVIEW_TITLE_SOURCE_LIMIT else ""
    return {"title": title, "body": body} if title else {"body": body}

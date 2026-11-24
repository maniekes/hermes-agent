"""Pure syntax for attachment directives shared by delivery and text previews."""
import re


# Media-delivery ext allowlist — SINGLE SOURCE OF TRUTH for both extractors and the cleanup
# regexes: a tag is stripped only when deliverable, unknown-ext paths survive in the body.
# Both extractors that turn response text into native attachments derive their extension set from this
# tuple: * ``extract_media()``       — explicit ``MEDIA:<path>`` tags * ``extract_local_files()`` — bare
# absolute/home paths the agent mentions Historically these two carried independently-maintained extension
# lists. ``extract_media`` had a narrow list (no .md/.json/.yaml/.xml/.html/...) while
# ``extract_local_files`` had a broad one. Combined with the unconditional ``MEDIA:\\s*\\S+`` cleanup at the
# dispatch sites, that mismatch created a silent black hole: a ``MEDIA:/report.md`` tag failed the narrow
# extract_media match, got stripped from the body by the loose cleanup regex, and was then invisible to
# extract_local_files — the file was never delivered (issue #34517). Keeping one list eliminates the drift;
# building the cleanup regexes from the same set means a tag is only stripped when its extension is one we
# can actually deliver, so an unknown-extension path survives in the body instead of vanishing. Covers
# images (inline), video (inline where supported), audio (voice/audio), documents/spreadsheets/presentations
# (send_document), archives, and rendered web output. The dispatch partition (image vs video vs document)
# lives in ``gateway/run.py``. ---------------------------------------------------------------------------
MEDIA_DELIVERY_EXTS: tuple[str, ...] = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg",  # images (embed inline)
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".3gp",  # video (embed inline where supported)
    ".mp3", ".m2a", ".wav", ".ogg", ".opus", ".m4a", ".flac",  # audio (voice/audio where supported)
    ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md", ".epub",  # documents (file attachments)
    ".xlsx", ".xls", ".ods", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",  # spreadsheets/data
    ".kmz", ".kml", ".geojson", ".gpx",  # geospatial / GIS
    ".pptx", ".ppt", ".odp", ".key",  # presentations
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".apk", ".ipa",  # archives
    ".html", ".htm")  # web / rendered output

# Bare extensions (no dot) longest-first so a shorter ext never matches as a prefix of a longer one.
_MEDIA_EXT_ALTERNATION = "|".join(sorted((e.lstrip(".") for e in MEDIA_DELIVERY_EXTS), key=len, reverse=True))

# Anchored ``MEDIA:<path>`` cleanup pattern (dispatch path + streaming consumer). Strips only tags
# whose path ends in a deliverable extension (optionally quoted/backticked); unknown-ext tags stay
# for the bare-path detector. Rules: anchors ``~/``, ``/``, ``X:\`` / ``X:/``; up to 3 quote/
# emphasis markers each side (code/blockquote contexts are masked earlier); non-greedy with
# ``MEDIA:`` as a boundary so glued tags (``MEDIA:/a.pngMEDIA:/b.png``) never merge; sentence-final
# ``.`` is a boundary only before whitespace/EOL (``data.csv.`` -> ``data.csv``, ``archive.tar.gz``
# extends past ``.tar``); CJK full-width punctuation terminates paths (``早报.pdf（782.6 KB）``).
# A ``MEDIA:`` tag with an unknown extension is left in the text so it can still be picked up by the
# bare-path detector (extract_local_files) downstream rather than silently deleted. Path anchors: ``~/``
# (Unix home-relative), ``/`` (Unix absolute), ``X:\\`` or ``X:/`` (Windows drive-letter absolute — #34632).
# Emphasis tolerance: models routinely wrap the tag in Markdown emphasis (``**MEDIA:/x.pdf**``,
# ``*MEDIA:/x.pdf*``, ``_MEDIA:/x.pdf_``) when they present a file to the user. The old single-quote anchor
# (``[`"']?``) and the closing lookahead (which lacked ``*``/``_``) failed to match such tags, so the file
# was silently never delivered and the literal ``MEDIA:`` text leaked into the chat. Allow a short run of
# emphasis/quote markers on both sides so the tag is recognised regardless of cosmetic Markdown. Code-block
# / inline-code / blockquote contexts are still neutralised earlier by ``_mask_protected_spans`` (#35695),
# so example tags remain non-deliverable. The trailing lookahead also accepts ``MEDIA:`` as a boundary, so
# the next tag stops the current match cleanly (#68773). The whitespace guard keeps multi-part extensions
# intact — for ``archive.tar.gz`` the ``.`` after ``tar`` is followed by ``g``, so the match must extend to
# ``.gz`` instead of stopping early at ``.tar``. CJK full-width punctuation accepted as MEDIA path
# terminators, mirroring the ASCII set in the looka below. Chinese-language agent output naturally writes
# ``MEDIA:D:\path\早报.pdf（782.6 KB）`` or ``MEDIA:...pdf：内容`` — without these, the lookahead fails and the
# attachment is silently dropped (#88038).
_MEDIA_CJK_TERMINATORS = "（）〈〉《》：，。；！？、\u201c\u201d\u2018\u2019【】"

MEDIA_PATH_START = r"(?:~/|/|[A-Za-z]:[/\\])"

MEDIA_TAG_CLEANUP_RE = re.compile(
    r'''[`"'*_]{0,3}MEDIA:\s*'''
    r'''(?P<path>`[^`\n]+?`|"[^"\n]+?"|'[^'\n]+?'|'''
    + MEDIA_PATH_START + r'''\S+?(?:[^\S\n]+\S+?)*?\.(?:''' + _MEDIA_EXT_ALTERNATION + r'''))'''
    r'''(?:(?=[\s`"'*_,;:)\]}\[''' + _MEDIA_CJK_TERMINATORS + r''']|MEDIA:|\.(?:\s|$)|$)[`"'*_]{0,3}\.?|'''
    # Escaped ``\n``/``\r``/``\t`` ends the path only before a real boundary (else ``\`` is a separator);
    # the run leaves with the tag, but quotes/emphasis after it open the next text, so they stay.
    r'''(?:\\[nrt])+(?=[\s`"'*_,;:)\]}\[''' + _MEDIA_CJK_TERMINATORS + r''']|MEDIA:|$))''',
    re.IGNORECASE)

# Extension-less (Caddyfile) / unknown-ext (.py, .log) tags deliver only after
# ``validate_media_delivery_path`` accepts them, so injected paths that don't validate stay visible.
# The bare path class is whitespace-bounded (a tag glued to the next ``MEDIA:`` or prose must not
# absorb it); spaced paths are recovered by ``_match_extensionless_path`` with on-disk validation.
# Paths NOT covered by MEDIA_TAG_CLEANUP_RE's extension alternation — both extension-less files (Caddyfile,
# Dockerfile, Makefile) and files with an unknown extension (.py, .log, .weirdext, ...) — are validated and
# delivered via MEDIA_EXTENSIONLESS_TAG_RE. Every ``MEDIA:`` path is therefore deliverable regardless of
# file type (#36060): known extensions extract unconditionally via the anchored pattern above, everything
# else extracts only after ``validate_media_delivery_path`` accepts it (exists on disk, not under the
# credential/system denylist, strict-mode rules honored), so prompt-injection paths that do not validate are
# left visible instead of silently dropped. The path class uses a tempered-greedy token (``[^\s\n`"']+?``
# followed by a ``(?=...)`` lookahead) instead of the prior ``[^\s\n`"']+`` so a tag glued to the next
# ``MEDIA:`` keyword (``MEDIA:/a.pngMEDIA:/b.png``) or to arbitrary following text (``MEDIA:/a.pngSome
# text``) cannot silently absorb the next path — that earlier behavior merged the two paths into one invalid
# string and dropped the file (#68773). The bare form stays non-greedy and whitespace-bounded — spaced paths
# are NOT absorbed at the regex level, because greedy space-tolerance would reintroduce the #68773 bug class
# (gluing the next MEDIA: tag or trailing prose into one invalid path). Instead, unknown-extension paths
# containing spaces (``MEDIA:/data/map data.kmz``, ``C:\...\My Documents\x.log``) are recovered by
# ``_match_extensionless_path`` (#24032): when the bare match fails validation, the candidate is
# progressively extended forward across single spaces — bounded, stopping at newline / the next ``MEDIA:``
# keyword — and the first extension that validates on disk wins.
MEDIA_EXTENSIONLESS_TAG_RE = re.compile(
    r'''[`"'*_]{0,3}MEDIA:\s*'''
    r'''(?P<path>`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|'''
    + MEDIA_PATH_START + r'''[^\s\n`"']+?)'''
    r'''(?=[`"'\s,;:)\]}''' + _MEDIA_CJK_TERMINATORS + r''']|MEDIA:|$)'''
    r'''[`"'*_]{0,3}\s*''',
    re.IGNORECASE)

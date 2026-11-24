"""Independent requirements tests. Real handlers and durable settlements, synthetic sends."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from gateway.web_push import store
from gateway.web_push.preview import make_preview
from hermes_cli.browser_credential import generation
from tests.gateway.test_web_push import credentials, endpoint
from tests.hermes_cli.test_webapp_gated_sign_out import gated
from tests.hermes_cli.test_webapp_push_lifecycle import _act, _enroll, _preview_turn, fixture


def _consent(fixture, endpoint):
    assert _enroll(fixture.browser, endpoint, profile="beta").status_code == 200
    assert _act(fixture.browser, "privacy", "beta", {"preview": True}).json() == {"preview": True}


def test_generic_ack_before_transport_cannot_leave_preview_in_unsent_payload(fixture, endpoint, monkeypatch):
    _consent(fixture, endpoint)
    _preview_turn(fixture, monkeypatch, "Synthetic confidential draft", title="Synthetic private title")
    push = fixture.runner.web_push
    checked, resume = Event(), Event()
    original = store.dispatch_preview
    reads = []

    def advance(conn, row):
        option = original(conn, row)
        reads.append(option)
        if len(reads) == 2:
            checked.set()
            assert resume.wait(7)
        return option

    monkeypatch.setattr(store, "dispatch_preview", advance)
    with ThreadPoolExecutor(max_workers=1) as executor:
        attempt = executor.submit(push.deliver_one, fixture.beta, "beta", generation())
        try:
            assert checked.wait(5)
            assert reads == [True, True]
            assert _act(fixture.browser, "privacy", "beta", {"preview": False}).json() == {"preview": False}
            assert fixture.sends == []
        finally:
            resume.set()
        assert attempt.result(timeout=5)

    assert len(fixture.sends) == 1
    assert "preview" not in fixture.sends[0][1]


@pytest.mark.parametrize("answer,hidden", [
    ("<analysis>private sample `</analysis>` INTERNAL_THOUGHT</analysis> **Wynik**", "INTERNAL_THOUGHT"),
    ("Wynik\nMEDIA: /tmp/synthetic meeting recording.png", "meeting recording.png"),
    ("Wynik ![private label][unresolved]", "private label"),
    ("Wynik ![PRIVATE_CAPTION][attachment]" + "\n\n" + "x" * 16400 +
     "\n\n[attachment]: /tmp/image.png", "PRIVATE_CAPTION"),
], ids=["quoted-hidden-close", "technical-media-directive", "unresolved-image", "reference-image-crosses-input-bound"])
def test_preview_omits_invisible_and_media_content(fixture, endpoint, monkeypatch, answer, hidden):
    _consent(fixture, endpoint)
    _preview_turn(fixture, monkeypatch, answer)
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    payload = fixture.sends[0][1]
    assert payload["kind"] == "turn"
    assert hidden not in payload.get("preview", {}).get("body", "")


def test_generic_confirmation_waits_only_for_the_reserved_preview(fixture, endpoint, monkeypatch):
    _consent(fixture, endpoint)
    _preview_turn(fixture, monkeypatch, "Synthetic private reply")
    push = fixture.runner.web_push
    reserved, committed, release = Event(), Event(), Event()
    send, write = push._send, store.set_preview

    def paused_send(*args):
        reserved.set()
        assert release.wait(7)
        return send(*args)

    def record_choice(*args):
        saved = write(*args)
        committed.set()
        return saved

    monkeypatch.setattr(push, "_send", paused_send)
    monkeypatch.setattr(store, "set_preview", record_choice)
    with ThreadPoolExecutor(max_workers=2) as executor:
        attempt = executor.submit(push.deliver_one, fixture.beta, "beta", generation())
        try:
            assert reserved.wait(5)
            request = executor.submit(_act, fixture.browser, "privacy", "beta", {"preview": False})
            assert committed.wait(5)
            assert not request.done() and not fixture.sends
        finally:
            release.set()
        assert attempt.result(timeout=5)
        assert request.result(timeout=5).json() == {"preview": False}
    assert len(fixture.sends) == 1


def test_sender_keeps_visible_paths_and_on_off_prose(fixture, endpoint, monkeypatch):
    _consent(fixture, endpoint)
    _preview_turn(fixture, monkeypatch, "Poprawka dziedziczenia ON/OFF jest gotowa.", title="Tryb ON/OFF")
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert fixture.sends[-1][1]["preview"] == {
        "title": "Tryb ON/OFF", "body": "Poprawka dziedziczenia ON/OFF jest gotowa.",
    }
    visible_path = "Synthetic Archive ON/OFF"
    _preview_turn(fixture, monkeypatch, visible_path, title=visible_path, request_id="visible-spaced-path")
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert fixture.sends[-1][1]["preview"] == {"title": visible_path, "body": visible_path}

    assert _act(fixture.browser, "privacy", "beta", {"preview": False}).json() == {"preview": False}
    _preview_turn(fixture, monkeypatch, visible_path, title="/synthetic/report.pdf", request_id="visible-opt-out")
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert "preview" not in fixture.sends[-1][1]


@pytest.mark.parametrize("source", [
    "/synthetic/report.pdf",
    "../synthetic/archive report.pdf",
    "Synthetic Archive ON/OFF",
    r"C:\Synthetic Work\recording.png",
    "C:%5CSynthetic%5Crecording",
    "file%3A%2Fsynthetic%2Frecording",
    "%252Fsynthetic%252Frecording",
    "sandbox:/synthetic/recording.png",
])
def test_visible_paths_are_literal_in_body_and_title(source):
    visible = "Wynik " + source
    assert make_preview(visible, visible) == {"title": visible, "body": visible}


def test_visible_paths_do_not_restore_technical_attachment_text():
    assert make_preview("Tryb ON/OFF. ![ukryty tytuł][unresolved]",
                        "Wynik [plik](sandbox:/synthetic/attachment.png).\n"
                        "MEDIA: /synthetic private/ON/OFF.png\n[[as_document]]\n"
                        "Sprawdź /synthetic/visible.txt.") == {
        "body": "Wynik plik. Sprawdź /synthetic/visible.txt.",
    }


@pytest.mark.parametrize(("separator", "path"), [
    ("\n", "/synthetic/SYNTH_ATTACHMENT_NAME.png"),
    ("\r\n \t", "/synthetic/SYNTH attachment name.png"),
    ("\n\n ", '"./SYNTH quoted attachment"'),
    (" ", r"'C:\Synthetic Work\SYNTH attachment.pdf'"),
    ("\r\n", "`~/SYNTH attachment`"),
])
def test_sender_strips_supported_media_directives_and_keeps_adjacent_prose(fixture, endpoint, monkeypatch, separator, path):
    from gateway.platforms.base import MEDIA_TAG_CLEANUP_RE

    text = "Przed MEDIA:" + separator + path + " po. ON/OFF działa."
    assert MEDIA_TAG_CLEANUP_RE.search(text).group("path") == path
    _consent(fixture, endpoint)
    sid, admission = _preview_turn(fixture, monkeypatch, text, title=text)
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert fixture.sends == [(endpoint, {
        "kind": "turn", "id": admission, "session": sid, "profile": "beta",
        "preview": {"title": "Przed po. ON/OFF działa.", "body": "Przed po. ON/OFF działa."},
    })]


def test_preview_omits_ambiguous_media_line_without_losing_following_prose():
    assert make_preview(None, "Jawne.\nMEDIA:\n/synthetic/extensionless attachment\n"
                        "Dalej.\nMEDIA:\nZwykłe zdanie.") == {"body": "Jawne. Dalej. Zwykłe zdanie."}


def test_sender_omits_automatic_targets_but_keeps_explicit_labels_and_paths(fixture, endpoint, monkeypatch):
    title = "Raport <file:///synthetic/SYNTH_AUTO_FILE.txt> [etykieta](sandbox:/synthetic/label.txt)"
    body = ("Wynik <file:///synthetic/SYNTH_AUTO_FILE.txt> <sandbox:/synthetic/SYNTH_AUTO_SANDBOX.png> "
            "<ftp://example.test/SYNTH_AUTO_FTP> <urn:synthetic:SYNTH_AUTO_URN> "
            "<SYNTH_AUTO_EMAIL@example.test> <mailto:SYNTH_AUTO_MAILTO@example.test> "
            "<https://example.test/SYNTH_AUTO_HTTP> [**plik**](file:///synthetic/SYNTH_LABELED_DEST.txt).\n"
            "<analysis>SYNTH_HIDDEN</analysis> ON/OFF działa. "
            "file:///synthetic/visible.txt sandbox:/synthetic/visible.png %2Fsynthetic%2Fvisible")
    _consent(fixture, endpoint)
    sid, admission = _preview_turn(fixture, monkeypatch, body, title=title)
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert fixture.sends == [(endpoint, {
        "kind": "turn", "id": admission, "session": sid, "profile": "beta",
        "preview": {
            "title": "Raport etykieta",
            "body": ("Wynik plik. ON/OFF działa. "
                     "file:///synthetic/visible.txt sandbox:/synthetic/visible.png %2Fsynthetic%2Fvisible"),
        },
    })]


def _delivered_preview(fixture, endpoint, monkeypatch, answer, title=None):
    _consent(fixture, endpoint)
    sid, admission = _preview_turn(fixture, monkeypatch, answer, title=title)
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert len(fixture.sends) == 1
    recipient, payload = fixture.sends[0]
    assert recipient == endpoint
    assert (payload["kind"], payload["id"], payload["session"], payload["profile"]) == ("turn", admission, sid, "beta")
    return payload.get("preview", {}), sid


@pytest.mark.parametrize("technical", [
    "```MEDIA:/synthetic/file.png\nSYNTH_CODE_CANARY\n```",
    "~~~MEDIA:/synthetic/file.png\nSYNTH_CODE_CANARY\n~~~",
    "`MEDIA:/synthetic/file.png SYNTH_CODE_CANARY`",
    "``MEDIA:/synthetic/file.png ` SYNTH_CODE_CANARY``",
    "MEDIA:/synthetic/file.png`SYNTH_CODE_CANARY`",
    "`<analysis>SYNTH_CODE_CANARY</analysis>`",
], ids=["backtick-fence", "tilde-fence", "inline", "double-inline", "next-to-inline", "hidden-tag-in-code"])
def test_sender_keeps_original_code_classification(fixture, endpoint, monkeypatch, technical):
    answer = "Jawne.\n\n" + technical + "\n\nDalej."
    preview, _ = _delivered_preview(fixture, endpoint, monkeypatch, answer)
    assert preview == {"body": "Jawne. Dalej."}


@pytest.mark.parametrize(("answer", "expected"), [
    ("Jawne. <analysis>\n~~~lang\n</analysis>\nSYNTH_HIDDEN\n~~~\n\nDalej.", {}),
    ("Jawne. <analysis>\n```lang\n</analysis>\nSYNTH_HIDDEN\n```\n\nDalej.", {}),
    ("Jawne. <analysis> `</analysis>` SYNTH_HIDDEN </analysis> Dalej.", {"body": "Jawne. Dalej."}),
    ("Jawne. <analysis><!-- </analysis> --> SYNTH_HIDDEN </analysis> Dalej.", {"body": "Jawne. Dalej."}),
    ("Jawne. <analysis> \"</analysis>\" SYNTH_HIDDEN </analysis> Dalej.", {}),
    ("Jawne. <analysis> &lt;/analysis&gt; SYNTH_HIDDEN </analysis> Dalej.", {}),
    ("Jawne. &lt;analysis&gt; SYNTH_HIDDEN &lt;/analysis&gt; Dalej.", {}),
    ("Jawne. <ns:analysis>SYNTH_HIDDEN</ns:analysis> Dalej.", {}),
    ("<analysis>\nSYNTH_HIDDEN\n\nDalej.", {}),
], ids=["tilde-close", "backtick-close", "code-close", "comment-close", "quoted-close", "encoded-close",
        "encoded-open", "namespace-open", "unclosed-html-block"])
def test_sender_requires_unambiguous_hidden_boundaries(fixture, endpoint, monkeypatch, answer, expected):
    preview, _ = _delivered_preview(fixture, endpoint, monkeypatch, answer)
    assert "SYNTH_HIDDEN" not in preview.get("body", ""), preview
    assert preview == expected


@pytest.mark.parametrize(("directive", "expected"), [
    ("MEDIA:/synthetic/a.pngMEDIA:/synthetic/b.pdf po.", "Jawne po."),
    ("MEDIA:\r\n/synthetic/SYNTH_MEDIA hidden.archive", "Jawne"),
    ("MEDIA:\n/synthetic/SYNTH_MEDIA hidden.archiveMEDIA:/synthetic/nested.pdf", "Jawne"),
    ('MEDIA:\n\n"./SYNTH_MEDIA quoted archive" po.', "Jawne po."),
    ("MEDIA:\r\n`~/SYNTH_MEDIA quoted archive` po.", "Jawne po."),
])
def test_sender_media_and_link_projection_keeps_adjacent_prose(fixture, endpoint, monkeypatch, directive, expected):
    answer = ("Jawne" + directive + "\nDalej <sandbox:/synthetic/SYNTH_AUTO> [etykieta](file:///synthetic/label.txt) "
              "ON/OFF działa. /visible %2Fvisible")
    preview, _ = _delivered_preview(fixture, endpoint, monkeypatch, answer)
    assert preview == {"body": expected + " Dalej etykieta ON/OFF działa. /visible %2Fvisible"}


@pytest.mark.parametrize(("source", "stored", "expected"), [
    ("Jawne.\n~~~MEDIA:/synthetic/file.png\nSYNTH_CODE_CANARY\n~~~\nDalej.",
     "Jawne. ~~~MEDIA:/synthetic/file.png SYNTH_CODE_CANARY ~~~ Dalej.", None),
    ("Jawne.\n<analysis>\n~~~lang\n</analysis>\nSYNTH_HIDDEN\n~~~\nDalej.",
     "Jawne. <analysis> ~~~lang </analysis> SYNTH_HIDDEN ~~~ Dalej.", None),
    ("Jawne.\n```MEDIA:/synthetic/file.png\nSYNTH_CODE_CANARY\n```\nDalej.",
     "Jawne. ```MEDIA:/synthetic/file.png SYNTH_CODE_CANARY ``` Dalej.", "Jawne. Dalej."),
    ("JawneMEDIA:\r\n/synthetic/SYNTH_MEDIA unknown.ext", "JawneMEDIA: /synthetic/SYNTH_MEDIA unknown.ext", "Jawne"),
    ("Jawne <analysis>SYNTH_HIDDEN</analysis> [plik](file:/SYNTH_DEST) /visible %2Fvis ON/OFF działa.",
     "Jawne <analysis>SYNTH_HIDDEN</analysis> [plik](file:/SYNTH_DEST) /visible %2Fvis ON/OFF działa.",
     "Jawne plik /visible %2Fvis ON/OFF działa."),
], ids=["normalized-tilde-fence", "normalized-hidden-fence", "normalized-backticks", "normalized-unknown-media",
        "normalized-visible-title"])
def test_sender_projects_actual_persisted_title(fixture, endpoint, monkeypatch, source, stored, expected):
    preview, sid = _delivered_preview(fixture, endpoint, monkeypatch, "Zwykła treść.", source)
    assert fixture.beta.db.get_session_title(sid) == stored
    assert preview == ({"body": "Zwykła treść.", "title": expected} if expected else {"body": "Zwykła treść."})


@pytest.mark.parametrize(("separator", "prefix", "suffix"), [
    (" | ", '"/synthetic/private', 'SYNTH_MEDIA.png"'),
    ("|", "/synthetic/first.png", "SYNTH_MEDIA.png"),
    ("<ftp://example.test/SYNTH_AUTO>", "/synthetic/first.png", "SYNTH_MEDIA.png"),
    ("![SYNTH_ALT](file:///synthetic/img)", "/synthetic/first.png", "SYNTH_MEDIA.png"),
    ("<analysis>SYNTH_HIDDEN</analysis>", "/synthetic/first.png", "SYNTH_MEDIA.png"),
])
def test_sender_preserves_media_spans_across_opaque_markdown(fixture, endpoint, monkeypatch, separator, prefix, suffix):
    from gateway.media_directives import MEDIA_TAG_CLEANUP_RE

    directive = "MEDIA:" + prefix + separator + suffix
    assert "SYNTH_MEDIA" in MEDIA_TAG_CLEANUP_RE.search(directive).group("path")
    table = "|" in separator
    answer = "Jawne.\n\n" + ("A | B\n--- | ---\n" if table else "") + directive + "\n\nDalej."
    preview, _ = _delivered_preview(fixture, endpoint, monkeypatch, answer)
    assert preview == {"body": "Jawne. A B Dalej." if table else "Jawne. Dalej."}

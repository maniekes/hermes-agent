"""Independent requirements tests. Real handlers and durable settlements, synthetic sends."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from gateway.web_push import store
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
    ("Wynik /tmp/synthetic meeting recording.png", "meeting recording.png"),
    ("Wynik ![PRIVATE_CAPTION][attachment]" + "\n\n" + "x" * 16400 +
     "\n\n[attachment]: /tmp/image.png", "PRIVATE_CAPTION"),
], ids=["quoted-hidden-close", "bare-spaced-media-path", "reference-image-crosses-input-bound"])
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

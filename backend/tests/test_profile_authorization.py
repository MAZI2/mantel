"""Profile IDs select data; knowing one must never grant access to it."""

import re

import pytest

from app.config import get_settings
from app.db import get_db
from app.main import app
from app.services.crypto import sign_state
from tests.test_profiles import event, headers, setup_shared

# Include every documented operation so a newly added API route gets this check too.
PROFILE_OPERATIONS = [
    (method.upper(), path)
    for path, operations in app.openapi()["paths"].items()
    for method in operations
    if method in {"get", "post", "put", "patch", "delete", "head", "options"}
    and path not in {"/api/health", "/api/session", "/api/accounts/google/callback"}
    and not path.endswith(".ics")
]


@pytest.mark.parametrize("selector", ["query", "header"])
@pytest.mark.parametrize("method,path", PROFILE_OPERATIONS)
def test_every_operation_rejects_a_nonmember_before_accessing_profile_data(
    client, monkeypatch, selector, method, path
):
    private, _ = setup_shared(client)
    monkeypatch.setattr(get_settings(), "mantel_auth_mode", "proxy")
    supplied = headers()
    params = {"profile": private} if selector == "query" else {}
    if selector == "header":
        supplied["X-Mantel-Profile"] = private
    supplied["X-Mantel-Admin"] = "true"

    def forbidden_database():
        pytest.fail("Unauthorized request reached a profile database dependency")

    app.dependency_overrides[get_db] = forbidden_database
    try:
        response = client.request(
            method,
            re.sub(r"\{[^}]+\}", "1", path),
            headers=supplied,
            params=params,
            json={},
            follow_redirects=False,
        )
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 403, (method, path, selector, response.text)
    assert response.json()["error"]["code"] == "access_denied"
    assert "no-store" in response.headers["Cache-Control"]


def test_changing_the_url_or_header_cannot_read_edit_or_delete_private_events(client, monkeypatch):
    private, shared = setup_shared(client)
    private_event = event(client, "Private appointment", private).json()
    shared_event = event(client, "Shared appointment", shared, "partner").json()
    assert private_event["id"] == shared_event["id"]
    monkeypatch.setattr(get_settings(), "mantel_auth_mode", "proxy")
    for supplied, params in (
        (headers(), {"profile": private}),
        (headers(profile=private), {}),
        (headers(profile=private), {"profile": shared}),
    ):
        assert client.get("/api/events/1", headers=supplied, params=params).status_code == 403
        assert (
            client.patch(
                "/api/events/1", headers=supplied, params=params, json={"title": "Intrusion"}
            ).status_code
            == 403
        )
        assert client.delete("/api/events/1", headers=supplied, params=params).status_code == 403
        assert (
            client.patch(
                "/api/settings", headers=supplied, params=params, json={"day_start_hour": 3}
            ).status_code
            == 403
        )
    # The explicit header wins over the query selector, but still checks membership.
    response = client.get(
        "/api/events/1", headers=headers(profile=shared), params={"profile": private}
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Shared appointment"
    assert (
        client.get("/api/events/1", headers=headers("local-admin", private)).json()["title"]
        == "Private appointment"
    )
    assert (
        client.get("/api/settings", headers=headers("local-admin", private)).json()[
            "day_start_hour"
        ]
        != 3
    )
    session = client.get("/api/session", headers=headers(), params={"profile": private}).json()
    assert [profile["id"] for profile in session["profiles"]] == [shared]
    assert session["default_profile_id"] == shared


def test_google_callback_rechecks_membership_in_the_profile_from_signed_state(client, monkeypatch):
    private, _ = setup_shared(client)
    monkeypatch.setattr(get_settings(), "mantel_auth_mode", "proxy")
    # Even a valid signature cannot authorize a profile the person no longer belongs to.
    state = sign_state({"identity": "partner", "profile_id": private})
    response = client.get(
        "/api/accounts/google/callback",
        headers=headers(),
        params={"state": state, "code": "unused"},
        follow_redirects=False,
    )
    assert response.status_code == 403

"""Exercise isolation through HTTP, including matching row IDs in different databases."""

from urllib.parse import parse_qs, urlsplit

import pytest

from app.config import get_settings
from app.profile_context import current_profile
from app.profiles import bootstrap_registry
from app.services import scheduler
from tests.test_photos import make_image


def headers(identity="partner", profile=None):
    result = {"X-Mantel-Identity": identity, "X-Mantel-Proxy-Secret": "test-proxy-secret"}
    if profile:
        result["X-Mantel-Profile"] = profile
    return result


def setup_shared(client):
    personal = client.get("/api/session").json()["default_profile_id"]
    shared = client.post("/api/admin/profiles", json={"name": "Shared", "members": ["local-admin"]})
    assert shared.status_code == 201, shared.text
    shared = shared.json()["id"]
    response = client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "profile_ids": [shared],
            "default_profile_id": shared,
        },
    )
    assert response.status_code == 200, response.text
    return personal, shared


def event(client, title, profile=None, identity="local-admin"):
    return client.post(
        "/api/events",
        headers=headers(identity, profile),
        json={
            "calendar_id": 1,
            "title": title,
            "start_at": "2026-10-22T10:00:00Z",
            "end_at": "2026-10-22T11:00:00Z",
        },
    )


def test_proxy_mode_fails_closed_and_does_not_trust_browser_identity(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "mantel_auth_mode", "proxy")
    assert client.get("/api/health").status_code == 200
    for supplied in (
        {},
        {"X-Mantel-Identity": "local-admin"},
        {**headers("local-admin"), "X-Mantel-Proxy-Secret": "wrong"},
    ):
        assert client.get("/api/session", headers=supplied).status_code == 401
    assert client.get("/api/session", headers=headers("local-admin")).status_code == 200
    monkeypatch.setattr(get_settings(), "mantel_proxy_secret", "")
    assert client.get("/api/settings", headers=headers("local-admin")).status_code == 503


def test_unknown_identity_is_not_provisioned_and_bootstrap_never_regrants_roles(
    client, monkeypatch
):
    assert client.get("/api/session", headers=headers("unknown")).status_code == 403
    before = client.get("/api/admin/profiles").json()
    monkeypatch.setattr(get_settings(), "mantel_bootstrap_admin_identity", "unknown")
    bootstrap_registry()
    assert client.get("/api/admin/profiles", headers=headers("local-admin")).json() == before


def test_only_explicit_memberships_are_visible_and_default_is_personal(client):
    personal, shared = setup_shared(client)
    admin = client.get("/api/session").json()
    partner = client.get("/api/session", headers=headers()).json()
    assert admin["default_profile_id"] == personal
    assert {p["id"] for p in admin["profiles"]} == {personal, shared}
    assert partner["default_profile_id"] == shared
    assert [p["id"] for p in partner["profiles"]] == [shared]
    assert len(client.get("/api/admin/profiles").json()["profiles"]) == 2
    assert (
        client.get(
            "/api/admin/profiles", headers={**headers(), "X-Mantel-Admin": "true"}
        ).status_code
        == 403
    )
    assert (
        client.post("/api/admin/profiles", headers=headers(), json={"name": "Mine"}).status_code
        == 403
    )


@pytest.mark.parametrize(
    "path",
    [
        "/settings",
        "/events/1",
        "/accounts",
        "/calendars",
        "/users",
        "/photos/1/file",
        "/sync/status",
        "/feeds/token",
        "/dashboard/widgets",
        "/lists",
    ],
)
def test_membership_is_checked_before_any_profile_data_is_read(client, path):
    personal, _ = setup_shared(client)
    assert client.get(f"/api{path}", headers=headers(profile=personal)).status_code == 403
    assert client.get(f"/api{path}?profile={personal}", headers=headers()).status_code == 403


def test_settings_events_and_credentials_are_independent_but_shared_members_can_edit(client):
    private_event = event(client, "Private")
    assert private_event.status_code == 201
    client.patch("/api/settings", json={"theme": "daylight", "hidden_calendar_ids": [1]})
    client.patch(
        "/api/settings", json={"google_client_id": "personal", "google_client_secret": "private"}
    )
    personal, shared = setup_shared(client)
    shared_headers = headers(profile=shared)
    assert client.get("/api/accounts", headers=shared_headers).json() == []
    assert client.get("/api/settings", headers=shared_headers).json()["hidden_calendar_ids"] == []
    assert client.get("/api/settings", headers=shared_headers).json()["theme"] == "midnight"
    assert client.get("/api/settings").json()["theme"] == "daylight"
    assert (
        client.get("/api/settings", headers=shared_headers).json()["google_client_id"] != "personal"
    )
    shared_event = event(client, "Together", shared, "partner")
    assert shared_event.status_code == 201, shared_event.text
    assert shared_event.json()["id"] == private_event.json()["id"]
    client.patch(
        "/api/events/1", headers=headers("local-admin", shared), json={"title": "Edited by admin"}
    )
    assert client.get("/api/events/1", headers=shared_headers).json()["title"] == "Edited by admin"
    assert client.get("/api/events/1").json()["title"] == "Private"
    client.patch(
        "/api/settings",
        headers=shared_headers,
        json={"hidden_calendar_ids": [1], "day_start_hour": 7},
    )
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()["day_start_hour"]
        == 7
    )
    assert client.delete("/api/events/1", headers=shared_headers).status_code == 204
    assert client.get("/api/events/1", headers=headers("local-admin", personal)).status_code == 200


def test_existing_data_is_retained_through_repeated_bootstrap(client):
    event(client, "Existing")
    before = client.get("/api/session").json()
    bootstrap_registry()
    assert client.get("/api/session").json() == before
    assert client.get("/api/events/1").json()["title"] == "Existing"


def test_photo_urls_are_profile_bound_and_never_publicly_cached(client):
    personal, shared = setup_shared(client)
    private = client.post(
        "/api/photos", files={"file": ("private.jpg", make_image(), "image/jpeg")}
    ).json()
    common = client.post(
        "/api/photos",
        headers=headers(profile=shared),
        files={"file": ("shared.jpg", make_image(color=(255, 0, 0)), "image/jpeg")},
    ).json()
    assert private["id"] == common["id"]
    assert f"profile={personal}" in private["url"]
    assert client.get(private["url"], headers=headers()).status_code == 403
    response = client.get(common["url"], headers=headers())
    assert response.status_code == 200
    assert "no-store" in response.headers["Cache-Control"]
    assert client.get(common["url"]).content != client.get(private["url"]).content


def test_subscription_links_and_uids_cannot_be_used_for_another_profile(client):
    personal, shared = setup_shared(client)
    event(client, "Private")
    event(client, "Shared", shared)
    private = client.get("/api/feeds/token").json()
    common = client.get("/api/feeds/token", headers=headers(profile=shared)).json()
    assert private["token"] != common["token"]
    response = client.get(f"/api/feeds/all.ics?profile={shared}&token={private['token']}")
    assert response.status_code == 403
    private_feed = client.get(
        urlsplit(private["all_calendars_url"]).path
        + "?"
        + urlsplit(private["all_calendars_url"]).query
    )
    shared_feed = client.get(
        urlsplit(common["all_calendars_url"]).path
        + "?"
        + urlsplit(common["all_calendars_url"]).query
    )
    assert private_feed.status_code == shared_feed.status_code == 200
    assert "SUMMARY:Private" in private_feed.text and "SUMMARY:Shared" not in private_feed.text
    assert "SUMMARY:Shared" in shared_feed.text and "SUMMARY:Private" not in shared_feed.text
    private_uid = next(line for line in private_feed.text.splitlines() if line.startswith("UID:"))
    shared_uid = next(line for line in shared_feed.text.splitlines() if line.startswith("UID:"))
    assert private_uid != shared_uid
    assert personal != shared


def test_google_callback_uses_originating_profile_and_person_even_after_switching(
    client, monkeypatch
):
    import httpx

    from app.services import google_oauth
    from app.services.google_api import GoogleCalendarClient
    from app.services.providers import google as google_provider

    personal, shared = setup_shared(client)
    for profile in (personal, shared):
        client.patch(
            "/api/settings",
            headers=headers("local-admin", profile),
            json={
                "google_client_id": "client",
                "google_client_secret": "secret",
                "public_base_url": "http://testserver",
            },
        )
        client.post(
            "/api/users",
            headers=headers("local-admin", profile),
            json={"name": "Owner", "color": "#123456"},
        )
    url = client.get(
        "/api/accounts/google/auth-url?user_id=1", headers=headers(profile=shared)
    ).json()["url"]
    state = parse_qs(urlsplit(url).query)["state"][0]

    def respond(request):
        if str(request.url) == google_oauth.TOKEN_URL:
            return httpx.Response(200, json={"access_token": "access", "refresh_token": "refresh"})
        if str(request.url) == google_oauth.USERINFO_URL:
            return httpx.Response(200, json={"email": "same@example.test"})
        assert request.url.path == "/calendar/v3/users/me/calendarList"
        return httpx.Response(200, json={"items": []})

    http = httpx.Client(transport=httpx.MockTransport(respond))
    monkeypatch.setattr(google_oauth.httpx, "post", http.post)
    monkeypatch.setattr(google_oauth.httpx, "get", http.get)
    monkeypatch.setattr(
        google_provider,
        "GoogleCalendarClient",
        lambda token: GoogleCalendarClient(token, http=http),
    )
    callback = f"/api/accounts/google/callback?state={state}&code=test"
    assert (
        client.get(
            callback, headers=headers("local-admin", personal), follow_redirects=False
        ).status_code
        == 400
    )
    response = client.get(callback, headers=headers("partner", personal), follow_redirects=False)
    assert response.status_code == 307, response.text
    assert f"profile={shared}" in response.headers["Location"]
    assert client.get("/api/accounts").json() == []
    assert (
        client.get("/api/accounts", headers=headers(profile=shared)).json()[0]["email"]
        == "same@example.test"
    )
    # The same provider account may be connected separately to the personal profile.
    url = client.get("/api/accounts/google/auth-url?user_id=1").json()["url"]
    own_state = parse_qs(urlsplit(url).query)["state"][0]
    assert (
        client.get(
            f"/api/accounts/google/callback?state={own_state}&code=test", follow_redirects=False
        ).status_code
        == 307
    )
    assert client.get("/api/accounts").json()[0]["email"] == "same@example.test"
    client.put(
        "/api/admin/people/partner",
        json={"identity": "partner", "name": "Partner", "profile_ids": []},
    )
    assert client.get(callback, headers=headers(), follow_redirects=False).status_code == 403


def test_archiving_revokes_access_and_stops_sync_without_erasing_data(client, monkeypatch):
    personal, shared = setup_shared(client)
    event(client, "Keep me", shared)
    visited = []

    def work(db):
        visited.append(current_profile.get().id)
        if current_profile.get().id == personal:
            raise RuntimeError("A broken provider")
        return 2

    monkeypatch.setattr(scheduler.sync_engine, "push_pending", work)
    assert scheduler._push_once() == 2
    assert set(visited) == {personal, shared}
    client.patch(f"/api/admin/profiles/{shared}", json={"active": False})
    assert client.get("/api/settings", headers=headers(profile=shared)).status_code == 403
    assert client.get("/api/session", headers=headers()).json()["profiles"] == []
    visited.clear()
    scheduler._push_once()
    assert visited == [personal]
    client.patch(f"/api/admin/profiles/{shared}", json={"active": True})
    assert client.get("/api/events/1", headers=headers(profile=shared)).json()["title"] == "Keep me"


def test_last_admin_protection_and_membership_is_required_even_for_admin(client):
    personal, shared = setup_shared(client)
    payload = {
        "identity": "local-admin",
        "name": "Admin",
        "profile_ids": [shared],
        "default_profile_id": shared,
    }
    assert client.put("/api/admin/people/local-admin", json=payload).status_code == 400
    assert (
        client.put("/api/admin/people/local-admin", json={**payload, "is_admin": True}).status_code
        == 200
    )
    assert client.get("/api/settings", headers=headers("local-admin", personal)).status_code == 403
    assert client.get("/api/session").json()["default_profile_id"] == shared
    assert (
        client.put(
            "/api/admin/people/local-admin", json={**payload, "is_admin": True, "enabled": False}
        ).status_code
        == 400
    )


def test_cross_site_requests_are_rejected(client):
    assert (
        client.patch(
            "/api/settings", headers={"Origin": "https://other.example"}, json={"day_start_hour": 6}
        ).status_code
        == 403
    )
    assert client.get("/api/settings", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get("/api/settings", headers={"Origin": "http://testserver"}).status_code == 200


def test_concurrent_requests_keep_their_own_profile_context(client):
    from concurrent.futures import ThreadPoolExecutor

    _, shared = setup_shared(client)
    client.patch("/api/settings", json={"day_start_hour": 5})
    client.patch("/api/settings", headers=headers(profile=shared), json={"day_start_hour": 9})

    def read(shared_request):
        selected = headers(profile=shared) if shared_request else headers("local-admin")
        return client.get("/api/settings", headers=selected).json()["day_start_hour"]

    requests = [False, True] * 12
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(read, requests)) == [
            9 if shared_request else 5 for shared_request in requests
        ]


def test_themes_are_per_person_and_profile_while_other_settings_stay_shared(client):
    personal, shared = setup_shared(client)
    partner = headers(profile=shared)
    admin = headers("local-admin", shared)
    assert client.patch("/api/settings", json={"theme": "daylight"}).status_code == 200
    assert client.get("/api/settings", headers=partner).json()["theme"] == "midnight"
    assert client.get("/api/settings", headers=admin).json()["theme"] == "midnight"
    client.patch("/api/settings", headers=admin, json={"theme": "hearth"})
    result = client.patch(
        "/api/settings",
        headers=partner,
        json={"theme": "daylight", "day_start_hour": 9, "hidden_calendar_ids": [1]},
    )
    assert result.status_code == 200
    own = client.get("/api/settings", headers=admin).json()
    assert own["theme"] == "hearth"
    assert own["day_start_hour"] == 9 and own["hidden_calendar_ids"] == []
    assert client.get("/api/settings", headers=partner).json()["hidden_calendar_ids"] == [1]
    assert client.get("/api/settings").json()["theme"] == "daylight"
    client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "profile_ids": [personal, shared],
            "default_profile_id": shared,
        },
    )
    partner_personal = headers(profile=personal)
    assert client.get("/api/settings", headers=partner_personal).json()["theme"] == "midnight"
    client.patch("/api/settings", headers=partner_personal, json={"theme": "hearth"})
    assert client.get("/api/settings", headers=partner_personal).json()["theme"] == "hearth"
    assert client.get("/api/settings", headers=partner).json()["theme"] == "daylight"
    assert client.get("/api/settings").json()["theme"] == "daylight"
    assert client.patch("/api/settings", headers=partner, json={"theme": "neon"}).status_code == 400
    assert client.get("/api/settings", headers=partner).json()["theme"] == "daylight"


def test_selected_profiles_previous_shared_theme_seeds_personal_preference_once(client, db):
    from app.models import AppSetting
    from app.profiles import ProfilePreference, RegistrySession

    personal, shared = setup_shared(client)
    db.get(AppSetting, "theme").value = {"value": "hearth"}
    db.commit()
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()["theme"]
        == "midnight"
    )
    assert client.get("/api/settings").json()["theme"] == "hearth"
    db.get(AppSetting, "theme").value = {"value": "daylight"}
    db.commit()
    assert client.get("/api/settings").json()["theme"] == "hearth"
    with RegistrySession() as registry:
        assert registry.get(ProfilePreference, ("local-admin", personal)).theme == "hearth"


def test_old_personal_theme_seeds_each_profile_without_linking_later_changes(client):
    from app.profiles import PersonalPreference, RegistrySession

    personal, shared = setup_shared(client)
    with RegistrySession() as registry:
        registry.add(PersonalPreference(identity="local-admin", theme="hearth"))
        registry.commit()
    assert client.get("/api/settings").json()["theme"] == "hearth"
    client.patch("/api/settings", json={"theme": "daylight"})
    # Even a profile first visited later keeps the old choice, not the latest edit.
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()["theme"]
        == "hearth"
    )
    client.patch(
        "/api/settings", headers=headers("local-admin", shared), json={"theme": "midnight"}
    )
    assert client.get("/api/settings").json()["theme"] == "daylight"
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()["theme"]
        == "midnight"
    )


def test_remove_person_revokes_access_and_removes_preferences_but_keeps_profile_data(client):
    from app.profiles import (
        Membership,
        PersonalPreference,
        Principal,
        ProfilePreference,
        RegistrySession,
    )

    _, shared = setup_shared(client)
    with RegistrySession() as registry:
        registry.add(PersonalPreference(identity="partner", theme="midnight"))
        registry.commit()
    event(client, "Keep shared event", shared, "partner")
    client.patch("/api/settings", headers=headers(profile=shared), json={"theme": "hearth"})
    assert client.delete("/api/admin/people/local-admin", headers=headers()).status_code == 403
    assert client.delete("/api/admin/people/partner").status_code == 204
    assert client.get("/api/session", headers=headers()).status_code == 403
    assert client.get("/api/settings", headers=headers(profile=shared)).status_code == 403
    assert (
        client.get("/api/events/1", headers=headers("local-admin", shared)).json()["title"]
        == "Keep shared event"
    )
    with RegistrySession() as registry:
        assert registry.get(Principal, "partner") is None
        assert registry.get(PersonalPreference, "partner") is None
        assert registry.get(ProfilePreference, ("partner", shared)) is None
        assert registry.get(Membership, ("partner", shared)) is None
    assert client.delete("/api/admin/people/partner").status_code == 404
    assert client.delete("/api/admin/people/local-admin").status_code == 400


def test_removing_one_administrator_still_preserves_an_enabled_administrator(client):
    _, shared = setup_shared(client)
    client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "is_admin": True,
            "profile_ids": [shared],
            "default_profile_id": shared,
        },
    )
    assert client.delete("/api/admin/people/local-admin").status_code == 204
    assert client.get("/api/session").status_code == 403
    assert client.delete("/api/admin/people/partner", headers=headers()).status_code == 400

import pytest

from tests.test_calendar_links import WINDOW
from tests.test_profiles import event, headers, setup_shared


def test_added_events_are_live_and_shared_with_every_destination_member(client):
    personal, shared = setup_shared(client)
    original = event(client, "Shared appointment", personal).json()
    event(client, "Unrelated private appointment", personal)
    path = f"/api/events/{original['id']}/links"
    payload = dict(profile_id=shared, calendar_id=1)
    assert client.post(path, json=payload).status_code == 403
    client.patch("/api/settings", json={"enable_event_linking": True})
    linked = client.post(path, json=payload)
    assert linked.status_code == 201, linked.text
    virtual = linked.json()["id"]
    admin = headers("local-admin", shared)
    partner = headers(profile=shared)
    assert (
        client.get(f"/api/events/{virtual}", headers=admin).json()["title"] == "Shared appointment"
    )
    rows = client.get("/api/events", params=WINDOW, headers=partner).json()
    assert [(row["id"], row["title"]) for row in rows] == [(virtual, "Shared appointment")]
    assert client.get(f"/api/events/{virtual}", headers=partner).status_code == 200
    assert client.get(f"/api/events/{virtual}/edit-context", headers=partner).json() == {
        "recurrence_rule": None
    }
    mark = client.patch(
        f"/api/events/{virtual}/importance", headers=partner, json={"important": False}
    )
    assert mark.status_code == 200 and mark.json()["important"] is False
    assert client.get(f"/api/events/{virtual}", headers=admin).json()["important"] is True
    update = client.patch(f"/api/events/{virtual}", headers=partner, json={"title": "Through link"})
    assert update.status_code == 200, update.text
    assert client.get(f"/api/events/{original['id']}").json()["title"] == "Through link"
    client.patch(f"/api/events/{original['id']}", json={"title": "From source"})
    rows = client.get("/api/events", params=WINDOW, headers=admin).json()
    assert len(rows) == 1 and rows[0]["title"] == "From source"
    assert rows[0]["linked_event"] is True and rows[0]["calendar_id"] == 1
    assert client.get(f"/api/events/{virtual}", headers=partner).json()["title"] == "From source"
    assert client.post(path, json=payload).status_code == 409
    assert client.delete(f"/api/events/{virtual}", headers=partner).status_code == 204
    assert client.get(f"/api/events/{original['id']}").status_code == 404
    assert client.get("/api/events", params=WINDOW, headers=partner).json() == []


def test_sharing_one_event_does_not_grant_source_profile_or_other_reference_access(client):
    personal, shared = setup_shared(client)
    original = event(client, "Shared", personal).json()
    private = event(client, "Still private", personal).json()
    other = client.post(
        "/api/admin/profiles", json={"name": "Other", "members": ["local-admin"]}
    ).json()["id"]
    client.patch("/api/settings", json={"enable_event_linking": True})
    visible = client.post(
        f"/api/events/{original['id']}/links", json={"profile_id": shared, "calendar_id": 1}
    ).json()["id"]
    hidden = client.post(
        f"/api/events/{private['id']}/links", json={"profile_id": other, "calendar_id": 1}
    ).json()["id"]
    partner = headers(profile=shared)
    assert client.get(f"/api/events/{visible}", headers=partner).status_code == 200
    for method, suffix, body in [
        ("GET", "", None),
        ("PATCH", "", {"title": "Intrusion"}),
        ("DELETE", "", None),
        ("PATCH", "/importance", {"important": False}),
        ("GET", "/edit-context", None),
    ]:
        for selected in [personal, other]:
            assert (
                client.request(
                    method,
                    f"/api/events/{private['id']}{suffix}",
                    headers=headers(profile=selected),
                    json=body,
                ).status_code
                == 403
            )
        assert (
            client.request(
                method, f"/api/events/{hidden}{suffix}", headers=partner, json=body
            ).status_code
            == 404
        )
    assert client.get(f"/api/events/{private['id']}", headers=partner).status_code == 404
    assert client.get("/api/settings", headers=headers(profile=personal)).status_code == 403
    assert client.get("/api/accounts", headers=headers(profile=personal)).status_code == 403
    client.patch("/api/settings", headers=partner, json={"enable_event_linking": True})
    # Knowing source IDs or reference IDs cannot import an unshared event.
    assert (
        client.post(
            f"/api/events/{private['id']}/links",
            headers=headers(profile=personal),
            json={"profile_id": shared, "calendar_id": 1},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/events/{hidden}/links",
            headers=partner,
            json={"profile_id": shared, "calendar_id": 1},
        ).status_code
        == 404
    )


@pytest.mark.parametrize("revocation", ["membership", "disabled", "destination", "source"])
def test_shared_event_access_is_revoked_with_destination_access_or_archived_profiles(
    client, revocation
):
    personal, shared = setup_shared(client)
    original = event(client, "Shared", personal).json()
    client.patch("/api/settings", json={"enable_event_linking": True})
    virtual = client.post(
        f"/api/events/{original['id']}/links", json={"profile_id": shared, "calendar_id": 1}
    ).json()["id"]
    partner = headers(profile=shared)
    assert client.get(f"/api/events/{virtual}", headers=partner).status_code == 200
    if revocation in ("membership", "disabled"):
        response = client.put(
            "/api/admin/people/partner",
            json={
                "identity": "partner",
                "name": "Partner",
                "profile_ids": [] if revocation == "membership" else [shared],
                "default_profile_id": None if revocation == "membership" else shared,
                "enabled": revocation != "disabled",
            },
        )
    else:
        profile = personal if revocation == "source" else shared
        response = client.patch(f"/api/admin/profiles/{profile}", json={"active": False})
    assert response.status_code == 200, response.text
    for method, suffix, body in [
        ("GET", "", None),
        ("PATCH", "", {"title": "Intrusion"}),
        ("DELETE", "", None),
        ("PATCH", "/importance", {"important": False}),
        ("GET", "/edit-context", None),
    ]:
        assert client.request(
            method, f"/api/events/{virtual}{suffix}", headers=partner, json=body
        ).status_code in (403, 404)


def test_linked_occurrence_follows_scoped_edits_and_does_not_leak_other_occurrences(client):
    personal, shared = setup_shared(client)
    from tests.test_recurring_deletion import create_series

    event_id = create_series(client)
    client.patch("/api/settings", json={"enable_event_linking": True})
    response = client.post(
        f"/api/events/{event_id}/links",
        json=dict(profile_id=shared, calendar_id=1, occurrence_start="2026-10-28T13:00:00Z"),
    )
    assert response.status_code == 201, response.text
    partner = headers(profile=shared)
    rows = client.get("/api/events", headers=partner, params=WINDOW).json()
    assert len(rows) == 1 and rows[0]["start_at"] == "2026-10-28T13:00:00Z"
    result = client.patch(
        f"/api/events/{rows[0]['id']}",
        headers=partner,
        json=dict(
            edit_scope="this",
            occurrence_start=rows[0]["original_start_at"],
            title="Exception",
            start_at="2026-10-28T15:00:00Z",
            end_at="2026-10-28T16:00:00Z",
        ),
    )
    assert result.status_code == 200, result.text
    rows = client.get("/api/events", headers=partner, params=WINDOW).json()
    assert (
        len(rows) == 1
        and rows[0]["title"] == "Exception"
        and rows[0]["start_at"] == "2026-10-28T15:00:00Z"
    )


def test_optional_gestures_and_linking_are_personal_within_profile(client):
    personal, shared = setup_shared(client)
    for key in ["hold_to_create", "enable_event_linking", "show_important_counts"]:
        assert client.get("/api/settings").json()[key] is False
        assert client.patch("/api/settings", json={key: True}).json()[key] is True
        assert (
            client.get("/api/settings", headers=headers("local-admin", shared)).json()[key] is False
        )
        assert client.get("/api/settings", headers=headers(profile=shared)).json()[key] is False
        assert client.patch("/api/settings", json={key: "yes"}).status_code == 400


def test_long_press_delay_is_validated_and_personal_per_profile(client):
    personal, shared = setup_shared(client)
    assert client.get("/api/settings").json()["long_press_ms"] == 750
    saved = client.patch("/api/settings", json={"long_press_ms": 450})
    assert saved.status_code == 200 and saved.json()["long_press_ms"] == 450
    assert client.get("/api/settings").json()["long_press_ms"] == 450
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()["long_press_ms"]
        == 750
    )
    for value in [True, None, 99, 10001, 150.5, "750"]:
        assert client.patch("/api/settings", json={"long_press_ms": value}).status_code == 400
    assert client.get("/api/settings").json()["long_press_ms"] == 450

from tests.test_calendar_links import WINDOW
from tests.test_profiles import event, headers, setup_shared


def test_event_links_are_opt_in_live_and_require_both_memberships(client):
    personal, shared = setup_shared(client)
    original = event(client, "Private", personal).json()
    path = f"/api/events/{original['id']}/links"
    payload = dict(profile_id=shared, calendar_id=1)
    assert client.post(path, json=payload).status_code == 403
    client.patch("/api/settings", json={"enable_event_linking": True})
    linked = client.post(path, json=payload)
    assert linked.status_code == 201, linked.text
    virtual = linked.json()["id"]
    admin = headers("local-admin", shared)
    partner = headers(profile=shared)
    assert client.get(f"/api/events/{virtual}", headers=admin).json()["title"] == "Private"
    assert client.get("/api/events", params=WINDOW, headers=partner).json() == []
    for method, suffix, body in [
        ("GET", "", None),
        ("PATCH", "", {"title": "Intrusion"}),
        ("DELETE", "", None),
        ("PATCH", "/importance", {"important": False}),
        ("GET", "/edit-context", None),
    ]:
        assert (
            client.request(
                method, f"/api/events/{virtual}{suffix}", headers=partner, json=body
            ).status_code
            == 403
        )
    update = client.patch(f"/api/events/{virtual}", headers=admin, json={"title": "Through link"})
    assert update.status_code == 200, update.text
    assert client.get(f"/api/events/{original['id']}").json()["title"] == "Through link"
    client.patch(f"/api/events/{original['id']}", json={"title": "From source"})
    rows = client.get("/api/events", params=WINDOW, headers=admin).json()
    assert len(rows) == 1 and rows[0]["title"] == "From source"
    assert rows[0]["linked_event"] is True and rows[0]["calendar_id"] == 1
    assert client.post(path, json=payload).status_code == 409
    assert client.delete(f"/api/events/{virtual}", headers=admin).status_code == 204
    assert client.get(f"/api/events/{original['id']}").status_code == 404


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
    admin = headers("local-admin", shared)
    rows = client.get("/api/events", headers=admin, params=WINDOW).json()
    assert len(rows) == 1 and rows[0]["start_at"] == "2026-10-28T13:00:00Z"
    result = client.patch(
        f"/api/events/{rows[0]['id']}",
        headers=admin,
        json=dict(
            edit_scope="this",
            occurrence_start=rows[0]["original_start_at"],
            title="Exception",
            start_at="2026-10-28T15:00:00Z",
            end_at="2026-10-28T16:00:00Z",
        ),
    )
    assert result.status_code == 200, result.text
    rows = client.get("/api/events", headers=admin, params=WINDOW).json()
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

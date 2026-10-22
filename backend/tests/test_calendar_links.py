from datetime import datetime

import pytest

from app.models import Event
from app.profile_context import profile_context
from app.profiles import Profile, RegistrySession, scope_for
from app.services import sync_engine
from app.services.calendar_links import virtual_id
from tests.test_google_push import fake as _fake_fixture
from tests.test_google_push import setup as _setup_fixture
from tests.test_profiles import event, headers, setup_shared

fake = pytest.fixture(_fake_fixture.__wrapped__)
setup = pytest.fixture(_setup_fixture.__wrapped__)

WINDOW = {"start": "2026-10-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"}


def link_calendar(client, source, destination, calendar_id=1):
    return client.post(
        "/api/calendars/import",
        headers=headers("local-admin", destination),
        json={"source_profile_id": source, "source_calendar_id": calendar_id},
    )


def test_linked_calendar_reads_and_edits_the_original_without_copying_events(client):
    personal, shared = setup_shared(client)
    original = event(client, "Original", personal).json()
    link = link_calendar(client, personal, shared)
    assert link.status_code == 201, link.text
    link = link.json()
    assert link["source_profile_id"] == personal and link["source_calendar_id"] == 1
    selected = headers("local-admin", shared)
    events = client.get("/api/events", params=WINDOW, headers=selected).json()
    assert len(events) == 1 and events[0]["id"] < 0
    imported = events[0]
    assert imported["calendar_id"] == link["id"]
    updated = client.patch(
        f"/api/events/{imported['id']}",
        headers=selected,
        json={"title": "Edited through link", "calendar_id": link["id"]},
    )
    assert updated.status_code == 200, updated.text
    assert client.get(f"/api/events/{original['id']}").json()["title"] == "Edited through link"
    client.patch(f"/api/events/{original['id']}", json={"title": "Edited at source"})
    assert (
        client.get(f"/api/events/{imported['id']}", headers=selected).json()["title"]
        == "Edited at source"
    )
    new = client.post(
        "/api/events",
        headers=selected,
        json={
            "calendar_id": link["id"],
            "title": "Created through link",
            "start_at": "2026-10-23T10:00:00Z",
            "end_at": "2026-10-23T11:00:00Z",
        },
    )
    assert new.status_code == 201, new.text
    assert len(client.get("/api/events", params=WINDOW).json()) == 2
    assert client.delete(f"/api/events/{new.json()['id']}", headers=selected).status_code == 204
    assert len(client.get("/api/events", params=WINDOW).json()) == 1
    assert client.delete(f"/api/calendars/{link['id']}", headers=selected).status_code == 204
    assert client.get(f"/api/events/{original['id']}").status_code == 200


def test_membership_in_both_profiles_is_required_for_links_and_every_linked_event_operation(client):
    personal, shared = setup_shared(client)
    original = event(client, "Private appointment", personal).json()
    link = link_calendar(client, personal, shared).json()
    selected = headers(profile=shared)
    assert client.get("/api/calendars/import-options", headers=selected).json() == []
    assert all(
        cal["id"] != link["id"] for cal in client.get("/api/calendars", headers=selected).json()
    )
    assert client.get("/api/events", params=WINDOW, headers=selected).json() == []
    packed = virtual_id(link["id"], original["id"])
    for method, path, body in [
        ("GET", f"/api/events/{packed}", None),
        ("PATCH", f"/api/events/{packed}", {"title": "Intrusion"}),
        ("PATCH", f"/api/events/{packed}/importance", {"important": False}),
        ("DELETE", f"/api/events/{packed}", None),
        ("GET", f"/api/calendars/{link['id']}", None),
        ("POST", "/api/calendars/import", {"source_profile_id": personal, "source_calendar_id": 1}),
        (
            "POST",
            "/api/events",
            {
                "calendar_id": link["id"],
                "title": "Intrusion",
                "start_at": "2026-10-23T10:00:00Z",
                "end_at": "2026-10-23T11:00:00Z",
            },
        ),
    ]:
        assert client.request(method, path, headers=selected, json=body).status_code == 403, (
            method,
            path,
        )
    client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "profile_ids": [personal, shared],
            "default_profile_id": shared,
        },
    )
    assert client.get(f"/api/events/{packed}", headers=selected).status_code == 200
    client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "profile_ids": [shared],
            "default_profile_id": shared,
        },
    )
    assert client.get(f"/api/events/{packed}", headers=selected).status_code == 403
    assert client.get("/api/events", params=WINDOW, headers=selected).json() == []
    assert client.get(f"/api/events/{original['id']}").json()["title"] == "Private appointment"


def test_links_do_not_expose_other_calendars_and_cannot_be_nested_or_duplicated(client):
    personal, shared = setup_shared(client)
    visible = event(client, "Selected calendar", personal).json()
    other = client.post("/api/calendars", json={"name": "Other private calendar"}).json()
    secret = client.post(
        "/api/events",
        json={
            "calendar_id": other["id"],
            "title": "Unrelated private event",
            "start_at": "2026-10-23T10:00:00Z",
            "end_at": "2026-10-23T11:00:00Z",
        },
    ).json()
    link = link_calendar(client, personal, shared).json()
    selected = headers("local-admin", shared)
    assert [
        item["title"] for item in client.get("/api/events", params=WINDOW, headers=selected).json()
    ] == ["Selected calendar"]
    forged = virtual_id(link["id"], secret["id"])
    assert client.get(f"/api/events/{forged}", headers=selected).status_code == 404
    assert client.delete(f"/api/events/{forged}", headers=selected).status_code == 404
    assert link_calendar(client, personal, shared).status_code == 409
    assert link_calendar(client, personal, personal).status_code == 400
    assert link_calendar(client, shared, personal, link["id"]).status_code == 404
    assert client.get(f"/api/events/{visible['id']}").status_code == 200


@pytest.mark.parametrize("scope,remaining", [("this", 2), ("future", 1), ("all", 0)])
def test_scoped_recurrence_deletion_through_a_link_uses_the_original_series(
    client, scope, remaining
):
    personal, shared = setup_shared(client)
    client.post(
        "/api/events",
        json={
            "calendar_id": 1,
            "title": "Weekly",
            "start_at": "2026-10-22T10:00:00Z",
            "end_at": "2026-10-22T11:00:00Z",
            "recurrence_rule": "FREQ=WEEKLY;COUNT=3",
            "timezone": "Europe/Ljubljana",
        },
    )
    link_calendar(client, personal, shared)
    selected = headers("local-admin", shared)
    occurrences = client.get("/api/events", params=WINDOW, headers=selected).json()
    chosen = occurrences[1]
    result = client.delete(
        f"/api/events/{chosen['id']}",
        headers=selected,
        params={
            "scope": scope,
            "occurrence_start": chosen["original_start_at"],
            "timezone": "Europe/Ljubljana",
        },
    )
    assert result.status_code == 204, result.text
    assert len(client.get("/api/events", params=WINDOW).json()) == remaining
    assert len(client.get("/api/events", params=WINDOW, headers=selected).json()) == remaining


def test_linked_google_edits_use_the_source_profile_push_queue(client, db, setup, fake):
    personal, shared = setup_shared(client)
    original = client.post(
        "/api/events",
        json={
            "calendar_id": setup["cal"].id,
            "title": "Source",
            "start_at": "2026-10-22T10:00:00Z",
            "end_at": "2026-10-22T11:00:00Z",
        },
    ).json()
    with RegistrySession() as registry:
        scope = scope_for(registry.get(Profile, personal))
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    link = link_calendar(client, personal, shared, setup["cal"].id).json()
    selected = headers("local-admin", shared)
    packed = virtual_id(link["id"], original["id"])
    updated = client.patch(
        f"/api/events/{packed}", headers=selected, json={"title": "Edited from shared"}
    )
    assert updated.status_code == 200 and updated.json()["sync_state"] == "pending_update"
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    assert fake.events[db.get(Event, original["id"]).remote_id]["summary"] == "Edited from shared"
    assert client.delete(f"/api/events/{packed}", headers=selected).status_code == 204
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    assert client.get(f"/api/events/{original['id']}").status_code == 404


def test_linked_importance_refers_to_the_same_personal_mark_at_the_source(client):
    personal, shared = setup_shared(client)
    original = event(client, "Appointment", personal).json()
    link = link_calendar(client, personal, shared).json()
    selected = headers("local-admin", shared)
    packed = virtual_id(link["id"], original["id"])
    assert (
        client.patch(
            f"/api/events/{packed}/importance", headers=selected, json={"important": False}
        ).status_code
        == 200
    )
    assert client.get(f"/api/events/{original['id']}").json()["important"] is False
    assert client.get(f"/api/events/{packed}", headers=selected).json()["important"] is False


def test_destination_subscription_tokens_do_not_grant_access_to_linked_calendars(client):
    personal, shared = setup_shared(client)
    event(client, "Source-only event", personal)
    event(client, "Destination event", shared)
    link = link_calendar(client, personal, shared).json()
    token = client.get("/api/feeds/token", headers=headers("local-admin", shared)).json()["token"]
    feed = client.get("/api/feeds/all.ics", params={"profile": shared, "token": token})
    assert feed.status_code == 200
    assert "Source-only event" not in feed.text and "Destination event" in feed.text
    assert (
        client.get(
            f"/api/feeds/{link['id']}.ics", params={"profile": shared, "token": token}
        ).status_code
        == 403
    )


def test_read_only_source_permissions_apply_to_linked_events(client, db, setup):
    personal, shared = setup_shared(client)
    calendar = setup["readonly"]
    event = Event(
        calendar_id=calendar.id,
        title="Read only",
        start_at=datetime(2026, 10, 22, 10),
        end_at=datetime(2026, 10, 22, 11),
        google_event_id="holiday",
        origin="google",
        sync_state="synced",
    )
    db.add(event)
    db.commit()
    link = link_calendar(client, personal, shared, calendar.id).json()
    assert link["writable"] is False
    selected = headers("local-admin", shared)
    packed = virtual_id(link["id"], event.id)
    assert client.get(f"/api/events/{packed}", headers=selected).json()["editable"] is False
    assert (
        client.patch(f"/api/events/{packed}", headers=selected, json={"title": "No"}).status_code
        == 403
    )
    assert client.delete(f"/api/events/{packed}", headers=selected).status_code == 403
    assert (
        client.patch(
            f"/api/events/{packed}/importance", headers=selected, json={"important": False}
        ).status_code
        == 200
    )


def test_linked_metadata_and_event_colours_follow_the_original_calendar(client):
    personal, shared = setup_shared(client)
    row = event(client, "Original", personal).json()
    link = link_calendar(client, personal, shared).json()
    client.patch("/api/calendars/1", json={"name": "Renamed source", "color_override": "#22c55e"})
    selected = headers("local-admin", shared)
    calendar = client.get(f"/api/calendars/{link['id']}", headers=selected).json()
    assert calendar["name"] == "Renamed source" and calendar["color"] == "#22c55e"
    packed = virtual_id(link["id"], row["id"])
    assert client.get(f"/api/events/{packed}", headers=selected).json()["color"] == "#22c55e"
    client.patch(f"/api/events/{row['id']}", json={"color_override": "#ec4899"})
    linked = client.get(f"/api/events/{packed}", headers=selected).json()
    assert linked["calendar_name"] == "Renamed source" and linked["color"] == "#ec4899"
    assert (
        client.patch(
            f"/api/calendars/{link['id']}", headers=selected, json={"name": "Separate copy"}
        ).status_code
        == 400
    )

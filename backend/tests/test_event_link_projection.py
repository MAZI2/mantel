from datetime import datetime

import pytest
from fake_google import gevent
from sqlalchemy import select

from app.models import Event
from app.profile_context import profile_context
from app.profiles import Profile, RegistrySession, scope_for
from app.services import sync_engine
from tests.test_calendar_links import WINDOW, link_calendar
from tests.test_google_push import fake as _fake_fixture
from tests.test_google_push import setup as _setup_fixture
from tests.test_profiles import event, headers, setup_shared

fake = pytest.fixture(_fake_fixture.__wrapped__)
setup = pytest.fixture(_setup_fixture.__wrapped__)


@pytest.mark.parametrize("through_calendar_link", [False, True])
def test_google_origin_link_inside_an_imported_calendar_remains_readable_and_editable(
    client, db, setup, fake, through_calendar_link
):
    personal, shared = setup_shared(client)
    item = gevent("from-google", "Google original", "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z")
    fake.events[item["id"]] = item
    fake.pages = [([item], "cursor")]
    sync_engine.pull_calendar(db, setup["cal"])
    original = db.scalar(select(Event).where(Event.google_event_id == "from-google"))
    client.patch("/api/settings", json={"enable_event_linking": True})
    source_id, source_headers = original.id, {}
    if through_calendar_link:
        visible = link_calendar(client, personal, shared, setup["cal"].id).json()
        source_headers = headers("local-admin", shared)
        client.patch("/api/settings", headers=source_headers, json={"enable_event_linking": True})
        source_id = next(
            row
            for row in client.get("/api/events", params=WINDOW, headers=source_headers).json()
            if row["calendar_id"] == visible["id"]
        )["id"]
    added = client.post(
        f"/api/events/{source_id}/links",
        headers=source_headers,
        json={"profile_id": shared, "calendar_id": 1},
    )
    assert added.status_code == 201, added.text
    # The destination copy has no account or Google resource of its own.
    shared_events = client.get("/api/events", params=WINDOW, headers=headers(profile=shared))
    assert shared_events.status_code == 200
    copies = [row for row in shared_events.json() if row["calendar_id"] == 1]
    assert len(copies) == 1
    assert fake.inserted == []
    # A destination-only member can edit the shared event, including its original
    # Google resource, without gaining access to the source profile or credentials.
    changed = client.patch(
        f"/api/events/{copies[0]['id']}",
        headers=headers(profile=shared),
        json={"title": "Edited by destination member"},
    )
    assert changed.status_code == 200, changed.text
    with RegistrySession() as registry:
        scope = scope_for(registry.get(Profile, personal))
    db.expire_all()
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    assert fake.events["from-google"]["summary"] == "Edited by destination member"
    assert fake.inserted == []
    assert client.get("/api/accounts", headers=headers(profile=personal)).status_code == 403
    imported = link_calendar(client, shared, personal).json()
    listed = client.get("/api/events", params=WINDOW)
    assert listed.status_code == 200, listed.text
    projected = next(row for row in listed.json() if row["calendar_id"] == imported["id"])
    assert abs(projected["id"]) < 2**53
    assert (
        client.get(f"/api/events/{projected['id']}").json()["title"]
        == "Edited by destination member"
    )
    changed = client.patch(
        f"/api/events/{projected['id']}",
        json={
            "title": "From another profile",
            "calendar_id": imported["id"],
            "start_at": "2026-10-22T14:00:00Z",
            "end_at": "2026-10-22T15:00:00Z",
        },
    )
    assert changed.status_code == 200, changed.text
    with RegistrySession() as registry:
        scope = scope_for(registry.get(Profile, personal))
    db.expire_all()
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    assert fake.events["from-google"]["summary"] == "From another profile"
    assert fake.inserted == []
    db.expire_all()
    assert db.get(Event, original.id).start_at == datetime(2026, 10, 22, 14)
    assert client.get("/api/events", params=WINDOW).status_code == 200
    marked = client.patch(f"/api/events/{projected['id']}/importance", json={"important": False})
    assert marked.status_code == 200 and marked.json()["important"] is False
    deleted = client.delete(f"/api/events/{projected['id']}")
    assert deleted.status_code == 204
    db.expire_all()
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    assert "from-google" in fake.deleted


def test_projected_link_rechecks_membership_of_intermediate_profile(client):
    personal, shared = setup_shared(client)
    original = event(client, "Original", personal).json()
    client.patch("/api/settings", json={"enable_event_linking": True})
    client.post(
        f"/api/events/{original['id']}/links", json={"profile_id": shared, "calendar_id": 1}
    )
    imported = link_calendar(client, shared, personal).json()
    projected = next(
        row
        for row in client.get("/api/events", params=WINDOW).json()
        if row["calendar_id"] == imported["id"]
    )

    def memberships(profiles):
        return client.put(
            "/api/admin/people/partner",
            json={
                "identity": "partner",
                "name": "Partner",
                "profile_ids": profiles,
                "default_profile_id": personal,
            },
        )

    assert memberships([personal, shared]).status_code == 200
    selected = headers("partner", personal)
    assert client.get(f"/api/events/{projected['id']}", headers=selected).status_code == 200
    assert memberships([personal]).status_code == 200
    assert client.get(f"/api/events/{projected['id']}", headers=selected).status_code == 403
    assert client.get(f"/api/events/{original['id']}", headers=selected).status_code == 200


def test_bad_reference_does_not_hide_healthy_events_in_destination(client):
    from app.profiles import EventReference

    personal, shared = setup_shared(client)
    healthy = event(client, "Healthy destination event", shared).json()
    with RegistrySession() as registry:
        registry.add(
            EventReference(
                destination_profile_id=shared,
                destination_calendar_id=1,
                source_profile_id=personal,
                source_calendar_id=1,
                event_key="bad-key",
            )
        )
        registry.commit()
    response = client.get("/api/events", params=WINDOW, headers=headers("local-admin", shared))
    assert response.status_code == 200, response.text
    assert [row["id"] for row in response.json()] == [healthy["id"]]

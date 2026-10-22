from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import Event
from app.profile_context import profile_context
from app.profiles import Profile, RegistrySession, scope_for
from app.services import sync_engine
from tests.test_google_push import fake as _fake_fixture
from tests.test_google_push import setup as _setup_fixture
from tests.test_profiles import event, headers, setup_shared

fake = pytest.fixture(_fake_fixture.__wrapped__)
setup = pytest.fixture(_setup_fixture.__wrapped__)


def test_default_is_personal_across_profiles_and_star_is_personal_within_a_profile(client):
    personal, shared = setup_shared(client)
    assert client.get("/api/settings").json()["important_by_default"] is True
    assert client.get("/api/settings").json()["highlight_important"] is False
    client.patch("/api/settings", json={"important_by_default": False, "highlight_important": True})
    other = client.get("/api/settings", headers=headers("local-admin", shared)).json()
    assert other["important_by_default"] is False and other["highlight_important"] is False
    partner = client.get("/api/settings", headers=headers(profile=shared)).json()
    assert partner["important_by_default"] is True and partner["highlight_important"] is False
    client.patch(
        "/api/settings", headers=headers(profile=shared), json={"highlight_important": True}
    )
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()[
            "highlight_important"
        ]
        is False
    )
    assert (
        client.get("/api/settings", headers=headers("local-admin", personal)).json()[
            "highlight_important"
        ]
        is True
    )


def test_personal_marks_survive_reload_and_do_not_modify_shared_events(client, db):
    _, shared = setup_shared(client)
    created = event(client, "Shared appointment", shared).json()
    partner = headers(profile=shared)
    before = client.get(f"/api/events/{created['id']}", headers=partner).json()
    result = client.patch(
        f"/api/events/{created['id']}/importance", headers=partner, json={"important": False}
    )
    assert result.status_code == 200 and result.json()["important"] is False
    assert (
        client.get(f"/api/events/{created['id']}", headers=headers("local-admin", shared)).json()[
            "important"
        ]
        is True
    )
    device = TestClient(app)
    try:
        saved = device.get(f"/api/events/{created['id']}", headers=partner).json()
        assert saved["important"] is False
        assert {k: v for k, v in saved.items() if k != "important"} == {
            k: v for k, v in before.items() if k != "important"
        }
    finally:
        device.close()


def test_default_changes_only_affect_new_or_previously_unseen_marks(client):
    _, shared = setup_shared(client)
    partner = headers(profile=shared)
    client.patch("/api/settings", headers=partner, json={"important_by_default": False})
    first = event(client, "First", shared).json()
    assert client.get(f"/api/events/{first['id']}", headers=partner).json()["important"] is False
    client.patch("/api/settings", headers=partner, json={"important_by_default": True})
    assert client.get(f"/api/events/{first['id']}", headers=partner).json()["important"] is False
    second = event(client, "Second", shared).json()
    assert client.get(f"/api/events/{second['id']}", headers=partner).json()["important"] is True
    client.patch("/api/settings", json={"important_by_default": False})
    created = event(client, "Default off").json()
    assert created["important"] is False


def test_explicit_marks_and_series_marks_are_kept_when_events_are_edited(client):
    result = client.post(
        "/api/events",
        json={
            "calendar_id": 1,
            "title": "Weekly",
            "start_at": "2026-10-22T10:00:00Z",
            "end_at": "2026-10-22T11:00:00Z",
            "recurrence_rule": "FREQ=WEEKLY;COUNT=3",
            "important": False,
        },
    )
    assert result.status_code == 201
    original = result.json()
    listed = client.get(
        "/api/events", params={"start": "2026-10-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"}
    ).json()
    assert len(listed) == 3 and all(not row["important"] for row in listed)
    client.patch(f"/api/events/{original['id']}", json={"title": "Edited"})
    assert client.get(f"/api/events/{original['id']}").json()["important"] is False
    client.patch(f"/api/events/{original['id']}/importance", json={"important": True})
    assert all(
        row["important"]
        for row in client.get(
            "/api/events", params={"start": "2026-10-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"}
        ).json()
    )


def test_read_only_events_can_be_marked_without_queuing_provider_edits(client, db, setup):
    cal = setup["readonly"]
    row = Event(
        calendar_id=cal.id,
        title="Holiday",
        start_at=datetime(2026, 10, 22, 10),
        end_at=datetime(2026, 10, 22, 11),
        google_event_id="holiday",
        origin="google",
        sync_state="synced",
    )
    db.add(row)
    db.commit()
    updated_at = row.local_updated_at
    result = client.patch(f"/api/events/{row.id}/importance", json={"important": False})
    assert result.status_code == 200 and result.json()["important"] is False
    assert result.json()["editable"] is False
    db.expire_all()
    assert db.get(Event, row.id).sync_state == "synced"
    assert db.get(Event, row.id).local_updated_at == updated_at
    assert client.patch(f"/api/events/{row.id}", json={"title": "Forbidden"}).status_code == 403


def test_marks_survive_google_push_and_remote_row_replacement(client, db, setup, fake):
    created = client.post(
        "/api/events",
        json={
            "calendar_id": setup["cal"].id,
            "title": "Appointment",
            "start_at": "2026-10-22T10:00:00Z",
            "end_at": "2026-10-22T11:00:00Z",
            "important": False,
        },
    ).json()
    profile_id = client.get("/api/session").json()["default_profile_id"]
    with RegistrySession() as registry:
        scope = scope_for(registry.get(Profile, profile_id))
    with profile_context(scope):
        assert sync_engine.push_pending(db) == 1
    assert client.get(f"/api/events/{created['id']}").json()["important"] is False
    old = db.get(Event, created["id"])
    remote_id, calendar_id = old.remote_id, old.calendar_id
    db.delete(old)
    db.commit()
    new = Event(
        calendar_id=calendar_id,
        title="From remote",
        start_at=datetime(2026, 10, 22, 10),
        end_at=datetime(2026, 10, 22, 11),
        google_event_id=remote_id,
        origin="google",
        sync_state="synced",
    )
    db.add(new)
    db.commit()
    assert client.get(f"/api/events/{new.id}").json()["important"] is False


@pytest.mark.parametrize("key", ["important_by_default", "highlight_important"])
@pytest.mark.parametrize("value", [None, 1, "true", []])
def test_personal_boolean_preferences_reject_invalid_values(client, key, value):
    result = client.patch("/api/settings", json={key: value, "day_start_hour": 3})
    assert result.status_code == 400
    assert client.get("/api/settings").json()["day_start_hour"] != 3


def test_marks_follow_calendar_moves_for_every_person(client):
    _, shared = setup_shared(client)
    original = event(client, "Move me", shared).json()
    selected = headers("local-admin", shared)
    partner = headers(profile=shared)
    client.patch(
        f"/api/events/{original['id']}/importance", headers=partner, json={"important": False}
    )
    target = client.post("/api/calendars", headers=selected, json={"name": "Other"}).json()
    moved = client.patch(
        f"/api/events/{original['id']}", headers=selected, json={"calendar_id": target["id"]}
    )
    assert moved.status_code == 200 and moved.json()["important"] is True
    assert (
        client.get(f"/api/events/{moved.json()['id']}", headers=partner).json()["important"]
        is False
    )


def test_a_new_event_does_not_inherit_a_deleted_events_personal_mark(client):
    first = event(client, "Old").json()
    client.patch(f"/api/events/{first['id']}/importance", json={"important": False})
    client.delete(f"/api/events/{first['id']}")
    assert event(client, "New").json()["important"] is True

from datetime import datetime

import pytest
from fake_google import FakeGoogle, gevent

from app.models import Calendar, EventDeletion, LinkedAccount, User
from app.services import sync_engine
from app.services.providers.google import GoogleProvider

WINDOW = {
    "start": "2026-10-01T00:00:00Z",
    "end": "2026-12-01T00:00:00Z",
    "timezone": "Europe/Ljubljana",
}


def listed(client):
    return client.get("/api/events", params=WINDOW).json()


def create_series(client, calendar=1, **changes):
    response = client.post(
        "/api/events",
        json={
            "calendar_id": calendar,
            "title": "Weekly",
            "start_at": "2026-10-21T12:00:00Z",
            "end_at": "2026-10-21T13:00:00Z",
            "timezone": "Europe/Ljubljana",
            "recurrence_rule": "FREQ=WEEKLY;COUNT=4",
            **changes,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.mark.parametrize(
    "scope,days", [("this", ["21", "04", "11"]), ("future", ["21"]), ("all", [])]
)
def test_local_deletion_scope_keeps_the_intended_occurrences_across_dst(client, scope, days):
    event_id = create_series(client)
    assert (
        client.delete(
            f"/api/events/{event_id}",
            params={
                "scope": scope,
                "occurrence_start": "2026-10-28T13:00:00Z",
            },
        ).status_code
        == 204
    )
    assert [event["start_at"][8:10] for event in listed(client)] == days
    # A fresh query repeats exactly the same result, without resurrecting the deleted dates.
    assert [event["start_at"][8:10] for event in listed(client)] == days


@pytest.mark.parametrize("scope,count", [("this", 3), ("future", 1), ("all", 0)])
def test_all_day_deletion_uses_original_dates_without_timezone_conversion(client, scope, count):
    event_id = create_series(
        client,
        all_day=True,
        timezone=None,
        recurrence_rule="FREQ=DAILY;COUNT=4",
        start_at="2026-10-21T00:00:00Z",
        end_at="2026-10-22T00:00:00Z",
    )
    assert (
        client.delete(
            f"/api/events/{event_id}",
            params={
                "scope": scope,
                "occurrence_start": "2026-10-22T00:00:00Z",
                "timezone": "America/Los_Angeles",
            },
        ).status_code
        == 204
    )
    events = listed(client)
    assert len(events) == count
    assert all(event["start_at"].endswith("T00:00:00Z") for event in events)


def test_future_from_first_occurrence_removes_the_whole_series(client):
    event_id = create_series(client)
    assert (
        client.delete(
            f"/api/events/{event_id}",
            params={
                "scope": "future",
                "occurrence_start": "2026-10-21T12:00:00Z",
            },
        ).status_code
        == 204
    )
    assert listed(client) == []


def test_partial_deletion_requires_a_real_occurrence_and_keeps_other_series(client):
    event_id = create_series(client)
    create_series(client, title="Another series")
    assert client.delete(f"/api/events/{event_id}?scope=this").status_code == 400
    assert (
        client.delete(
            f"/api/events/{event_id}",
            params={
                "scope": "future",
                "occurrence_start": "2026-10-22T12:00:00Z",
            },
        ).status_code
        == 400
    )
    assert len(listed(client)) == 8
    client.delete(f"/api/events/{event_id}?scope=all")
    assert len(listed(client)) == 4


def test_single_cancellation_is_present_in_subscription_feed(client):
    event_id = create_series(client)
    client.delete(
        f"/api/events/{event_id}",
        params={
            "scope": "this",
            "occurrence_start": "2026-10-28T13:00:00Z",
        },
    )
    feed = client.get(client.get("/api/feeds/token").json()["all_calendars_url"])
    assert "EXDATE:20261028T130000Z" in feed.text


@pytest.fixture
def google(client, db, monkeypatch):
    fake = FakeGoogle()
    monkeypatch.setattr(sync_engine, "provider_factory", lambda *_: GoogleProvider(client=fake))
    user = User(name="Owner", color="#123456")
    db.add(user)
    db.flush()
    account = LinkedAccount(user_id=user.id, provider="google", email="test@example.test")
    db.add(account)
    db.flush()
    calendar = Calendar(
        linked_account_id=account.id,
        google_calendar_id="calendar",
        name="Google",
        claimed_by_user_id=user.id,
        sync_enabled=True,
        access_role="owner",
    )
    db.add(calendar)
    db.commit()
    fake.events["series"] = gevent(
        "series",
        "Weekly",
        "2026-10-21T12:00:00Z",
        "2026-10-21T13:00:00Z",
        recurrence=["RRULE:FREQ=WEEKLY;COUNT=4"],
        attendees=[{"email": "guest@example.test"}],
    )
    instances = []
    for index, start in enumerate(
        [
            "2026-10-21T12:00:00Z",
            "2026-10-28T13:00:00Z",
            "2026-11-04T13:00:00Z",
            "2026-11-11T13:00:00Z",
        ]
    ):
        item = gevent(
            f"instance{index}",
            "Weekly",
            start,
            start.replace("12:00", "13:00") if index == 0 else start.replace("13:00", "14:00"),
            recurringEventId="series",
            originalStartTime={"dateTime": start},
        )
        instances.append(item)
        fake.events[item["id"]] = item
    fake.pages = [(instances, "cursor")]
    sync_engine.pull_calendar(db, calendar)
    return fake, calendar, instances


@pytest.mark.parametrize(
    "scope,days", [("this", ["21", "04", "11"]), ("future", ["21"]), ("all", [])]
)
def test_google_scopes_are_queued_and_write_the_correct_remote_resource(
    client, db, google, scope, days
):
    fake, calendar, _ = google
    selected = listed(client)[1]
    assert selected["original_start_at"] == "2026-10-28T13:00:00Z"
    assert (
        client.delete(
            f"/api/events/{selected['id']}",
            params={
                "scope": scope,
                "occurrence_start": selected["original_start_at"],
            },
        ).status_code
        == 204
    )
    assert [event["start_at"][8:10] for event in listed(client)] == days
    db.expire_all()
    assert sync_engine.push_pending(db) == 1
    if scope == "this":
        assert fake.deleted == ["instance1"]
    elif scope == "all":
        assert fake.deleted == ["series"]
    else:
        assert fake.patched == [
            ("series", {"recurrence": ["RRULE:FREQ=WEEKLY;UNTIL=20261028T125959Z"]})
        ]
    assert fake.events["series"]["attendees"] == [{"email": "guest@example.test"}]


def test_failed_google_deletion_is_retried_and_old_pulls_cannot_resurrect_it(client, db, google):
    fake, calendar, instances = google
    selected = listed(client)[1]
    client.delete(f"/api/events/{selected['id']}", params={"scope": "future"})
    db.expire_all()
    fake.fail_patch_with = 503
    assert sync_engine.push_pending(db) == 0
    fake.pages = [(instances, "old-cursor")]
    sync_engine.pull_calendar(db, calendar)
    assert len(listed(client)) == 1
    assert client.get("/api/sync/status").json()["pending_pushes"] == 1
    assert sync_engine.push_pending(db) == 1
    # An already-running pull is not allowed to acknowledge this write.
    from app.services.event_deletions import acknowledge

    acknowledge(db, calendar.id, datetime(2000, 1, 1))
    assert db.query(EventDeletion).count() == 1
    fake.pages = [([instances[0]], "fresh-cursor")]
    sync_engine.pull_calendar(db, calendar)
    assert db.query(EventDeletion).count() == 0
    assert len(listed(client)) == 1


def test_future_deletion_uses_original_slot_of_a_moved_google_occurrence(client, db, google):
    fake, calendar, instances = google
    instances[0]["start"] = {"dateTime": "2026-11-15T12:00:00Z"}
    instances[0]["end"] = {"dateTime": "2026-11-15T13:00:00Z"}
    instances[1]["start"] = {"dateTime": "2026-10-22T12:00:00Z"}
    instances[1]["end"] = {"dateTime": "2026-10-22T13:00:00Z"}
    fake.pages = [(instances, "moved")]
    sync_engine.pull_calendar(db, calendar)
    selected = next(event for event in listed(client) if event["start_at"].startswith("2026-10-22"))
    client.delete(
        f"/api/events/{selected['id']}",
        params={"scope": "future", "occurrence_start": selected["original_start_at"]},
    )
    assert [event["start_at"] for event in listed(client)] == ["2026-11-15T12:00:00Z"]
    db.expire_all()
    assert sync_engine.push_pending(db) == 1
    assert "UNTIL=20261028T125959Z" in fake.patched[0][1]["recurrence"][0]


def test_cancellation_before_first_google_push_is_applied_after_creation(client, db, google):
    fake, calendar, _ = google
    event_id = create_series(client, calendar.id)
    client.delete(
        f"/api/events/{event_id}",
        params={"scope": "this", "occurrence_start": "2026-10-28T13:00:00Z"},
    )
    db.expire_all()
    assert sync_engine.push_pending(db) == 2
    assert fake.patched[-1][1]["recurrence"][-1] == "EXDATE:20261028T130000Z"


def test_legacy_google_moved_occurrence_is_resolved_before_pruning_history(client, db, google):
    from app.models import Event

    fake, calendar, instances = google
    instances[1]["start"] = {"dateTime": "2026-10-22T12:00:00Z"}
    instances[1]["end"] = {"dateTime": "2026-10-22T13:00:00Z"}
    fake.pages = [(instances, "moved")]
    sync_engine.pull_calendar(db, calendar)
    db.query(Event).filter(Event.google_event_id == "instance1").update({"original_start_at": None})
    db.commit()
    selected = next(event for event in listed(client) if event["start_at"].startswith("2026-10-22"))
    assert (
        client.delete(
            f"/api/events/{selected['id']}",
            params={
                "scope": "future",
                "occurrence_start": selected["original_start_at"],
            },
        ).status_code
        == 204
    )
    assert [event["start_at"] for event in listed(client)] == ["2026-10-21T12:00:00Z"]
    db.expire_all()
    assert sync_engine.push_pending(db) == 1
    assert "UNTIL=20261028T125959Z" in fake.patched[0][1]["recurrence"][0]


def test_google_future_deletion_keeps_only_past_extra_dates_and_preserves_their_timezone(
    client, db, google
):
    fake, _, _ = google
    fake.events["series"]["recurrence"].append(
        "RDATE;TZID=Europe/Ljubljana:20261020T140000,20261115T140000"
    )
    selected = listed(client)[1]
    client.delete(f"/api/events/{selected['id']}?scope=future")
    db.expire_all()
    sync_engine.push_pending(db)
    assert fake.patched[0][1]["recurrence"][-1] == "RDATE;TZID=Europe/Ljubljana:20261020T140000"


def test_deleting_unsynced_series_clears_its_queued_single_cancellation(client, db, google):
    _, calendar, _ = google
    event_id = create_series(client, calendar.id)
    client.delete(
        f"/api/events/{event_id}",
        params={"scope": "this", "occurrence_start": "2026-10-28T13:00:00Z"},
    )
    assert client.delete(f"/api/events/{event_id}?scope=all").status_code == 204
    db.expire_all()
    assert sync_engine.push_pending(db) == 0
    assert db.query(EventDeletion).count() == 0


def test_readonly_recurring_calendars_refuse_every_deletion_scope(client, db, google):
    _, calendar, _ = google
    selected = listed(client)[1]
    calendar.access_role = "reader"
    db.commit()
    for scope in ("this", "all", "future"):
        assert client.delete(f"/api/events/{selected['id']}?scope={scope}").status_code == 403
    assert len(listed(client)) == 4

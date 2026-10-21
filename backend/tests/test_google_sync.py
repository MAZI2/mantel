from datetime import datetime, timedelta

import pytest
from fake_google import FakeGoogle, gallday, gevent

from app.models import Calendar, Event, LinkedAccount, User
from app.services import sync_engine as google_sync
from app.services.crypto import encrypt
from app.services.providers.google import GoogleProvider


@pytest.fixture
def fake(monkeypatch):
    """The fake stands in for Google's HTTP API, below the provider boundary, so the
    JSON translation in GoogleProvider is exercised too rather than bypassed."""
    f = FakeGoogle()
    monkeypatch.setattr(
        google_sync, "provider_factory", lambda db, account: GoogleProvider(client=f)
    )
    return f


@pytest.fixture
def gcal(client, db, fake):
    user = User(name="Mike", color="#3b82f6")
    db.add(user)
    db.flush()
    account = LinkedAccount(
        user_id=user.id,
        provider="google",
        email="mike@example.com",
        access_token_enc=encrypt("at"),
        refresh_token_enc=encrypt("rt"),
        token_expiry=datetime.utcnow() + timedelta(hours=1),
    )
    db.add(account)
    db.flush()
    cal = Calendar(
        linked_account_id=account.id,
        google_calendar_id="primary",
        name="Mike Google",
        claimed_by_user_id=user.id,
        sync_enabled=True,
        access_role="owner",
    )
    db.add(cal)
    db.commit()
    return cal


# ------------------------------ discovery ------------------------------------


def test_discover_calendars_starts_unclaimed_and_not_syncing(client, db, fake, gcal):
    fake.calendars = [
        {"id": "work@group.calendar.google.com", "summary": "Work", "accessRole": "owner"},
        {"id": "holidays", "summary": "Holidays", "accessRole": "reader"},
    ]
    account = db.get(LinkedAccount, gcal.linked_account_id)
    found = google_sync.discover_calendars(db, account)

    assert {c.name for c in found} == {"Work", "Holidays"}
    for c in found:
        assert c.claimed_by_user_id is None, "nothing shows up until a person claims it"
        assert c.sync_enabled is False
    holidays = next(c for c in found if c.name == "Holidays")
    assert holidays.writable is False, "reader access must be read-only"


def test_discover_is_idempotent_and_updates_names(client, db, fake, gcal):
    account = db.get(LinkedAccount, gcal.linked_account_id)
    fake.calendars = [{"id": "work", "summary": "Work", "accessRole": "owner"}]
    google_sync.discover_calendars(db, account)
    fake.calendars = [{"id": "work", "summary": "Work Stuff", "accessRole": "writer"}]
    second = google_sync.discover_calendars(db, account)

    work = [c for c in second if c.google_calendar_id == "work"]
    assert len(work) == 1, "re-running discovery must not duplicate calendars"
    assert work[0].name == "Work Stuff"
    assert work[0].access_role == "writer"


# -------------------------------- pull ---------------------------------------


def test_initial_pull_imports_events(client, db, fake, gcal):
    fake.pages = [
        (
            [
                gevent("g1", "Standup", "2026-07-30T13:00:00Z", "2026-07-30T13:30:00Z"),
                gevent("g2", "Dentist", "2026-07-31T14:00:00Z", "2026-07-31T15:00:00Z"),
            ],
            "sync-token-1",
        )
    ]
    assert google_sync.pull_calendar(db, gcal) == 2

    db.refresh(gcal)
    assert gcal.sync_token == "sync-token-1"
    assert gcal.last_synced_at is not None
    events = db.query(Event).order_by(Event.start_at).all()
    assert [e.title for e in events] == ["Standup", "Dentist"]
    assert all(e.origin == "google" and e.sync_state == "synced" for e in events)


def test_initial_pull_uses_time_min_not_sync_token(client, db, fake, gcal):
    fake.pages = [([], "t1")]
    google_sync.pull_calendar(db, gcal)
    assert fake.last_sync_token is None
    assert fake.last_time_min is not None, "first pull must bound how far back it imports"


def test_incremental_pull_sends_stored_sync_token(client, db, fake, gcal):
    fake.pages = [([], "t1"), ([], "t2")]
    google_sync.pull_calendar(db, gcal)
    google_sync.pull_calendar(db, gcal)
    assert fake.last_sync_token == "t1"
    db.refresh(gcal)
    assert gcal.sync_token == "t2"


@pytest.mark.parametrize("kind", ["timed", "all-day", "recurring"])
def test_google_event_colours_are_displayed_and_follow_remote_changes(
    client, db, fake, gcal, kind,
):
    def remote(colour=None):
        if kind == "all-day":
            item = gallday("g1", "Coloured", "2026-08-03", "2026-08-04")
        else:
            item = gevent("g1", "Coloured", "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z")
        if kind == "recurring":
            item["recurringEventId"] = "series"
        if colour is not None:
            item["colorId"] = colour
        return item

    params = {"start": "2026-08-01T00:00:00Z", "end": "2026-08-10T00:00:00Z"}
    for colour, expected in [("5", "#fbd75b"), ("11", "#dc2127"), (None, "#3b82f6")]:
        fake.pages = [([remote(colour)], "next")]
        google_sync.pull_calendar(db, gcal)
        event = client.get("/api/events", params=params).json()[0]
        assert event["color"] == expected
        assert event["remote_color"] == (expected if colour else None)
        assert event["color_override"] is None


def test_local_colour_wins_but_resetting_it_restores_the_latest_google_colour(
    client, db, fake, gcal,
):
    def remote(colour):
        return gevent("g1", "Coloured", "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z",
                      colorId=colour)

    fake.pages = [([remote("5")], "t1")]
    google_sync.pull_calendar(db, gcal)
    event = db.query(Event).one()
    event.color_override = "#ec4899"
    db.commit()
    fake.pages = [([remote("11")], "t2")]
    google_sync.pull_calendar(db, gcal)
    shown = client.get(f"/api/events/{event.id}").json()
    assert shown["color"] == "#ec4899"
    assert shown["remote_color"] == "#dc2127"
    reset = client.patch(f"/api/events/{event.id}", json={"color_override": None}).json()
    assert reset["color"] == "#dc2127"


def test_unknown_google_colour_falls_back_to_the_calendar_colour(client, db, fake, gcal):
    fake.pages = [([gevent(
        "g1", "Future colour", "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z",
        colorId="unknown",
    )], "t1")]
    google_sync.pull_calendar(db, gcal)
    event = db.query(Event).one()
    assert client.get(f"/api/events/{event.id}").json()["color"] == "#3b82f6"


def test_upgrade_backfills_existing_colours_once_and_keeps_deletions_and_local_edits(
    client, db, fake, gcal,
):
    def remote(gid, colour=None, title="From Google"):
        item = gevent(gid, title, "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z")
        if colour:
            item["colorId"] = colour
        return item

    fake.pages = [([remote("g1"), remote("removed"), remote("editing")], "old")]
    google_sync.pull_calendar(db, gcal)
    original = db.query(Event).filter_by(google_event_id="g1").one()
    original.color_override = "#ec4899"
    editing = db.query(Event).filter_by(google_event_id="editing").one()
    editing.title = "Pending local edit"
    editing.sync_state = "pending_update"
    gcal.remote_colors_synced = None  # database upgraded from before colour import
    db.commit()
    fake.pages = [
        ([remote("g1", "5"), remote("removed", "5"), remote("editing", "5")], "snapshot"),
        ([{"id": "removed", "status": "cancelled"}], "latest"),
    ]
    google_sync.pull_calendar(db, gcal)
    db.refresh(original)
    db.refresh(editing)
    assert original.remote_color == "#fbd75b"
    assert original.color_override == "#ec4899"
    assert editing.title == "Pending local edit"
    assert editing.sync_state == "pending_update"
    assert db.query(Event).filter_by(google_event_id="removed").count() == 0
    assert gcal.sync_token == "latest"
    assert gcal.remote_colors_synced is True
    fake.pages = [([], "next")]
    google_sync.pull_calendar(db, gcal)
    assert fake.last_sync_token == "latest", "only the first upgraded sync needs a snapshot"


def test_incremental_pull_updates_existing_event(client, db, fake, gcal):
    fake.pages = [
        ([gevent("g1", "Standup", "2026-07-30T13:00:00Z", "2026-07-30T13:30:00Z")], "t1"),
        ([gevent("g1", "Standup moved", "2026-07-30T15:00:00Z", "2026-07-30T15:30:00Z")], "t2"),
    ]
    google_sync.pull_calendar(db, gcal)
    google_sync.pull_calendar(db, gcal)

    events = db.query(Event).all()
    assert len(events) == 1, "the same Google id must update, not duplicate"
    assert events[0].title == "Standup moved"
    assert events[0].start_at.hour == 15


def test_cancelled_event_is_removed(client, db, fake, gcal):
    fake.pages = [
        ([gevent("g1", "Standup", "2026-07-30T13:00:00Z", "2026-07-30T13:30:00Z")], "t1"),
        ([{"id": "g1", "status": "cancelled"}], "t2"),
    ]
    google_sync.pull_calendar(db, gcal)
    google_sync.pull_calendar(db, gcal)
    assert db.query(Event).count() == 0


def test_expired_sync_token_triggers_full_resync(client, db, fake, gcal):
    fake.pages = [([gevent("g1", "Old", "2026-07-30T13:00:00Z", "2026-07-30T13:30:00Z")], "t1")]
    google_sync.pull_calendar(db, gcal)

    fake.expire_next_sync_token = True
    fake.pages = [([gevent("g2", "Fresh", "2026-08-01T13:00:00Z", "2026-08-01T14:00:00Z")], "t9")]
    google_sync.pull_calendar(db, gcal)

    titles = [e.title for e in db.query(Event).all()]
    assert titles == ["Fresh"], "stale Google events must be cleared on a full resync"
    db.refresh(gcal)
    assert gcal.sync_token == "t9"


def test_full_resync_keeps_unpushed_local_events(client, db, fake, gcal):
    local = Event(
        calendar_id=gcal.id,
        title="Not yet in Google",
        start_at=datetime(2026, 8, 1, 12, 0),
        end_at=datetime(2026, 8, 1, 13, 0),
        origin="local",
        sync_state="pending_create",
    )
    db.add(local)
    db.commit()

    fake.pages = [([], "t1")]
    google_sync.pull_calendar(db, gcal)
    fake.expire_next_sync_token = True
    fake.pages = [([], "t2")]
    google_sync.pull_calendar(db, gcal)

    assert db.query(Event).filter_by(title="Not yet in Google").count() == 1


def test_all_day_event_keeps_its_dates(client, db, fake, gcal):
    fake.pages = [([gallday("g1", "Beach trip", "2026-08-01", "2026-08-03")], "t1")]
    google_sync.pull_calendar(db, gcal)

    ev = db.query(Event).one()
    assert ev.all_day is True
    assert ev.start_at.date().isoformat() == "2026-08-01"
    assert ev.end_at.date().isoformat() == "2026-08-03"


def test_recurring_instances_are_flagged(client, db, fake, gcal):
    fake.pages = [
        (
            [
                gevent(
                    "g1_20260803",
                    "Weekly sync",
                    "2026-08-03T13:00:00Z",
                    "2026-08-03T13:30:00Z",
                    recurringEventId="g1",
                )
            ],
            "t1",
        )
    ]
    google_sync.pull_calendar(db, gcal)
    assert db.query(Event).one().recurring_event_id == "g1"


@pytest.mark.parametrize("full_resync", [False, True])
def test_remote_updates_keep_individual_event_colours(client, db, fake, gcal, full_resync):
    def remote(title):
        return gevent("g1", title, "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z")

    fake.pages = [([remote("Original")], "t1")]
    google_sync.pull_calendar(db, gcal)
    event = db.query(Event).one()
    event.color_override = "#ec4899"
    db.commit()
    fake.expire_next_sync_token = full_resync
    fake.pages = [([remote("Changed on phone")], "t2")]
    google_sync.pull_calendar(db, gcal)
    events = client.get("/api/events", params={
        "start": "2026-08-01T00:00:00Z", "end": "2026-08-10T00:00:00Z",
    }).json()
    assert len(events) == 1
    assert events[0]["title"] == "Changed on phone"
    assert events[0]["color"] == events[0]["color_override"] == "#ec4899"


def test_google_instances_inherit_the_series_colour_and_allow_individual_overrides(
    client, db, fake, gcal,
):
    master = client.post("/api/events", json={
        "calendar_id": gcal.id, "title": "Weekly",
        "start_at": "2026-08-03T13:00:00Z", "end_at": "2026-08-03T14:00:00Z",
        "recurrence_rule": "FREQ=WEEKLY;COUNT=2", "color_override": "#ec4899",
    }).json()
    google_sync.push_pending(db)
    fake.pages = [([
        gevent("g1_1", "Weekly", "2026-08-03T13:00:00Z", "2026-08-03T14:00:00Z",
               recurringEventId="g1"),
        gevent("g1_2", "Weekly", "2026-08-10T13:00:00Z", "2026-08-10T14:00:00Z",
               recurringEventId="g1"),
    ], "t1")]
    google_sync.pull_calendar(db, gcal)
    params = {"start": "2026-08-01T00:00:00Z", "end": "2026-09-01T00:00:00Z"}
    events = client.get("/api/events", params=params).json()
    assert len(events) == 2
    assert all(event["color"] == "#ec4899" for event in events)
    first_id = events[0]["id"]
    assert client.get(f"/api/events/{first_id}").json()["color"] == "#ec4899"
    assert client.patch(f"/api/events/{first_id}", json={"color_override": "#22c55e"}).json()[
        "color"
    ] == "#22c55e"
    client.patch(f"/api/events/{master['id']}", json={"color_override": "#eab308"})
    events = client.get("/api/events", params=params).json()
    assert [event["color"] for event in events] == ["#22c55e", "#eab308"]


def test_disabled_calendar_is_not_pulled(client, db, fake, gcal):
    gcal.sync_enabled = False
    db.commit()
    fake.pages = [([gevent("g1", "X", "2026-07-30T13:00:00Z", "2026-07-30T14:00:00Z")], "t1")]
    assert google_sync.pull_calendar(db, gcal) == 0
    assert db.query(Event).count() == 0


def test_pull_all_records_error_without_crashing(client, db, fake, gcal, monkeypatch):
    from app.services.google_api import GoogleApiError

    def boom(*args, **kwargs):
        raise GoogleApiError(500, "Google is down")

    monkeypatch.setattr(fake, "list_events", boom)
    assert google_sync.pull_all(db) == 0
    db.refresh(gcal)
    assert "Google is down" in gcal.sync_error


# ------------------------- events surfaced via the API -----------------------


def test_pulled_events_appear_in_the_events_api_with_owner_color(client, db, fake, gcal):
    fake.pages = [([gevent("g1", "Standup", "2026-07-30T13:00:00Z", "2026-07-30T13:30:00Z")], "t1")]
    google_sync.pull_calendar(db, gcal)

    r = client.get(
        "/api/events", params={"start": "2026-07-30T00:00:00Z", "end": "2026-07-31T00:00:00Z"}
    )
    body = r.json()
    assert len(body) == 1
    assert body[0]["title"] == "Standup"
    assert body[0]["origin"] == "google"
    assert body[0]["color"] == "#3b82f6"


# ------------------- discovery on every sync (not just at link) --------------


def test_sync_run_picks_up_a_calendar_added_after_linking(client, db, fake, gcal):
    """The reason this exists: discovery used to run only when an account was
    linked, so a calendar created in Google afterwards never appeared and the
    only fix was to unlink and reconnect."""
    fake.calendars = [{"id": "primary", "summary": "Mike Google", "accessRole": "owner"}]
    assert client.post("/api/sync/run").json()["new_calendars"] == 0

    # ...somebody adds a calendar in Google.
    fake.calendars.append(
        {"id": "soccer@group.calendar.google.com", "summary": "Soccer", "accessRole": "writer"}
    )

    body = client.post("/api/sync/run").json()
    assert body["new_calendars"] == 1

    names = [c["name"] for c in client.get("/api/calendars").json()]
    assert "Soccer" in names

    # A second run must not report it again.
    assert client.post("/api/sync/run").json()["new_calendars"] == 0


def test_discover_endpoint_reports_new_and_total(client, db, fake, gcal):
    fake.calendars = [
        {"id": "primary", "summary": "Mike Google", "accessRole": "owner"},
        {"id": "book-club", "summary": "Book club", "accessRole": "reader"},
    ]
    body = client.post("/api/sync/calendars").json()

    assert body["new_calendars"] == 1  # `primary` already existed from the fixture
    assert body["total_calendars"] == 2


def test_a_newly_found_calendar_does_not_start_syncing(client, db, fake, gcal):
    """Nothing may appear on the wall display because a calendar showed up in
    Google -- somebody has to switch it on."""
    fake.calendars = [
        {"id": "primary", "summary": "Mike Google", "accessRole": "owner"},
        {"id": "gym", "summary": "Gym", "accessRole": "reader"},
    ]
    client.post("/api/sync/calendars")

    gym = next(c for c in client.get("/api/calendars").json() if c["name"] == "Gym")
    assert gym["sync_enabled"] is False
    assert gym["claimed_by_user_id"] is None


def test_one_broken_account_does_not_stop_discovery_for_the_others(db, fake, gcal, monkeypatch):
    """An expired token on one account must not hide another account's new calendars."""
    from app.services.google_api import GoogleApiError

    calls = {"n": 0}
    real = google_sync.discover_calendars

    def flaky(session, account):
        calls["n"] += 1
        if calls["n"] == 1:
            raise GoogleApiError(403, "token expired")
        return real(session, account)

    account = db.get(LinkedAccount, gcal.linked_account_id)
    second = LinkedAccount(
        user_id=account.user_id,
        provider="google",
        email="other@example.com",
        access_token_enc=account.access_token_enc,
        refresh_token_enc=account.refresh_token_enc,
        token_expiry=account.token_expiry,
    )
    db.add(second)
    db.commit()

    fake.calendars = [{"id": "shared", "summary": "Shared", "accessRole": "reader"}]
    monkeypatch.setattr(google_sync, "discover_calendars", flaky)

    assert google_sync.discover_all(db) == 1
    assert calls["n"] == 2

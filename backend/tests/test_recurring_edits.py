import pytest

from app.services import sync_engine
from tests.test_recurring_deletion import create_series, listed
from tests.test_recurring_deletion import google as _google_fixture


@pytest.mark.parametrize(
    "scope,titles",
    [
        ("this", ["Weekly", "Changed", "Weekly", "Weekly"]),
        ("future", ["Weekly", "Changed", "Changed", "Changed"]),
        ("all", ["Changed"] * 4),
    ],
)
def test_scoped_edits_preserve_history_count_and_wall_clock_across_dst(client, scope, titles):
    event_id = create_series(client)
    other = client.post(
        "/api/events",
        json=dict(
            calendar_id=1,
            title="Unrelated",
            start_at="2026-10-22T10:00:00Z",
            end_at="2026-10-22T11:00:00Z",
        ),
    ).json()
    result = client.patch(
        f"/api/events/{event_id}",
        json=dict(
            edit_scope=scope,
            occurrence_start="2026-10-28T13:00:00Z",
            title="Changed",
            start_at="2026-10-28T14:00:00Z",
            end_at="2026-10-28T16:00:00Z",
        ),
    )
    assert result.status_code == 200, result.text
    rows = [e for e in listed(client) if e["title"] != "Unrelated"]
    assert [e["title"] for e in rows] == titles
    from datetime import datetime
    from zoneinfo import ZoneInfo

    for row in rows:
        start = datetime.fromisoformat(row["start_at"]).astimezone(ZoneInfo("Europe/Ljubljana"))
        assert start.hour == (15 if row["title"] == "Changed" else 14)
    assert client.get(f"/api/events/{other['id']}").status_code == 200
    assert len(listed(client)) == 5


def test_invalid_edit_never_excludes_or_truncates_the_original_series(client):
    event_id = create_series(client)
    for patch in [
        dict(occurrence_start="2026-10-29T13:00:00Z"),
        dict(start_at="2026-10-28T15:00:00Z", end_at="2026-10-28T14:00:00Z"),
    ]:
        result = client.patch(
            f"/api/events/{event_id}",
            json={"edit_scope": "future", "occurrence_start": "2026-10-28T13:00:00Z", **patch},
        )
        assert result.status_code == 400, result.text
        assert len(listed(client)) == 4


def test_edit_first_and_future_keeps_a_finite_series_finite(client):
    event_id = create_series(client)
    result = client.patch(
        f"/api/events/{event_id}",
        json=dict(edit_scope="future", occurrence_start="2026-10-21T12:00:00Z", title="New start"),
    )
    assert result.status_code == 200, result.text
    assert len(listed(client)) == 4
    assert all(e["title"] == "New start" for e in listed(client))


google = pytest.fixture(_google_fixture.__wrapped__)


@pytest.mark.parametrize("scope", ["this", "future", "all"])
def test_google_edits_load_the_master_and_queue_only_the_requested_scope(client, db, google, scope):
    fake, _, _ = google
    fake.events["series"]["start"]["timeZone"] = "Europe/Ljubljana"
    selected = listed(client)[1]
    context = client.get(f"/api/events/{selected['id']}/edit-context")
    assert context.status_code == 200 and context.json()["recurrence_rule"] == "FREQ=WEEKLY;COUNT=4"
    result = client.patch(
        f"/api/events/{selected['id']}",
        json=dict(
            edit_scope=scope,
            occurrence_start=selected["original_start_at"],
            title="Changed",
            start_at="2026-10-28T14:00:00Z",
            end_at="2026-10-28T15:00:00Z",
        ),
    )
    assert result.status_code == 200, result.text
    db.expire_all()
    assert sync_engine.push_pending(db) == (1 if scope == "all" else 2)
    assert fake.events["series"]["attendees"] == [{"email": "guest@example.test"}]
    if scope == "all":
        assert fake.events["series"]["summary"] == "Changed"
    elif scope == "this":
        assert "instance1" in fake.deleted
        assert "recurrence" not in fake.inserted[-1]["body"]
    else:
        assert "UNTIL=20261028T125959Z" in fake.events["series"]["recurrence"][0]
        assert "COUNT=3" in fake.inserted[-1]["body"]["recurrence"][0]


def test_single_edit_remains_a_series_occurrence_for_later_scoped_edits_and_deletion(client):
    event_id = create_series(client)
    patch = dict(
        edit_scope="this",
        occurrence_start="2026-10-28T13:00:00Z",
        title="Exception",
        start_at="2026-10-28T15:00:00Z",
        end_at="2026-10-28T16:00:00Z",
    )
    first = client.patch(f"/api/events/{event_id}", json=patch)
    assert first.status_code == 200, first.text
    exception = first.json()
    assert exception["recurring"] is True
    assert exception["original_start_at"] == "2026-10-28T13:00:00Z"
    second = client.patch(f"/api/events/{exception['id']}", json={**patch, "title": "Edited twice"})
    assert second.status_code == 200, second.text
    assert len(listed(client)) == 4
    deleted = client.delete(f"/api/events/{event_id}", params={"scope": "all"})
    assert deleted.status_code == 204, deleted.text
    assert listed(client) == []


def test_google_single_edit_then_delete_all_removes_the_replacement_upstream(client, db, google):
    fake, _, _ = google
    selected = listed(client)[1]
    changed = client.patch(
        f"/api/events/{selected['id']}",
        json=dict(
            edit_scope="this", occurrence_start=selected["original_start_at"], title="Exception"
        ),
    )
    assert changed.status_code == 200, changed.text
    db.expire_all()
    assert sync_engine.push_pending(db) == 2
    replacement_remote = fake.inserted[-1]["id"]
    result = client.delete(f"/api/events/{changed.json()['id']}", params={"scope": "all"})
    assert result.status_code == 204, result.text
    db.expire_all()
    assert sync_engine.push_pending(db) == 2
    assert replacement_remote in fake.deleted and "series" in fake.deleted
    assert listed(client) == []


def test_google_turning_off_repeats_clears_the_remote_rule(client, db, google):
    fake, _, _ = google
    selected = listed(client)[1]
    changed = client.patch(
        f"/api/events/{selected['id']}",
        json=dict(
            edit_scope="all", occurrence_start=selected["original_start_at"], recurrence_rule=None
        ),
    )
    assert changed.status_code == 200, changed.text
    db.expire_all()
    assert sync_engine.push_pending(db) == 1
    assert fake.events["series"]["recurrence"] == []


def test_scoped_save_can_still_move_a_whole_local_series_without_dropping_history(client):
    event_id = create_series(client)
    target = client.post("/api/calendars", json={"name": "Another calendar"}).json()
    saved = client.patch(
        f"/api/events/{event_id}",
        json=dict(
            edit_scope="all",
            occurrence_start="2026-10-28T13:00:00Z",
            title="Moved",
            calendar_id=target["id"],
            start_at="2026-10-28T14:00:00Z",
            end_at="2026-10-28T15:00:00Z",
        ),
    )
    assert saved.status_code == 200, saved.text
    rows = listed(client)
    assert len(rows) == 4
    assert all(row["calendar_id"] == target["id"] and row["title"] == "Moved" for row in rows)
    assert rows[0]["start_at"] == "2026-10-21T13:00:00Z"


def test_whole_series_conversion_to_all_day_preserves_dates_across_dst(client):
    event_id = create_series(client)
    saved = client.patch(
        f"/api/events/{event_id}",
        json=dict(
            edit_scope="all",
            occurrence_start="2026-10-28T13:00:00Z",
            all_day=True,
            timezone=None,
            start_at="2026-10-28T00:00:00Z",
            end_at="2026-10-29T00:00:00Z",
        ),
    )
    assert saved.status_code == 200, saved.text
    assert [e["start_at"] for e in listed(client)] == [
        f"2026-{d}T00:00:00Z" for d in ["10-21", "10-28", "11-04", "11-11"]
    ]


def test_whole_all_day_series_conversion_to_timed_uses_the_new_named_zone(client):
    event_id = create_series(
        client,
        all_day=True,
        timezone=None,
        start_at="2026-10-21T00:00:00Z",
        end_at="2026-10-22T00:00:00Z",
    )
    saved = client.patch(
        f"/api/events/{event_id}",
        json=dict(
            edit_scope="all",
            occurrence_start="2026-10-28T00:00:00Z",
            all_day=False,
            timezone="Europe/Ljubljana",
            start_at="2026-10-28T13:00:00Z",
            end_at="2026-10-28T14:00:00Z",
        ),
    )
    assert saved.status_code == 200, saved.text
    assert [e["start_at"] for e in listed(client)] == [
        "2026-10-21T12:00:00Z",
        "2026-10-28T13:00:00Z",
        "2026-11-04T13:00:00Z",
        "2026-11-11T13:00:00Z",
    ]


def test_editor_refreshes_a_cached_google_master_after_external_repeat_changes(client, google):
    fake, _, _ = google
    selected = listed(client)[1]
    path = f"/api/events/{selected['id']}/edit-context"
    assert client.get(path).json()["recurrence_rule"] == "FREQ=WEEKLY;COUNT=4"
    fake.events["series"]["recurrence"] = ["RRULE:FREQ=WEEKLY;COUNT=8"]
    assert client.get(path).json()["recurrence_rule"] == "FREQ=WEEKLY;COUNT=8"

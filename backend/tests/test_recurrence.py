from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.models import Event
from app.services import recurrence


def make_event(rule, start=datetime(2026, 8, 3, 17, 0), hours=1):
    return Event(
        id=1,
        calendar_id=1,
        title="Soccer practice",
        start_at=start,
        end_at=start.replace(hour=start.hour + hours),
        recurrence_rule=rule,
    )


def starts(rule, window_start, window_end, **kw):
    return recurrence.occurrences(make_event(rule, **kw), window_start, window_end)


# ------------------------------ validation -----------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("FREQ=WEEKLY", "FREQ=WEEKLY"),
        ("RRULE:FREQ=DAILY", "FREQ=DAILY"),
        ("  freq=monthly  ", "FREQ=MONTHLY"),
        ("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"),
    ],
)
def test_validate_normalises(raw, expected):
    assert recurrence.validate(raw) == expected


@pytest.mark.parametrize(
    "raw", ["", "FREQ=HOURLY", "FREQ=MINUTELY", "BYDAY=MO", "nonsense", "FREQ=WEEKLY;UNTIL=nope"]
)
def test_validate_rejects_junk(raw):
    with pytest.raises(recurrence.RecurrenceError):
        recurrence.validate(raw)


# ------------------------------ expansion ------------------------------------


def test_daily_expands_once_per_day():
    found = starts("FREQ=DAILY", datetime(2026, 8, 3), datetime(2026, 8, 10))
    assert len(found) == 7
    assert found[0] == datetime(2026, 8, 3, 17, 0)
    assert all(o.hour == 17 for o in found), "time of day must be preserved"


def test_weekly_on_specific_days():
    # Aug 3 2026 is a Monday.
    found = starts(
        "FREQ=WEEKLY;BYDAY=MO,WE", datetime(2026, 8, 3), datetime(2026, 8, 17)
    )
    assert [o.date().isoformat() for o in found] == [
        "2026-08-03",
        "2026-08-05",
        "2026-08-10",
        "2026-08-12",
    ]


def test_count_limits_the_series():
    found = starts("FREQ=DAILY;COUNT=3", datetime(2026, 8, 1), datetime(2026, 9, 1))
    assert len(found) == 3


def test_until_ends_the_series():
    found = starts(
        "FREQ=DAILY;UNTIL=20260806T000000Z", datetime(2026, 8, 1), datetime(2026, 9, 1)
    )
    assert [o.date().isoformat() for o in found] == ["2026-08-03", "2026-08-04", "2026-08-05"]


def test_until_with_utc_suffix_still_produces_occurrences():
    """A Z-suffixed UNTIL is the standard iCalendar form and what Google emits.
    dateutil silently returns nothing when it is compared against a naive DTSTART,
    so this is the regression guard for an event vanishing entirely."""
    for rule in ("FREQ=DAILY;UNTIL=20260806T000000Z", "FREQ=DAILY;UNTIL=20260806T000000"):
        found = starts(rule, datetime(2026, 8, 1), datetime(2026, 9, 1))
        assert [o.date().isoformat() for o in found] == [
            "2026-08-03",
            "2026-08-04",
            "2026-08-05",
        ], rule


def test_validate_keeps_the_utc_meaning_of_a_suffixed_until():
    assert recurrence.validate("FREQ=DAILY;UNTIL=20261231T000000Z") == (
        "FREQ=DAILY;UNTIL=20261231T000000Z"
    )


def test_interval_is_respected():
    found = starts("FREQ=WEEKLY;INTERVAL=2", datetime(2026, 8, 1), datetime(2026, 9, 15))
    assert [o.date().isoformat() for o in found] == [
        "2026-08-03",
        "2026-08-17",
        "2026-08-31",
        "2026-09-14",
    ]


def test_monthly_and_yearly():
    monthly = starts("FREQ=MONTHLY", datetime(2026, 8, 1), datetime(2026, 12, 1))
    assert [o.date().isoformat() for o in monthly] == [
        "2026-08-03",
        "2026-09-03",
        "2026-10-03",
        "2026-11-03",
    ]
    yearly = starts("FREQ=YEARLY", datetime(2026, 1, 1), datetime(2030, 1, 1))
    assert len(yearly) == 4


def test_window_before_the_series_starts_is_empty():
    assert starts("FREQ=DAILY", datetime(2026, 7, 1), datetime(2026, 8, 1)) == []


def test_window_far_after_a_finished_series_is_empty():
    found = starts("FREQ=DAILY;COUNT=3", datetime(2027, 1, 1), datetime(2027, 2, 1))
    assert found == []


def test_occurrence_running_at_the_window_start_is_included():
    """An event that began before the window but hasn't ended yet must still show,
    matching how single events are selected."""
    found = starts(
        "FREQ=DAILY",
        datetime(2026, 8, 5, 17, 30),  # mid-way through that day's 17:00-18:00
        datetime(2026, 8, 5, 23, 0),
        hours=1,
    )
    assert [o.isoformat() for o in found] == ["2026-08-05T17:00:00"]


def test_runaway_rule_is_capped():
    found = starts("FREQ=DAILY", datetime(2026, 1, 1), datetime(2126, 1, 1))
    assert len(found) <= recurrence.MAX_OCCURRENCES


def test_unparseable_stored_rule_yields_nothing_rather_than_raising():
    event = make_event("FREQ=WEEKLY;BYDAY=XX")
    assert recurrence.occurrences(event, datetime(2026, 8, 1), datetime(2026, 9, 1)) == []


def test_materialise_keeps_duration_and_identity():
    event = make_event("FREQ=DAILY;COUNT=2", hours=2)
    instances = recurrence.materialise(event, datetime(2026, 8, 1), datetime(2026, 9, 1))
    assert len(instances) == 2
    for inst in instances:
        assert inst.id == event.id, "instances point back at the series so edits can find it"
        assert inst.end_at - inst.start_at == event.end_at - event.start_at
        assert inst.title == event.title


@pytest.mark.parametrize("timezone,day", [
    ("Europe/Ljubljana", "2026-10-21"),
    ("Europe/Ljubljana", "2026-03-25"),
    ("America/New_York", "2026-10-28"),
    ("America/New_York", "2026-03-04"),
])
def test_weekly_events_keep_their_local_hour_across_clock_changes(timezone, day):
    tz = ZoneInfo(timezone)
    local_start = datetime.fromisoformat(f"{day}T14:00").replace(tzinfo=tz)
    start = local_start.astimezone(UTC).replace(tzinfo=None)
    event = make_event("FREQ=WEEKLY;COUNT=3", start=start)
    event.timezone = timezone
    found = recurrence.materialise(event, start - timedelta(days=1), start + timedelta(days=22))
    assert len(found) == 3
    assert {e.start_at.replace(tzinfo=UTC).astimezone(tz).hour for e in found} == {14}
    assert {e.end_at.replace(tzinfo=UTC).astimezone(tz).hour for e in found} == {15}
    assert found[0].start_at.hour != found[1].start_at.hour, "UTC must follow the new offset"
    assert all(e.start_at.tzinfo is None for e in found), "database boundaries stay naive UTC"


def test_byday_uses_the_local_weekday_even_when_utc_is_still_sunday():
    event = make_event("FREQ=WEEKLY;BYDAY=MO;COUNT=2", start=datetime(2026, 10, 18, 22, 30))
    event.timezone = "Europe/Ljubljana"
    assert recurrence.occurrences(event, datetime(2026, 10, 18), datetime(2026, 11, 1)) == [
        datetime(2026, 10, 18, 22, 30), datetime(2026, 10, 25, 23, 30),
    ]


def test_exdates_still_match_utc_occurrences_after_the_clock_change():
    event = make_event("FREQ=WEEKLY;COUNT=3", start=datetime(2026, 10, 21, 12))
    event.timezone = "Europe/Ljubljana"
    event.exdates = "2026-10-28T13:00:00"
    assert recurrence.occurrences(event, datetime(2026, 10, 19), datetime(2026, 11, 6)) == [
        datetime(2026, 10, 21, 12), datetime(2026, 11, 4, 13),
    ]


@pytest.mark.parametrize("until,count", [
    ("20261028T123000Z", 1),  # UTC cutoff before the second 14:00 local occurrence
    ("20261028T133000Z", 2),
    ("20261028T143000", 2),   # Unsuffixed UI cutoff is in the event's local zone
])
def test_until_respects_utc_or_local_time_as_written(until, count):
    event = make_event(f"FREQ=WEEKLY;UNTIL={until}", start=datetime(2026, 10, 21, 12))
    event.timezone = "Europe/Ljubljana"
    found = recurrence.occurrences(event, datetime(2026, 10, 19), datetime(2026, 11, 6))
    assert len(found) == count


def test_series_end_uses_the_offset_of_the_final_occurrence():
    assert recurrence.series_end(
        "FREQ=WEEKLY;COUNT=2", datetime(2026, 10, 21, 12), timedelta(hours=1), "Europe/Ljubljana"
    ) == datetime(2026, 10, 28, 14)


def test_all_day_recurrence_stays_on_date_boundaries_across_dst():
    event = make_event("FREQ=WEEKLY;COUNT=2", start=datetime(2026, 10, 21))
    event.end_at = event.start_at + timedelta(days=1)
    event.all_day = True
    event.timezone = "Europe/Ljubljana"
    found = recurrence.materialise(event, datetime(2026, 10, 19), datetime(2026, 11, 1))
    assert [e.start_at for e in found] == [datetime(2026, 10, 21), datetime(2026, 10, 28)]
    assert all(e.end_at - e.start_at == timedelta(days=1) for e in found)


# --------------------------- human description -------------------------------


@pytest.mark.parametrize(
    "rule,expected",
    [
        ("FREQ=DAILY", "Every day"),
        ("FREQ=WEEKLY", "Every week"),
        ("FREQ=WEEKLY;INTERVAL=2", "Every 2 weeks"),
        ("FREQ=WEEKLY;BYDAY=MO,WE", "Every week on Mon, Wed"),
        ("FREQ=DAILY;COUNT=5", "Every day, 5 times"),
        ("FREQ=MONTHLY", "Every month"),
        ("FREQ=YEARLY", "Every year"),
    ],
)
def test_describe(rule, expected):
    assert recurrence.describe(rule) == expected


def test_describe_handles_nothing_and_nonsense():
    assert recurrence.describe(None) is None
    assert recurrence.describe("garbage") == "Repeats"


# ------------------------------- via the API ---------------------------------


def test_create_recurring_event_and_see_every_occurrence(client, local_calendar):
    created = client.post(
        "/api/events",
        json={
            "calendar_id": local_calendar["id"],
            "title": "Piano lesson",
            "start_at": "2026-08-03T17:00:00Z",
            "end_at": "2026-08-03T18:00:00Z",
            "recurrence_rule": "FREQ=WEEKLY;COUNT=4",
        },
    )
    assert created.status_code == 201
    assert created.json()["recurring"] is True
    assert created.json()["recurrence_text"] == "Every week, 4 times"

    listed = client.get(
        "/api/events", params={"start": "2026-08-01T00:00:00Z", "end": "2026-09-01T00:00:00Z"}
    ).json()
    assert [e["start_at"][:10] for e in listed] == [
        "2026-08-03",
        "2026-08-10",
        "2026-08-17",
        "2026-08-24",
    ]
    assert all(e["title"] == "Piano lesson" for e in listed)
    assert len({e["id"] for e in listed}) == 1, "every instance refers to one stored series"


def test_recurring_event_is_absent_from_a_window_it_does_not_cover(client, local_calendar):
    client.post(
        "/api/events",
        json={
            "calendar_id": local_calendar["id"],
            "title": "Weekly",
            "start_at": "2026-08-03T17:00:00Z",
            "end_at": "2026-08-03T18:00:00Z",
            "recurrence_rule": "FREQ=WEEKLY;COUNT=2",
        },
    )
    later = client.get(
        "/api/events", params={"start": "2026-10-01T00:00:00Z", "end": "2026-11-01T00:00:00Z"}
    ).json()
    assert later == []


def test_invalid_rule_is_rejected_at_write_time(client, local_calendar):
    r = client.post(
        "/api/events",
        json={
            "calendar_id": local_calendar["id"],
            "title": "Bad",
            "start_at": "2026-08-03T17:00:00Z",
            "end_at": "2026-08-03T18:00:00Z",
            "recurrence_rule": "FREQ=HOURLY",
        },
    )
    assert r.status_code == 400
    assert "DAILY" in r.json()["error"]["message"]


def test_making_an_event_recurring_afterwards(client, local_calendar):
    ev = client.post(
        "/api/events",
        json={
            "calendar_id": local_calendar["id"],
            "title": "Standup",
            "start_at": "2026-08-03T13:00:00Z",
            "end_at": "2026-08-03T13:30:00Z",
        },
    ).json()
    assert ev["recurring"] is False

    updated = client.patch(
        f"/api/events/{ev['id']}", json={"recurrence_rule": "FREQ=DAILY;COUNT=3"}
    ).json()
    assert updated["recurring"] is True

    listed = client.get(
        "/api/events", params={"start": "2026-08-01T00:00:00Z", "end": "2026-09-01T00:00:00Z"}
    ).json()
    assert len(listed) == 3


def test_single_events_still_behave(client, local_calendar):
    """The recurrence branch must not disturb the ordinary path."""
    client.post(
        "/api/events",
        json={
            "calendar_id": local_calendar["id"],
            "title": "One off",
            "start_at": "2026-08-03T17:00:00Z",
            "end_at": "2026-08-03T18:00:00Z",
        },
    )
    inside = client.get(
        "/api/events", params={"start": "2026-08-03T00:00:00Z", "end": "2026-08-04T00:00:00Z"}
    ).json()
    outside = client.get(
        "/api/events", params={"start": "2026-08-05T00:00:00Z", "end": "2026-08-06T00:00:00Z"}
    ).json()
    assert len(inside) == 1 and outside == []


def test_api_keeps_a_local_series_at_two_pm_after_october_dst(client, local_calendar):
    payload = {
        "calendar_id": local_calendar["id"], "title": "DST weekly",
        "start_at": "2026-10-21T14:00:00+02:00", "end_at": "2026-10-21T15:00:00+02:00",
        "recurrence_rule": "FREQ=WEEKLY;COUNT=2", "timezone": "Europe/Ljubljana",
    }
    created = client.post("/api/events", json=payload)
    assert created.status_code == 201
    assert created.json()["timezone"] == "Europe/Ljubljana"
    listed = client.get("/api/events", params={
        "start": "2026-10-28T13:30:00Z", "end": "2026-10-28T14:30:00Z",
    }).json()
    assert len(listed) == 1, "the final occurrence must still overlap a window within it"
    assert listed[0]["start_at"] == "2026-10-28T13:00:00Z"
    assert listed[0]["end_at"] == "2026-10-28T14:00:00Z"


def test_legacy_local_series_uses_viewer_zone_without_rewriting_the_series(
    client, db, local_calendar,
):
    event = Event(
        calendar_id=local_calendar["id"], title="Older weekly event", origin="local",
        start_at=datetime(2026, 10, 21, 12), end_at=datetime(2026, 10, 21, 13),
        recurrence_rule="FREQ=WEEKLY;COUNT=2", timezone=None,
        recurrence_end=datetime(2026, 10, 28, 13),
    )
    db.add(event)
    db.commit()
    listed = client.get("/api/events", params={
        "start": "2026-10-28T13:30:00Z", "end": "2026-10-28T14:30:00Z",
        "timezone": "Europe/Ljubljana",
    }).json()
    assert len(listed) == 1, "an old cached end bound must not hide the corrected final occurrence"
    assert listed[0]["start_at"] == "2026-10-28T13:00:00Z"
    db.refresh(event)
    assert event.timezone is None, "reading a series must not rewrite or queue provider changes"


def test_missing_series_zone_defaults_to_home_but_explicit_utc_stays_utc(client, local_calendar):
    client.patch("/api/settings", json={"home_timezone": "Europe/Ljubljana"})
    payload = {
        "calendar_id": local_calendar["id"], "title": "Weekly",
        "start_at": "2026-10-21T12:00:00Z", "end_at": "2026-10-21T13:00:00Z",
        "recurrence_rule": "FREQ=WEEKLY;COUNT=2",
    }
    assert client.post("/api/events", json=payload).json()["timezone"] == "Europe/Ljubljana"
    explicit = client.post("/api/events", json={**payload, "timezone": "UTC"}).json()
    assert explicit["timezone"] == "UTC"


def test_invalid_timezone_is_rejected_at_write_time(client, local_calendar):
    response = client.post("/api/events", json={
        "calendar_id": local_calendar["id"], "title": "Weekly",
        "start_at": "2026-10-21T12:00:00Z", "end_at": "2026-10-21T13:00:00Z",
        "recurrence_rule": "FREQ=WEEKLY", "timezone": "Not/AZone",
    })
    assert response.status_code == 422

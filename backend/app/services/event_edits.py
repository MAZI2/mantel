"""Scoped edits keep the old series' history and queue provider work durably."""

from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import or_, select

from ..models import Event
from ..timeutil import as_utc, to_utc
from . import event_deletions, recurrence
from .pushqueue import mark_pending
from .timezones import home_timezone, zone

FIELDS = (
    "title",
    "description",
    "location",
    "start_at",
    "end_at",
    "all_day",
    "timezone",
    "recurrence_rule",
    "exdates",
    "color_override",
)


def master_for(db, event: Event, *, refresh: bool = False) -> Event:
    key = event_deletions.series_key(event)
    master = (
        event
        if event.recurrence_rule
        else db.scalar(
            select(Event).where(
                Event.calendar_id == event.calendar_id,
                or_(Event.google_event_id == key, Event.local_series_key == key),
                Event.recurrence_rule.is_not(None),
            )
        )
    )
    if master and (not refresh or master.calendar.is_local or master.sync_state != "synced"):
        return master
    from .sync_engine import provider_factory

    try:
        item = provider_factory(db, event.calendar.account).get_series(
            event.calendar.remote_id, key
        )
    except Exception as exc:
        raise HTTPException(502, "Could not load the repeat rule. Sync and try again.") from exc
    if not item.recurrence_rule or item.start is None or item.end is None:
        raise HTTPException(409, "This series no longer repeats. Refresh and try again.")
    master = db.scalar(
        select(Event).where(Event.calendar_id == event.calendar_id, Event.google_event_id == key)
    )
    if master is None:
        master = Event(
            calendar_id=event.calendar_id,
            google_event_id=key,
            origin=event.origin,
            sync_state="synced",
            is_master=True,
        )
        db.add(master)
    master.title, master.description, master.location = item.title, item.description, item.location
    master.start_at, master.end_at, master.all_day = item.start, item.end, item.all_day
    master.timezone, master.recurrence_rule = item.timezone, item.recurrence_rule
    master.exdates = ",".join(d.isoformat() for d in item.exdates) or None
    master.remote_etag = item.etag
    db.flush()
    return master


def remaining_rule(master: Event, moment: datetime) -> str:
    rule = master.recurrence_rule
    parts = dict(piece.split("=", 1) for piece in rule.split(";"))
    if "COUNT" not in parts:
        return rule
    before = 0
    for stamp in recurrence._rule(
        rule, master.start_at, None if master.all_day else master.timezone
    ):
        if to_utc(stamp) >= moment:
            break
        before += 1
        if before >= recurrence.MAX_OCCURRENCES:
            raise HTTPException(400, "The series is too long to split safely.")
    parts["COUNT"] = str(max(1, int(parts["COUNT"]) - before))
    return ";".join(f"{key}={value}" for key, value in parts.items())


def convert_slot(stamp, old_all_day, old_timezone, selected, new_start, new_all_day, new_timezone):
    old_zone = zone(None if old_all_day else old_timezone)
    new_zone = zone(None if new_all_day else new_timezone)
    source_date = as_utc(stamp).astimezone(old_zone).date()
    selected_date = as_utc(selected).astimezone(old_zone).date()
    target = as_utc(new_start).astimezone(new_zone)
    day = source_date + (target.date() - selected_date)
    return to_utc(datetime.combine(day, target.time()).replace(tzinfo=new_zone))


def shift_weekdays(rule: str | None, days: int) -> str | None:
    if not rule or "FREQ=WEEKLY" not in rule or days % 7 == 0:
        return rule
    names = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    parts = []
    for part in rule.split(";"):
        if part.startswith("BYDAY="):
            selected = part[6:].split(",")
            selected = [
                value[:-2] + names[(names.index(value[-2:]) + days) % 7] for value in selected
            ]
            part = "BYDAY=" + ",".join(selected)
        parts.append(part)
    return ";".join(parts)


def prepare(db, event: Event, scope: str, moment: datetime | None, changes: dict) -> Event:
    if moment is None:
        raise HTTPException(400, "Choose the occurrence to edit.")
    if not (event.recurrence_rule or event.recurring_event_id or event.local_series_key):
        raise HTTPException(400, "This event is not recurring.")
    master = master_for(db, event)
    if not master.all_day and not master.timezone:
        master.timezone = home_timezone(db)
    # A moved provider instance is selected by its original slot, never its new date.
    if event.recurring_event_id or (event.local_series_key and not event.recurrence_rule):
        original = event.original_start_at
        if original is None:
            from .sync_engine import provider_factory

            original = provider_factory(db, event.calendar.account).original_start(
                event.calendar.remote_id, event.remote_id
            )
        if original is None or moment != original:
            raise HTTPException(400, "The occurrence date does not match this event.")
    elif moment not in recurrence.occurrences(master, moment, moment + timedelta(seconds=1)):
        raise HTTPException(
            400, "That occurrence is no longer in this series. Refresh and try again."
        )
    selected_start = event.start_at if not event.recurrence_rule else moment
    duration = event.end_at - event.start_at
    new_start = changes.get("start_at") or selected_start
    new_end = changes.get("end_at") or new_start + duration
    if new_end <= new_start:
        raise HTTPException(400, "`end_at` must be after `start_at`")
    if changes.get("recurrence_rule"):
        changes["recurrence_rule"] = recurrence.validate(changes["recurrence_rule"])
    conversion = None
    if changes.get("all_day", event.all_day) != event.all_day:
        conversion = (
            event.all_day,
            event.timezone,
            selected_start,
            new_start,
            changes["all_day"],
            changes.get("timezone"),
        )
    old_zone = zone(None if event.all_day else event.timezone or master.timezone)
    new_zone = zone(
        None
        if changes.get("all_day", event.all_day)
        else changes.get("timezone") or event.timezone or master.timezone
    )
    day_shift = (
        as_utc(new_start).astimezone(new_zone).date()
        - as_utc(selected_start).astimezone(old_zone).date()
    ).days
    unchanged_rule = (
        "recurrence_rule" not in changes or changes["recurrence_rule"] == master.recurrence_rule
    )
    if scope == "all":
        if unchanged_rule:
            changes["recurrence_rule"] = shift_weekdays(master.recurrence_rule, day_shift)
        tz = zone(None if master.all_day else master.timezone)
        delta = as_utc(new_start).astimezone(tz).replace(tzinfo=None) - as_utc(
            selected_start
        ).astimezone(tz).replace(tzinfo=None)
        anchor = as_utc(master.start_at).astimezone(tz)
        shifted = (anchor.replace(tzinfo=None) + delta).replace(tzinfo=tz)
        changes["start_at"] = (
            convert_slot(master.start_at, *conversion) if conversion else to_utc(shifted)
        )
        changes["end_at"] = changes["start_at"] + (new_end - new_start)
        # Cached expanded instances must not keep showing the old values after saving.
        for row in db.scalars(
            select(Event).where(
                Event.calendar_id == master.calendar_id,
                Event.recurring_event_id == master.remote_id,
                Event.recurring_event_id.is_not(None),
            )
        ):
            if row.sync_state == "synced":
                db.delete(row)
        if "recurrence_rule" in changes and changes["recurrence_rule"] is None:
            master.pending_recurrence_clear = True
            master.local_series_key = None
            master.exdates = None
        elif delta:
            shifted_exclusions = []
            for stamp in recurrence.excluded_starts(master):
                local = as_utc(stamp).astimezone(tz).replace(tzinfo=None)
                shifted_exclusions.append(
                    convert_slot(stamp, *conversion)
                    if conversion
                    else to_utc((local + delta).replace(tzinfo=tz))
                )
            master.exdates = ",".join(stamp.isoformat() for stamp in shifted_exclusions) or None
        for key, value in changes.items():
            setattr(master, key, value)
        master._reference_conversion = conversion
        master._reference_shift = delta
        master.is_master = False
        mark_pending(master, master.calendar, "pending_update")
        return master
    values = {key: getattr(event if not event.recurrence_rule else master, key) for key in FIELDS}
    values.update(changes)
    values["start_at"], values["end_at"] = new_start, new_end
    if scope == "this":
        master.local_series_key = (
            event_deletions.series_key(master)
            or f"local-series:{master.id}:{master.created_at.isoformat()}"
        )
        values["local_series_key"] = master.local_series_key
        values["original_start_at"] = moment
        values["recurrence_rule"], values["exdates"] = None, None
    else:
        if "recurrence_rule" not in changes or changes["recurrence_rule"] == master.recurrence_rule:
            values["recurrence_rule"] = shift_weekdays(remaining_rule(master, moment), day_shift)
        values["exdates"] = (
            ",".join(
                (convert_slot(d, *conversion) if conversion else d).isoformat()
                for d in recurrence.excluded_starts(master)
                if d >= moment
            )
            or None
        )
    replacement = Event(calendar_id=event.calendar_id, origin="local", **values)
    replacement._reference_conversion = conversion
    # Queue both writes together; invalid edits cannot delete the old event.
    task = event_deletions.queue_deletion(db, event, scope, moment, commit=False)
    mark_pending(replacement, event.calendar, "pending_create")
    db.add(replacement)
    db.flush()
    task.exempt_event_id = replacement.id
    return replacement

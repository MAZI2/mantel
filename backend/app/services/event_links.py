"""Individual live event links, authorized against both profiles on every use."""

from contextlib import contextmanager

from fastapi import HTTPException
from sqlalchemy import or_, select

from ..models import Calendar, Event
from ..profile_context import current_identity, current_profile
from ..profiles import EventReference, RegistrySession
from . import calendar_links, importance, recurrence

MARKER = 1 << 52


def is_reference(event_id: int) -> bool:
    return -calendar_links.PROJECTION_MARKER < event_id < -MARKER


def identifier(reference: EventReference) -> int:
    value = MARKER + reference.id
    if value >= calendar_links.PROJECTION_MARKER:
        raise HTTPException(409, "This event link cannot be represented.")
    return -value


def find_event(db, reference: EventReference) -> Event:
    key = reference.event_key
    statement = select(Event).where(
        Event.calendar_id == reference.source_calendar_id,
        Event.status == "confirmed",
        Event.sync_state != "pending_delete",
    )
    if key.startswith("remote:"):
        remote = key.removeprefix("remote:")
        statement = statement.where(
            or_(Event.google_event_id == remote, Event.recurring_event_id == remote)
        )
    else:
        try:
            local_id = int(key.split(":")[1])
        except (ValueError, IndexError) as exc:
            raise HTTPException(409, "The original event link is invalid.") from exc
        statement = statement.where(Event.id == local_id)
    for event in sorted(db.scalars(statement), key=lambda row: bool(row.recurrence_rule)):
        if event.is_master and event.sync_state == "synced":
            continue
        if importance.event_key(event) != key:
            continue
        if (
            reference.occurrence_start is None
            or event.recurrence_rule
            or event.original_start_at == reference.occurrence_start
            or event.start_at == reference.occurrence_start
        ):
            return event
    raise HTTPException(404, "The original event is unavailable.")


@contextmanager
def source(db, event_id: int):
    scope = current_profile.get()
    with RegistrySession() as registry:
        reference = registry.get(EventReference, -event_id - MARKER)
        if reference is None or not scope or reference.destination_profile_id != scope.id:
            raise HTTPException(404, "Event not found.")
    target = db.get(Calendar, reference.destination_calendar_id)
    if target is None or target.is_linked:
        raise HTTPException(404, "The destination calendar is unavailable.")
    link = Calendar(
        source_profile_id=reference.source_profile_id,
        source_calendar_id=reference.source_calendar_id,
        name="Event link",
    )
    with calendar_links.source_calendar(link) as (source_db, _, _):
        event = find_event(source_db, reference)
        yield reference, target, source_db, event


def occurrence(db, reference: EventReference, event: Event) -> Event:
    if reference.occurrence_start is not None and event.recurrence_rule:
        moment = reference.occurrence_start
        from datetime import timedelta

        matches = recurrence.materialise(event, moment, moment + timedelta(seconds=1))
        match = next((row for row in matches if row.original_start_at == moment), None)
        if match is None:
            raise HTTPException(404, "The linked occurrence is no longer in the series.")
        return match
    return event


def output(reference, target, result):
    return result.model_copy(
        update=dict(
            id=identifier(reference),
            calendar_id=target.id,
            calendar_name=target.name,
            user_id=target.claimed_by_user_id,
            linked_event=True,
        )
    )


def list_events(db, start, end, selected_calendars, selected_users, q, serialize):
    scope = current_profile.get()
    if scope is None or current_identity.get() is None:
        return []
    with RegistrySession() as registry:
        references = list(
            registry.scalars(
                select(EventReference).where(EventReference.destination_profile_id == scope.id)
            )
        )
    result = []
    for reference in references:
        if (
            selected_calendars is not None
            and reference.destination_calendar_id not in selected_calendars
        ):
            continue
        try:
            with source(db, identifier(reference)) as (ref, target, source_db, event):
                if selected_users is not None and target.claimed_by_user_id not in selected_users:
                    continue
                instance = occurrence(source_db, ref, event)
                if (
                    instance.start_at >= end
                    or instance.end_at <= start
                    or (q and q.lower() not in instance.title.lower())
                ):
                    continue
                result.append(output(ref, target, serialize(source_db, instance)))
        except HTTPException as exc:
            if exc.status_code not in (403, 404, 409):
                raise
    return result


def transfer(event, old_calendar, old_key, *, moment=None, scope=None, delta=None, conversion=None):
    profile = current_profile.get()
    if not profile:
        return
    with RegistrySession() as registry:
        for ref in registry.scalars(
            select(EventReference).where(
                EventReference.source_profile_id == profile.id,
                EventReference.source_calendar_id == old_calendar,
                EventReference.event_key == old_key,
            )
        ):
            if moment is not None and scope != "all":
                if ref.occurrence_start is None or (
                    ref.occurrence_start != moment
                    if scope == "this"
                    else ref.occurrence_start < moment
                ):
                    continue
            ref.source_calendar_id, ref.event_key = event.calendar_id, importance.event_key(event)
            if moment is not None:
                if not event.recurrence_rule:
                    ref.occurrence_start = None
                elif ref.occurrence_start:
                    if conversion:
                        from .event_edits import convert_slot

                        ref.occurrence_start = convert_slot(ref.occurrence_start, *conversion)
                        continue
                    from ..timeutil import as_utc, to_utc
                    from .timezones import zone

                    tz = zone(None if event.all_day else event.timezone)
                    shift = (
                        delta
                        if delta is not None
                        else as_utc(event.start_at).astimezone(tz).replace(tzinfo=None)
                        - as_utc(moment).astimezone(tz).replace(tzinfo=None)
                    )
                    ref.occurrence_start = to_utc(
                        (
                            as_utc(ref.occurrence_start).astimezone(tz).replace(tzinfo=None) + shift
                        ).replace(tzinfo=tz)
                    )
        registry.commit()

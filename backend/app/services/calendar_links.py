"""Live calendar references; events and provider credentials stay in their source profile."""

from contextlib import contextmanager

from fastapi import HTTPException

from ..db import profile_sessions
from ..models import Calendar
from ..profile_context import current_identity, current_profile, profile_context
from ..profiles import Membership, Principal, Profile, RegistrySession, scope_for
from ..schemas import CalendarOut, EventOut
from ..serializers import calendar_color, calendar_out

# Negative IDs are virtual; positive IDs always address this profile's own rows.
# Both components fit well below JavaScript's exact integer limit.
_BITS = 26
_MASK = (1 << _BITS) - 1


def virtual_id(calendar_id: int, event_id: int) -> int:
    if not (0 < calendar_id <= _MASK and 0 < event_id <= _MASK):
        raise HTTPException(409, "This event cannot be represented as a linked event.")
    return -((calendar_id << _BITS) | event_id)


def decode(event_id: int) -> tuple[int, int]:
    return (-event_id) >> _BITS, (-event_id) & _MASK


@contextmanager
def source_calendar(link: Calendar):
    identity, destination = current_identity.get(), current_profile.get()
    if not identity or not destination or not link.is_linked:
        raise HTTPException(403, "Access to both profiles is required.")
    with RegistrySession() as registry:
        person = registry.get(Principal, identity)
        source = registry.get(Profile, link.source_profile_id)
        target = registry.get(Profile, destination.id)
        if (
            person is None
            or not person.enabled
            or source is None
            or not source.active
            or target is None
            or not target.active
            or registry.get(Membership, (identity, source.id)) is None
            or registry.get(Membership, (identity, target.id)) is None
        ):
            raise HTTPException(403, "Access to both profiles is required.")
        scope, name = scope_for(source), source.name
    with profile_context(scope), profile_sessions(scope.database_url)() as db:
        calendar = db.get(Calendar, link.source_calendar_id)
        if calendar is None or calendar.is_linked:
            raise HTTPException(404, "The original calendar is unavailable.")
        yield db, calendar, name


def output(link: Calendar) -> CalendarOut:
    with source_calendar(link) as (_, source, profile_name):
        result = calendar_out(link)
        return result.model_copy(
            update={
                "source_profile_id": link.source_profile_id,
                "source_calendar_id": source.id,
                "source_profile_name": profile_name,
                "name": source.name,
                "color": calendar_color(source),
                "writable": source.writable,
                "access_role": source.access_role,
                "sync_enabled": source.is_local or source.sync_enabled,
                "last_synced_at": calendar_out(source).last_synced_at,
                "sync_error": source.sync_error,
            }
        )


def event_output(link: Calendar, event: EventOut) -> EventOut:
    update = dict(
        id=virtual_id(link.id, event.id),
        calendar_id=link.id,
        calendar_name=event.calendar_name,
        user_id=link.claimed_by_user_id,
    )
    return event.model_copy(update=update)


def event_source(db, event_id: int):
    calendar_id, original_id = decode(event_id)
    link = db.get(Calendar, calendar_id)
    if link is None or not link.is_linked or original_id <= 0:
        raise HTTPException(404, "Event not found.")
    return link, original_id

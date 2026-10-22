"""Personal importance, separate from shared events and provider payloads."""

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from ..models import Event
from ..profile_context import current_identity, current_profile
from ..profiles import EventPreference, PersonalPreference, RegistrySession


def event_key(event: Event) -> str:
    remote = event.recurring_event_id or event.remote_id
    if remote:
        return f"remote:{remote}"
    return f"local:{event.id}:{event.created_at.isoformat() if event.created_at else 'legacy'}"


def values(events: list[Event], selected: bool | None = None) -> list[bool]:
    identity, scope = current_identity.get(), current_profile.get()
    if not identity or not scope or not events:
        return [True] * len(events)
    keys = [(event.calendar_id, event_key(event)) for event in events]
    with RegistrySession() as registry:
        defaults = registry.get(PersonalPreference, identity)
        default = defaults.important_by_default if defaults else None
        default = True if default is None else default
        statement = insert(EventPreference)
        rows = [
            dict(
                identity=identity,
                profile_id=scope.id,
                calendar_id=cal,
                event_key=key,
                important=default if selected is None else selected,
            )
            for cal, key in set(keys)
        ]
        statement = (
            statement.on_conflict_do_nothing()
            if selected is None
            else statement.on_conflict_do_update(
                index_elements=["identity", "profile_id", "calendar_id", "event_key"],
                set_={"important": selected},
            )
        )
        registry.execute(statement, rows)
        registry.commit()
        saved = {
            (row.calendar_id, row.event_key): row.important
            for row in registry.scalars(
                select(EventPreference).where(
                    EventPreference.identity == identity,
                    EventPreference.profile_id == scope.id,
                    EventPreference.calendar_id.in_({cal for cal, _ in keys}),
                    EventPreference.event_key.in_({key for _, key in keys}),
                )
            )
        }
        return [saved.get(key, default) for key in keys]


def transfer(event: Event, old_calendar_id: int, old_key: str) -> None:
    """Keep every person's marks through provider creation, resync and calendar moves."""
    scope = current_profile.get()
    if not scope or (old_calendar_id, old_key) == (event.calendar_id, event_key(event)):
        return
    with RegistrySession() as registry:
        rows = list(
            registry.scalars(
                select(EventPreference).where(
                    EventPreference.profile_id == scope.id,
                    EventPreference.calendar_id == old_calendar_id,
                    EventPreference.event_key == old_key,
                )
            )
        )
        for row in rows:
            registry.execute(
                insert(EventPreference)
                .values(
                    identity=row.identity,
                    profile_id=scope.id,
                    calendar_id=event.calendar_id,
                    event_key=event_key(event),
                    important=row.important,
                )
                .on_conflict_do_nothing()
            )
        registry.commit()

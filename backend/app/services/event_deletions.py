"""Scoped recurrence deletion and its durable provider queue."""

from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import Calendar, Event, EventDeletion
from ..timeutil import utcnow_naive
from . import recurrence
from .providers.base import ProviderError, RemoteEvent


def series_key(event: Event) -> str | None:
    return event.recurring_event_id or event.remote_id


def same_series(task: EventDeletion, event: Event) -> bool:
    return event.calendar_id == task.calendar_id and (
        event.id == task.event_id or bool(task.series_id and series_key(event) == task.series_id)
    )


def original_start(event: Event) -> datetime:
    if event.original_start_at:
        return event.original_start_at
    if event.recurring_event_id and event.remote_id and "#" in event.remote_id:
        stamp = event.remote_id.rsplit("#", 1)[-1]
        for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%d"):
            try:
                return datetime.strptime(stamp, fmt)
            except ValueError:
                pass
    return event.start_at


def targets(task: EventDeletion, event: Event) -> bool:
    if not same_series(task, event):
        return False
    if task.scope == "all":
        return True
    if event.recurrence_rule:
        return False  # The master is edited in place; historical occurrences remain.
    moment = original_start(event)
    return (
        moment == task.occurrence_start if task.scope == "this" else moment >= task.occurrence_start
    )


def apply_locally(db: Session, task: EventDeletion, master: Event | None) -> None:
    if master and task.scope != "all":
        if task.scope == "this":
            excluded = recurrence.excluded_starts(master) | {task.occurrence_start}
            master.exdates = ",".join(moment.isoformat() for moment in sorted(excluded))
        else:
            master.recurrence_rule = recurrence.truncate_rule(
                master.recurrence_rule,
                task.occurrence_start,
                master.all_day,
            )
            master.recurrence_end = recurrence.series_end(
                master.recurrence_rule,
                master.start_at,
                master.end_at - master.start_at,
                None if master.all_day else master.timezone,
            )
    for row in db.scalars(select(Event).where(Event.calendar_id == task.calendar_id)):
        if targets(task, row):
            db.delete(row)


def queue_deletion(
    db: Session,
    event: Event,
    scope: str,
    moment: datetime,
) -> None:
    key = series_key(event)
    master = (
        event
        if event.recurrence_rule
        else db.scalar(
            select(Event).where(
                Event.calendar_id == event.calendar_id,
                Event.google_event_id == key,
                Event.recurrence_rule.is_not(None),
            )
        )
    )
    if master and scope == "future" and moment <= master.start_at:
        scope = "all"
    task = EventDeletion(
        calendar_id=event.calendar_id,
        event_id=master.id if master else event.id,
        remote_id=event.remote_id,
        series_id=key,
        scope=scope,
        occurrence_start=moment,
        all_day=event.all_day,
    )
    # Unsynced creates still need their cancellation applied after the create succeeds.
    remote_work = not event.calendar.is_local and (key is not None or scope != "all")
    if remote_work:
        db.add(task)
        db.flush()
    if scope == "all" and key is None:
        db.execute(
            delete(EventDeletion).where(
                EventDeletion.event_id == event.id,
                EventDeletion.series_id.is_(None),
            )
        )
    apply_locally(db, task, master)
    db.commit()


def blocks_remote(db: Session, cal: Calendar, item: RemoteEvent) -> bool:
    key = item.recurring_event_id or item.id
    tasks = db.scalars(
        select(EventDeletion).where(
            EventDeletion.calendar_id == cal.id,
            EventDeletion.series_id == key,
        )
    )
    for task in tasks:
        if task.scope == "all" or item.recurrence_rule:
            return True
        moment = item.original_start or item.start
        if moment is not None and (
            moment == task.occurrence_start
            if task.scope == "this"
            else moment >= task.occurrence_start
        ):
            return True
    return False


def acknowledge(db: Session, calendar_id: int, pull_started: datetime) -> None:
    # A pull begun before a push finishes can contain the old series. Keep the
    # guard until a newer pull can read the completed remote operation.
    db.execute(
        delete(EventDeletion).where(
            EventDeletion.calendar_id == calendar_id,
            EventDeletion.completed_at.is_not(None),
            EventDeletion.completed_at <= pull_started,
        )
    )


def push_pending(db: Session, provider_factory) -> int:
    pushed = 0
    for task in db.scalars(select(EventDeletion).where(EventDeletion.completed_at.is_(None))):
        cal = db.get(Calendar, task.calendar_id)
        if cal is None or cal.account is None or not cal.sync_enabled:
            continue
        if not task.series_id:
            anchor = db.get(Event, task.event_id) if task.event_id else None
            if anchor is None or not anchor.remote_id:
                continue
            task.series_id = anchor.remote_id
            task.remote_id = anchor.remote_id
        try:
            provider = provider_factory(db, cal.account)
            try:
                provider.delete_recurrence(
                    cal.remote_id,
                    task.remote_id or task.series_id,
                    task.series_id,
                    task.occurrence_start,
                    task.scope,
                    bool(task.all_day),
                )
            except ProviderError as exc:
                if exc.status not in (404, 410):
                    raise
            task.completed_at = utcnow_naive()
            # Clear any old snapshot rows that arrived before this command was queued.
            for row in db.scalars(select(Event).where(Event.calendar_id == cal.id)):
                if targets(task, row):
                    db.delete(row)
            cal.sync_error = None
            db.commit()
            pushed += 1
        except Exception as exc:
            db.rollback()
            cal.sync_error = str(exc)[:1000]
            db.commit()
    return pushed


def protected_masters(db: Session, calendar_id: int) -> list[int]:
    tasks = list(db.scalars(select(EventDeletion).where(EventDeletion.calendar_id == calendar_id)))
    return [
        row.id
        for row in db.scalars(
            select(Event).where(
                Event.calendar_id == calendar_id,
                Event.recurrence_rule.is_not(None),
            )
        )
        if any(same_series(task, row) for task in tasks)
    ]

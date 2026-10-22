from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db, profile_sessions
from ..models import Calendar
from ..profile_context import current_identity, current_profile, profile_context
from ..profiles import RegistrySession, member_profiles, scope_for
from ..schemas import CalendarCreate, CalendarImport, CalendarOut, CalendarUpdate
from ..serializers import calendar_out
from ..services import calendar_links
from ..services.pullsignal import request_pull

router = APIRouter(prefix="/calendars", tags=["calendars"])


def _get(db: Session, calendar_id: int) -> Calendar:
    cal = db.get(Calendar, calendar_id)
    if cal is None:
        raise HTTPException(404, "Calendar not found")
    return cal


@router.get(
    "",
    response_model=list[CalendarOut],
    summary="List calendars",
    description=(
        "Every calendar known to the app: local ones plus any discovered from linked Google "
        "accounts. A calendar only appears on the wall display once a family member claims it."
    ),
)
def list_calendars(
    claimed: bool | None = Query(default=None, description="Filter to claimed/unclaimed only."),
    user_id: int | None = Query(default=None, description="Only calendars claimed by this user."),
    db: Session = Depends(get_db),
) -> list[CalendarOut]:
    stmt = select(Calendar).order_by(Calendar.name)
    if claimed is True:
        stmt = stmt.where(Calendar.claimed_by_user_id.is_not(None))
    elif claimed is False:
        stmt = stmt.where(Calendar.claimed_by_user_id.is_(None))
    if user_id is not None:
        stmt = stmt.where(Calendar.claimed_by_user_id == user_id)
    result = []
    for calendar in db.scalars(stmt):
        if not calendar.is_linked:
            result.append(calendar_out(calendar))
            continue
        try:
            result.append(calendar_links.output(calendar))
        except HTTPException as exc:
            if exc.status_code not in (403, 404):
                raise
    return result


@router.post(
    "",
    response_model=CalendarOut,
    status_code=201,
    summary="Create a local calendar",
    description=(
        "Local calendars live only in this app and never sync to Google. Useful for things like "
        "chores or a shared family schedule that nobody has a Google calendar for."
    ),
)
def create_calendar(payload: CalendarCreate, db: Session = Depends(get_db)) -> CalendarOut:
    cal = Calendar(**payload.model_dump(), linked_account_id=None, sync_enabled=False)
    db.add(cal)
    db.commit()
    return calendar_out(cal)


@router.get("/import-options")
def import_options(db: Session = Depends(get_db)) -> list[dict]:
    destination = current_profile.get()
    with RegistrySession() as registry:
        profiles = member_profiles(registry, current_identity.get())
    existing = {
        (cal.source_profile_id, cal.source_calendar_id)
        for cal in db.scalars(select(Calendar).where(Calendar.source_profile_id.is_not(None)))
    }
    choices = []
    for profile in profiles:
        if profile.id == destination.id:
            continue
        scope = scope_for(profile)
        with profile_context(scope), profile_sessions(scope.database_url)() as source:
            for calendar in source.scalars(
                select(Calendar).where(Calendar.source_profile_id.is_(None))
            ):
                if (profile.id, calendar.id) not in existing:
                    choices.append(
                        dict(
                            profile_id=profile.id,
                            profile_name=profile.name,
                            calendar=calendar_out(calendar),
                        )
                    )
    return choices


@router.post("/import", response_model=CalendarOut, status_code=201)
def import_calendar(payload: CalendarImport, db: Session = Depends(get_db)) -> CalendarOut:
    if payload.source_profile_id == current_profile.get().id:
        raise HTTPException(400, "Choose a calendar from another profile.")
    link = Calendar(
        source_profile_id=payload.source_profile_id,
        source_calendar_id=payload.source_calendar_id,
        name="Linked calendar",
        sync_enabled=True,
    )
    with calendar_links.source_calendar(link):
        pass
    db.add(link)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "This calendar is already linked in this profile.") from exc
    return calendar_links.output(link)


@router.get("/{calendar_id}", response_model=CalendarOut, summary="Get one calendar")
def get_calendar(calendar_id: int, db: Session = Depends(get_db)) -> CalendarOut:
    calendar = _get(db, calendar_id)
    return calendar_links.output(calendar) if calendar.is_linked else calendar_out(calendar)


@router.patch(
    "/{calendar_id}",
    response_model=CalendarOut,
    summary="Update a calendar (claim it, recolor it, toggle sync)",
    description=(
        "Set `claimed_by_user_id` to have a family member claim this calendar — that is what "
        "makes it visible and gives its events that person's color.\n\n"
        "**Claiming a synced calendar switches syncing on, and unclaiming switches it off.** "
        "Wanting somebody's calendar on the wall and wanting it to sync are the same wish, so "
        "they are one action rather than two. Send `sync_enabled` in the same request to "
        "override that — an explicit value always wins."
    ),
)
def update_calendar(
    calendar_id: int, payload: CalendarUpdate, db: Session = Depends(get_db)
) -> CalendarOut:
    cal = _get(db, calendar_id)
    if cal.is_linked:
        calendar_links.output(cal)  # Recheck source membership before reporting its settings.
        raise HTTPException(400, "Manage calendar settings in the original profile.")
    changes = payload.model_dump(exclude_unset=True)
    if cal.is_linked and "sync_enabled" in changes:
        raise HTTPException(400, "Linked calendars use the original calendar sync setting.")
    if cal.is_local and changes.get("sync_enabled"):
        raise HTTPException(400, "Local calendars cannot sync to Google")

    # Claiming and syncing were two switches that always wanted the same answer, and
    # a calendar claimed but left un-synced is the confusing state: it shows a person's
    # name, and no events. Local calendars are left alone -- there is nothing to sync.
    if (
        "claimed_by_user_id" in changes
        and "sync_enabled" not in changes
        and not cal.is_local
        and not cal.is_linked
    ):
        changes["sync_enabled"] = changes["claimed_by_user_id"] is not None

    was_syncing = cal.sync_enabled
    for key, value in changes.items():
        setattr(cal, key, value)
    db.commit()

    # Somebody is watching this screen waiting for that person's events to appear.
    # Waking the pull loop turns a five-minute wait into a couple of seconds.
    if cal.sync_enabled and not was_syncing:
        request_pull()
    db.refresh(cal)
    return calendar_links.output(cal) if cal.is_linked else calendar_out(cal)


@router.delete(
    "/{calendar_id}",
    status_code=204,
    summary="Delete a local calendar",
    description=(
        "Only local calendars can be deleted, along with their events. To stop showing a Google "
        "calendar, unclaim it or set sync_enabled=false instead — that leaves Google untouched."
    ),
)
def delete_calendar(calendar_id: int, db: Session = Depends(get_db)) -> None:
    cal = _get(db, calendar_id)
    if not cal.is_local and not cal.is_linked:
        raise HTTPException(400, "Google calendars cannot be deleted here; unclaim it instead")
    db.delete(cal)
    db.commit()

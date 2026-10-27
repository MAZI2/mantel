"""Google Calendar, expressed as a CalendarProvider.

Everything Google-shaped lives here: its JSON field names, its cancelled-event
convention, and its habit of describing all-day events with plain dates. The
transport itself is still `google_api.GoogleCalendarClient` -- this only
translates.
"""

from datetime import UTC, datetime

from dateutil import parser as dateparser

from ..google_api import GoogleCalendarClient
from ..recurrence import truncate_rule, with_utc_until
from .base import ProviderError, RemoteCalendar, RemoteEvent


class GoogleProvider:
    # Events are requested with singleEvents, so Google hands back the individual
    # occurrences of a series and our copy of the master must stop being drawn.
    expands_recurrence = True
    supports_event_colors = True

    def __init__(self, access_token: str | None = None, client: GoogleCalendarClient | None = None):
        # `client` is how tests substitute a fake without going through a token.
        self._client = client if client is not None else GoogleCalendarClient(access_token or "")
        self._event_colors: dict | None = None

    def list_calendars(self) -> list[RemoteCalendar]:
        return [
            RemoteCalendar(
                id=entry["id"],
                name=entry.get("summary") or "",
                access_role=entry.get("accessRole") or "reader",
            )
            for entry in self._client.list_calendars()
            if entry.get("id")
        ]

    def list_events(
        self,
        calendar_id: str,
        sync_token: str | None = None,
        time_min: str | None = None,
    ) -> tuple[list[RemoteEvent], str | None]:
        items, next_token = self._client.list_events(
            calendar_id, sync_token=sync_token, time_min=time_min
        )
        colors = self._colors() if any(item.get("colorId") for item in items) else {}
        return [_to_remote(item, colors) for item in items if item.get("id")], next_token

    def _colors(self) -> dict:
        # One palette request per provider instance, shared by all events in a pull.
        if self._event_colors is None:
            self._event_colors = self._client.get_colors().get("event", {})
        return self._event_colors

    def create_event(self, calendar_id: str, event: RemoteEvent) -> RemoteEvent:
        return _to_remote(self._client.insert_event(calendar_id, _to_body(event)))

    def update_event(self, calendar_id: str, event: RemoteEvent) -> RemoteEvent:
        return _to_remote(self._client.patch_event(calendar_id, event.id, _to_body(event)))

    def delete_event(self, calendar_id: str, remote_id: str, etag: str | None = None) -> None:
        # Google has no If-Match on this endpoint; the etag is accepted and ignored
        # so the engine can call every provider the same way.
        self._client.delete_event(calendar_id, remote_id)

    def get_series(self, calendar_id: str, series_id: str) -> RemoteEvent:
        return _to_remote(self._client.get_event(calendar_id, series_id))

    def original_start(self, calendar_id: str, remote_id: str) -> datetime | None:
        item = self._client.get_event(calendar_id, remote_id)
        original = item.get("originalStartTime") or {}
        return _parse_dt(original.get("dateTime") or original.get("date"))

    def delete_recurrence(
        self,
        calendar_id: str,
        remote_id: str,
        series_id: str,
        occurrence_start: datetime,
        scope: str,
        all_day: bool,
    ) -> None:
        if scope == "all":
            self._client.delete_event(calendar_id, series_id)
            return
        if remote_id and remote_id != series_id:
            if scope == "this":
                self._client.delete_event(calendar_id, remote_id)
                return
            try:
                instance = self._client.get_event(calendar_id, remote_id)
            except ProviderError as exc:
                if exc.status not in (404, 410):
                    raise
                instance = {}
            original = instance.get("originalStartTime") or {}
            occurrence_start = (
                _parse_dt(original.get("dateTime") or original.get("date")) or occurrence_start
            )
        master = self._client.get_event(calendar_id, series_id)
        start, _, all_day = _parse_times(master)
        if scope == "future" and start and occurrence_start <= start:
            self._client.delete_event(calendar_id, series_id)
            return
        rules = master.get("recurrence") or []
        if not any(rule.startswith("RRULE:") for rule in rules):
            raise ProviderError(
                409, "The Google series no longer has a repeat rule. Sync and try again."
            )
        if scope == "this":
            stamp = occurrence_start.strftime("%Y%m%d" if all_day else "%Y%m%dT%H%M%SZ")
            exclusion = f"EXDATE{';VALUE=DATE' if all_day else ''}:{stamp}"
            if exclusion not in rules:
                rules = [*rules, exclusion]
        else:
            rules = [
                f"RRULE:{truncate_rule(rule[6:], occurrence_start, all_day)}"
                if rule.startswith("RRULE:")
                else rule
                for rule in rules
            ]
            rules = _trim_rdates(rules, occurrence_start, all_day)
        # Patch only recurrence, preserving guests, alarms and provider metadata.
        self._client.patch_event(calendar_id, series_id, {"recurrence": rules})


# ----------------------------- translation -----------------------------------


def _to_remote(item: dict, colors: dict | None = None) -> RemoteEvent:
    if item.get("status") == "cancelled":
        return RemoteEvent(id=item.get("id", ""), deleted=True)

    start, end, all_day = _parse_times(item)
    return RemoteEvent(
        id=item.get("id", ""),
        etag=item.get("etag"),
        title=item.get("summary") or "(no title)",
        description=item.get("description"),
        location=item.get("location"),
        color=(colors or {}).get(str(item.get("colorId")), {}).get("background"),
        start=start,
        end=end,
        all_day=all_day,
        timezone=(item.get("start") or {}).get("timeZone"),
        recurring_event_id=item.get("recurringEventId"),
        original_start=_parse_dt(
            (item.get("originalStartTime") or {}).get("dateTime")
            or (item.get("originalStartTime") or {}).get("date")
        ),
        updated=_parse_dt(item.get("updated")),
        recurrence_rule=next(
            (r[6:] for r in item.get("recurrence", []) if r.startswith("RRULE:")), None
        ),
        exdates=_exdates(item.get("recurrence", [])),
    )


def _to_body(event: RemoteEvent) -> dict:
    if event.all_day:
        start = {"date": event.start.date().isoformat()}
        end = {"date": event.end.date().isoformat()}
    else:
        start = {"dateTime": _iso_utc(event.start)}
        end = {"dateTime": _iso_utc(event.end)}
        if event.timezone or event.recurrence_rule:
            start["timeZone"] = event.timezone or "UTC"
            end["timeZone"] = event.timezone or "UTC"
    body = {
        "summary": event.title,
        "description": event.description,
        "location": event.location,
        "start": start,
        "end": end,
    }
    if event.clear_recurrence:
        body["recurrence"] = []
    if event.recurrence_rule:
        # Google owns the expansion from here. Our pull asks for singleEvents, so
        # what comes back are individual instances -- which is why the master gets
        # hidden from queries once this push succeeds.
        rule = (
            event.recurrence_rule
            if event.all_day
            else with_utc_until(event.recurrence_rule, event.timezone)
        )
        body["recurrence"] = [f"RRULE:{rule}"]
        for moment in event.exdates:
            stamp = moment.strftime("%Y%m%d" if event.all_day else "%Y%m%dT%H%M%SZ")
            body["recurrence"].append(f"EXDATE{';VALUE=DATE' if event.all_day else ''}:{stamp}")
    return body


def _iso_utc(dt: datetime) -> str:
    aware = dt if dt.tzinfo else dt.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = dateparser.isoparse(value)
    return parsed.astimezone(UTC).replace(tzinfo=None) if parsed.tzinfo else parsed


def _parse_times(item: dict) -> tuple[datetime | None, datetime | None, bool]:
    start_obj = item.get("start") or {}
    end_obj = item.get("end") or {}

    if "date" in start_obj:
        # All-day: Google gives plain dates with an exclusive end, which is exactly how
        # they are stored here, so no timezone conversion should happen.
        start = dateparser.isoparse(start_obj["date"])
        end = dateparser.isoparse(end_obj.get("date", start_obj["date"]))
        return start, end, True

    return _parse_dt(start_obj.get("dateTime")), _parse_dt(end_obj.get("dateTime")), False


def _trim_rdates(rules: list[str], cutoff: datetime, all_day: bool) -> list[str]:
    from icalendar import Event as IEvent

    out = []
    for rule in rules:
        if not rule.startswith("RDATE"):
            out.append(rule)
            continue
        component = IEvent.from_ical(f"BEGIN:VEVENT\r\n{rule}\r\nEND:VEVENT\r\n")
        values = component["RDATE"].dts
        header, raw_values = rule.split(":", 1)
        kept = []
        for raw, value in zip(raw_values.split(","), values, strict=True):
            moment = value.dt
            original = (
                datetime.combine(moment, datetime.min.time())
                if not isinstance(moment, datetime)
                else (moment.astimezone(UTC).replace(tzinfo=None) if moment.tzinfo else moment)
            )
            if original < cutoff:
                kept.append(raw)
        if kept:
            out.append(f"{header}:{','.join(kept)}")
    return out


def _exdates(rules: list[str]) -> list[datetime]:
    from icalendar import Event as IEvent

    result = []
    for rule in rules:
        if rule.startswith("EXDATE"):
            component = IEvent.from_ical(f"BEGIN:VEVENT\r\n{rule}\r\nEND:VEVENT\r\n")
            for value in component["EXDATE"].dts:
                moment = value.dt
                result.append(_parse_dt(moment.isoformat()))
    return result

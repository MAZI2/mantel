from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from ..models import AppSetting


def zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        # Old provider data and settings must not make the whole calendar unreadable.
        return ZoneInfo("UTC")


def validate_timezone(name: str | None) -> str | None:
    if name is not None:
        try:
            ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
            raise ValueError("Use an IANA timezone such as Europe/Ljubljana.") from exc
    return name


def home_timezone(db: Session) -> str:
    row = db.get(AppSetting, "home_timezone")
    value = row.value.get("value") if row and isinstance(row.value, dict) else None
    return zone(value).key

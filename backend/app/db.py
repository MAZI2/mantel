from collections.abc import Iterator
from functools import cache
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings
from .profile_context import current_profile

settings = get_settings()
_is_sqlite = settings.database_url.startswith("sqlite")

if _is_sqlite:
    db_path = settings.database_url.split("///", 1)[-1]
    if db_path and db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

engine: Engine = create_engine(
    settings.database_url,
    future=True,
    pool_pre_ping=True,
    connect_args={"check_same_thread": False, "timeout": 30} if _is_sqlite else {},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, connection_record):
    """WAL lets many readers run concurrently with one writer; busy_timeout makes
    competing writers wait and retry instead of raising 'database is locked'."""
    if not _is_sqlite:
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


_legacy_sessions = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


@cache
def profile_sessions(url: str):
    if url == settings.database_url:
        return _legacy_sessions
    path = url.split("///", 1)[-1]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    target = create_engine(
        url, pool_pre_ping=True, connect_args={"check_same_thread": False, "timeout": 30},
    )
    event.listen(target, "connect", _profile_sqlite_pragmas)
    return sessionmaker(bind=target, autoflush=False, expire_on_commit=False, future=True)


def _profile_sqlite_pragmas(connection, record):
    cursor = connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def SessionLocal(**kwargs) -> Session:
    profile = current_profile.get()
    factory = profile_sessions(profile.database_url) if profile else _legacy_sessions
    return factory(**kwargs)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

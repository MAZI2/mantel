"""Server-wide identities and access; each profile's application data lives separately."""

import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    create_engine,
    event,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import get_settings
from .db import _profile_sqlite_pragmas, profile_sessions
from .profile_context import ProfileScope


class RegistryBase(DeclarativeBase):
    pass


class Profile(RegistryBase):
    __tablename__ = "profiles"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    position: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    legacy: Mapped[bool] = mapped_column(Boolean, default=False)


class Principal(RegistryBase):
    __tablename__ = "principals"
    identity: Mapped[str] = mapped_column(String(255), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    default_profile_id: Mapped[str | None] = mapped_column(ForeignKey("profiles.id"))


class PersonalPreference(RegistryBase):
    # The old theme remains a migration seed; defaults here apply across profiles.
    __tablename__ = "personal_preferences"
    identity: Mapped[str] = mapped_column(ForeignKey("principals.identity"), primary_key=True)
    theme: Mapped[str | None] = mapped_column(String(30), nullable=True)
    important_by_default: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class ProfilePreference(RegistryBase):
    __tablename__ = "profile_preferences"
    identity: Mapped[str] = mapped_column(ForeignKey("principals.identity"), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("profiles.id"), primary_key=True)
    theme: Mapped[str | None] = mapped_column(String(30), nullable=True)
    enable_event_linking: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    show_important_counts: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    hold_to_create: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    highlight_important: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    hidden_calendar_ids: Mapped[list[int] | None] = mapped_column(
        JSON(none_as_null=True), nullable=True
    )


class EventPreference(RegistryBase):
    __tablename__ = "event_preferences"
    identity: Mapped[str] = mapped_column(ForeignKey("principals.identity"), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("profiles.id"), primary_key=True)
    calendar_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_key: Mapped[str] = mapped_column(String(1200), primary_key=True)
    important: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class EventReference(RegistryBase):
    """A single live event reference; no private event content is copied."""

    __tablename__ = "event_references"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    destination_profile_id: Mapped[str] = mapped_column(ForeignKey("profiles.id"))
    destination_calendar_id: Mapped[int] = mapped_column(Integer)
    source_profile_id: Mapped[str] = mapped_column(ForeignKey("profiles.id"))
    source_calendar_id: Mapped[int] = mapped_column(Integer)
    event_key: Mapped[str] = mapped_column(String(1200))
    occurrence_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Membership(RegistryBase):
    __tablename__ = "memberships"
    identity: Mapped[str] = mapped_column(ForeignKey("principals.identity"), primary_key=True)
    profile_id: Mapped[str] = mapped_column(ForeignKey("profiles.id"), primary_key=True)


def data_dir() -> Path:
    settings = get_settings()
    if settings.mantel_profile_data_dir:
        return Path(settings.mantel_profile_data_dir)
    if settings.database_url.startswith("sqlite"):
        return Path(settings.database_url.split("///", 1)[-1]).parent
    return Path("/data")


_registry_path = data_dir() / "profile-registry.db"
_registry_path.parent.mkdir(parents=True, exist_ok=True)
registry_engine = create_engine(
    f"sqlite:///{_registry_path}",
    connect_args={"check_same_thread": False, "timeout": 30},
)
event.listen(registry_engine, "connect", _profile_sqlite_pragmas)
RegistrySession = sessionmaker(bind=registry_engine, expire_on_commit=False, autoflush=False)


def scope_for(profile: Profile) -> ProfileScope:
    if profile.legacy:
        return ProfileScope(profile.id, get_settings().database_url, data_dir(), True)
    directory = data_dir() / "profiles" / profile.id
    return ProfileScope(profile.id, f"sqlite:///{directory / 'family.db'}", directory)


def initialise_profile(profile: Profile) -> None:
    from .bootstrap import ensure_defaults
    from .schema_sync import sync

    scope = scope_for(profile)
    factory = profile_sessions(scope.database_url)
    sync(factory.kw["bind"])
    with factory() as db:
        ensure_defaults(db)


def bootstrap_registry() -> None:
    from .schema_sync import sync

    sync(registry_engine, RegistryBase.metadata)
    settings = get_settings()
    identity = settings.mantel_bootstrap_admin_identity
    if not identity and settings.mantel_auth_mode == "local":
        identity = "local-admin"
    with RegistrySession() as db:
        if db.scalar(select(Principal.identity).limit(1)) is not None or not identity:
            return
        profile = Profile(id=uuid.uuid4().hex, name="Personal", legacy=True)
        db.add(profile)
        db.flush()
        db.add(
            Principal(
                identity=identity,
                name="Administrator",
                is_admin=True,
                default_profile_id=profile.id,
            )
        )
        db.flush()
        db.add(Membership(identity=identity, profile_id=profile.id))
        db.commit()


def member_profiles(db, identity: str) -> list[Profile]:
    return list(
        db.scalars(
            select(Profile)
            .join(Membership)
            .where(
                Membership.identity == identity,
                Profile.active.is_(True),
            )
            .order_by(Profile.position, Profile.name, Profile.id)
        )
    )


def active_scopes() -> list[ProfileScope]:
    with RegistrySession() as db:
        return [scope_for(p) for p in db.scalars(select(Profile).where(Profile.active.is_(True)))]

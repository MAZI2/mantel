"""The selected, authorised profile, carried through request and worker contexts."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProfileScope:
    id: str
    database_url: str
    storage_dir: Path
    legacy: bool = False


current_profile: ContextVar[ProfileScope | None] = ContextVar("mantel_profile", default=None)


@contextmanager
def profile_context(profile: ProfileScope):
    token = current_profile.set(profile)
    try:
        yield
    finally:
        current_profile.reset(token)

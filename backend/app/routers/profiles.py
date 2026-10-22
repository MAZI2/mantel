import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select, text

from ..profiles import (
    Membership,
    PersonalPreference,
    Principal,
    Profile,
    ProfilePreference,
    RegistrySession,
    initialise_profile,
    member_profiles,
)

router = APIRouter(tags=["profiles"])


def profile_out(profile: Profile) -> dict:
    return {
        "id": profile.id,
        "name": profile.name,
        "position": profile.position,
        "active": profile.active,
        "legacy": profile.legacy,
    }


@router.get("/session")
def session_info(request: Request) -> dict:
    person = request.state.principal
    with RegistrySession() as db:
        profiles = member_profiles(db, person.identity)
        ids = {p.id for p in profiles}
        default = (
            person.default_profile_id
            if person.default_profile_id in ids
            else (profiles[0].id if profiles else None)
        )
        return {
            "identity": person.identity,
            "name": person.name,
            "is_admin": person.is_admin,
            "default_profile_id": default,
            "profiles": [profile_out(p) for p in profiles],
        }


@router.get("/admin/profiles")
def administration() -> dict:
    with RegistrySession() as db:
        people = list(db.scalars(select(Principal).order_by(Principal.name)))
        memberships = list(db.scalars(select(Membership)))
        return {
            "profiles": [
                profile_out(p)
                for p in db.scalars(select(Profile).order_by(Profile.position, Profile.name))
            ],
            "people": [
                {
                    "identity": p.identity,
                    "name": p.name,
                    "is_admin": p.is_admin,
                    "enabled": p.enabled,
                    "default_profile_id": p.default_profile_id,
                    "profile_ids": [m.profile_id for m in memberships if m.identity == p.identity],
                }
                for p in people
            ],
        }


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    members: list[str] = Field(default_factory=list)


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    position: int | None = Field(default=None, ge=0)
    active: bool | None = None


class PersonWrite(BaseModel):
    identity: str = Field(min_length=1, max_length=255)
    name: str = Field(min_length=1, max_length=100)
    is_admin: bool = False
    enabled: bool = True
    profile_ids: list[str] = Field(default_factory=list)
    default_profile_id: str | None = None

    @field_validator("identity", "name")
    @classmethod
    def trimmed(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("This value cannot be blank.")
        return value.strip()


@router.post("/admin/profiles", status_code=201)
def create_profile(payload: ProfileCreate) -> dict:
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Give the profile a name.")
    with RegistrySession() as db:
        if any(db.get(Principal, identity) is None for identity in payload.members):
            raise HTTPException(400, "Add each person before assigning profile access.")
        position = db.scalar(select(func.max(Profile.position))) or 0
        profile = Profile(id=uuid.uuid4().hex, name=name, position=position + 1, active=True)
        initialise_profile(profile)
        db.add(profile)
        db.flush()
        for identity in set(payload.members):
            db.add(Membership(identity=identity, profile_id=profile.id))
            person = db.get(Principal, identity)
            if person.default_profile_id is None:
                person.default_profile_id = profile.id
        db.commit()
        return profile_out(profile)


@router.patch("/admin/profiles/{profile_id}")
def update_profile(profile_id: str, payload: ProfileUpdate) -> dict:
    with RegistrySession() as db:
        profile = db.get(Profile, profile_id)
        if profile is None:
            raise HTTPException(404, "Profile not found.")
        for key, value in payload.model_dump(exclude_none=True).items():
            if key == "name":
                value = value.strip()
                if not value:
                    raise HTTPException(400, "Give the profile a name.")
            setattr(profile, key, value)
        if payload.active is True:
            initialise_profile(profile)
        db.commit()
        return profile_out(profile)


@router.put("/admin/people/{identity:path}")
def save_person(identity: str, payload: PersonWrite) -> dict:
    if identity != payload.identity:
        raise HTTPException(400, "Person identifiers cannot be changed.")
    if payload.default_profile_id and payload.default_profile_id not in payload.profile_ids:
        raise HTTPException(400, "The default profile must also be assigned to this person.")
    with RegistrySession() as db:
        # Serialize access changes so concurrent edits cannot remove the last admin.
        db.execute(text("BEGIN IMMEDIATE"))
        for profile_id in set(payload.profile_ids):
            profile = db.get(Profile, profile_id)
            if profile is None:
                raise HTTPException(400, "Choose existing profiles for this person.")
        person = db.get(Principal, identity)
        if (
            person
            and person.is_admin
            and person.enabled
            and not (payload.is_admin and payload.enabled)
        ):
            keep_an_administrator(db, identity)
        if person is None:
            person = Principal(identity=identity)
            db.add(person)
        person.name = payload.name
        person.is_admin = payload.is_admin
        person.enabled = payload.enabled
        person.default_profile_id = payload.default_profile_id
        db.flush()
        db.execute(delete(Membership).where(Membership.identity == identity))
        for profile_id in set(payload.profile_ids):
            db.add(Membership(identity=identity, profile_id=profile_id))
        db.commit()
    return {"saved": True}


def keep_an_administrator(db, identity: str) -> None:
    others = db.scalar(
        select(func.count())
        .select_from(Principal)
        .where(
            Principal.is_admin.is_(True),
            Principal.enabled.is_(True),
            Principal.identity != identity,
        )
    )
    if not others:
        raise HTTPException(400, "Keep at least one enabled administrator.")


@router.delete("/admin/people/{identity:path}", status_code=204)
def remove_person(identity: str) -> None:
    """Remove a person's access and preferences, retaining every profile's data."""
    with RegistrySession() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        person = db.get(Principal, identity)
        if person is None:
            raise HTTPException(404, "Person not found.")
        if person.is_admin and person.enabled:
            keep_an_administrator(db, identity)
        db.execute(delete(Membership).where(Membership.identity == identity))
        db.execute(delete(PersonalPreference).where(PersonalPreference.identity == identity))
        db.execute(delete(ProfilePreference).where(ProfilePreference.identity == identity))
        db.delete(person)
        db.commit()

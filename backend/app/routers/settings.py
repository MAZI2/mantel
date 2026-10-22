from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from ..bootstrap import DEFAULT_SETTINGS, THEMES
from ..config import get_settings
from ..db import get_db, profile_sessions
from ..models import AppSetting
from ..profiles import (
    Membership,
    PersonalPreference,
    Principal,
    Profile,
    RegistrySession,
    scope_for,
)
from ..services import google_config, homeassistant

router = APIRouter(prefix="/settings", tags=["settings"])


def personal_theme(identity: str, fallback: str, theme: str | None = None) -> str:
    """Keep a person's theme across profiles; old profile themes seed it only once."""
    with RegistrySession() as registry:
        person = registry.get(Principal, identity)
        if person is None or not person.enabled:
            raise HTTPException(403, "No Mantel access has been assigned to this identity.")
        preference = registry.get(PersonalPreference, identity)
        if theme is not None:
            registry.execute(
                insert(PersonalPreference)
                .values(
                    identity=identity,
                    theme=theme,
                )
                .on_conflict_do_update(index_elements=["identity"], set_={"theme": theme})
            )
        elif preference is not None and preference.theme in THEMES:
            return preference.theme
        else:
            # Visiting a shared link first should preserve the person's previous
            # default-profile appearance, rather than adopt another profile's theme.
            profile = (
                registry.get(Profile, person.default_profile_id)
                if person.default_profile_id
                else None
            )
            if profile and registry.get(Membership, (identity, profile.id)):
                with profile_sessions(scope_for(profile).database_url)() as profile_db:
                    previous = profile_db.get(AppSetting, "theme")
                    if previous and previous.value.get("value") in THEMES:
                        fallback = previous.value["value"]
            registry.execute(
                insert(PersonalPreference)
                .values(
                    identity=identity,
                    theme=fallback if fallback in THEMES else "midnight",
                )
                .on_conflict_do_nothing(index_elements=["identity"])
            )
        registry.commit()
        registry.expire_all()
        return registry.get(PersonalPreference, identity).theme or "midnight"


@router.get(
    "",
    summary="Get app settings",
    description=(
        "Profile preferences, with the signed-in person's own theme. Also reports "
        "read-only server facts under `server`, such as whether Google sync is configured."
    ),
)
def get_app_settings(request: Request, db: Session = Depends(get_db)) -> dict:
    stored = {row.key: row.value.get("value") for row in db.scalars(select(AppSetting))}
    s = get_settings()
    cfg = google_config.load(db)

    values = {**DEFAULT_SETTINGS, **stored}
    values["theme"] = personal_theme(request.state.principal.identity, values["theme"])
    # Secrets are write-only over the API. Reporting whether one is set is enough
    # for the settings screen to render, and means a stored client secret and a
    # Home Assistant token can never be read back out of a settings response.
    values[google_config.CLIENT_SECRET_KEY] = ""
    values["ha_token"] = ""

    return {
        **values,
        "server": {
            "version": s.version,
            "google_configured": cfg.configured,
            "google_client_secret_set": bool(cfg.client_secret),
            "ha_token_set": bool(stored.get("ha_token")),
            "google_redirect_uri": cfg.redirect_uri,
            "sync_enabled": s.sync_enabled,
            "sync_interval_seconds": s.sync_interval_seconds,
        },
    }


@router.patch(
    "",
    summary="Update app settings",
    description=(
        'Send only the keys you want to change, e.g. `{"display_scale": "wall"}`. Unknown '
        "keys are rejected so a typo cannot silently do nothing. `theme` must be one of "
        "`midnight` (default), `daylight` or `hearth`; it applies only to the signed-in person."
    ),
)
def update_app_settings(payload: dict, request: Request, db: Session = Depends(get_db)) -> dict:
    if "hidden_calendar_ids" in payload:
        ids = payload["hidden_calendar_ids"]
        if not isinstance(ids, list) or any(type(value) is not int or value < 1 for value in ids):
            raise HTTPException(400, "hidden_calendar_ids must be a list of calendar ids.")
    unknown = set(payload) - set(DEFAULT_SETTINGS)
    if unknown:
        raise HTTPException(400, f"Unknown settings: {', '.join(sorted(unknown))}")

    if "theme" in payload and payload["theme"] not in THEMES:
        raise HTTPException(
            400, f"Unknown theme {payload['theme']!r}. Choose one of: {', '.join(THEMES)}"
        )

    if "theme" in payload:
        personal_theme(request.state.principal.identity, "midnight", payload.pop("theme"))

    # Encrypted at rest with the same key as the OAuth tokens. An empty string
    # means "leave it alone", so the settings form can post the whole object
    # without a blank field wiping a secret the user never touched.
    if google_config.CLIENT_SECRET_KEY in payload:
        secret = str(payload.pop(google_config.CLIENT_SECRET_KEY) or "")
        if secret:
            google_config.save_secret(db, secret)

    for key, value in payload.items():
        row = db.get(AppSetting, key)
        if row is None:
            db.add(AppSetting(key=key, value={"value": value}))
        else:
            row.value = {"value": value}
    db.commit()
    return get_app_settings(request, db)


@router.post(
    "/test-home-assistant",
    summary="Check the Home Assistant connection",
    description=(
        "Verifies the saved URL and token reach a Home Assistant instance, so a typo "
        "surfaces immediately rather than as silently missing calendar updates weeks later."
    ),
)
def test_home_assistant(db: Session = Depends(get_db)) -> dict:
    stored = {row.key: row.value.get("value") for row in db.scalars(select(AppSetting))}
    ok, message = homeassistant.test_connection(
        str(stored.get("ha_base_url") or ""), str(stored.get("ha_token") or "")
    )
    return {"ok": ok, "message": message}

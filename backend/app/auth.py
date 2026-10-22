"""Verified reverse-proxy identity handoff and per-request profile selection."""

import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .config import get_settings
from .profile_context import current_identity, current_profile
from .profiles import (
    Membership,
    Principal,
    Profile,
    RegistrySession,
    member_profiles,
    scope_for,
)


def authenticated_identity(request: Request) -> str:
    settings = get_settings()
    identity = request.headers.get("X-Mantel-Identity", "").strip()
    supplied_secret = request.headers.get("X-Mantel-Proxy-Secret", "")
    if settings.mantel_auth_mode == "local" and not identity and not supplied_secret:
        return settings.mantel_bootstrap_admin_identity or "local-admin"
    if settings.mantel_auth_mode not in ("local", "proxy"):
        raise HTTPException(503, "Unknown MANTEL_AUTH_MODE. Use proxy in production.")
    if not settings.mantel_proxy_secret:
        raise HTTPException(503, "The certificate proxy handoff is not configured.")
    if not secrets.compare_digest(supplied_secret.encode(), settings.mantel_proxy_secret.encode()):
        raise HTTPException(401, "A verified certificate identity is required.")
    if not identity or len(identity) > 255:
        raise HTTPException(401, "The certificate proxy did not provide a valid person identity.")
    return identity


def check_origin(request: Request) -> None:
    if request.url.path == "/api/accounts/google/callback":
        return  # OAuth has its own signed, person- and profile-bound state.
    origin = request.headers.get("origin")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Cross-site API requests are not allowed.")
    if origin:
        expected = get_settings().public_base_url.rstrip("/")
        if urlsplit(origin).netloc != request.headers.get("host") and origin != expected:
            raise HTTPException(403, "Cross-site API requests are not allowed.")


class ProfileMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith("/api/") or request.url.path == "/api/health":
            return await call_next(request)
        token = None
        identity_token = None
        try:
            check_origin(request)
            # Subscriptions are explicit bearer capabilities, scoped to one profile.
            is_feed = request.url.path.startswith("/api/feeds/") and request.url.path.endswith(
                ".ics"
            )
            if is_feed:
                from .services.crypto import valid_feed_token

                with RegistrySession() as db:
                    profile_id = request.query_params.get("profile")
                    profile = (
                        db.get(Profile, profile_id)
                        if profile_id
                        else db.scalar(select(Profile).where(Profile.legacy.is_(True)))
                    )
                    if profile is None or not profile.active:
                        raise HTTPException(403, "Invalid subscription link.")
                    token = current_profile.set(scope_for(profile))
                    if not valid_feed_token(request.query_params.get("token", "")):
                        raise HTTPException(403, "Invalid subscription link.")
            else:
                identity = authenticated_identity(request)
                identity_token = current_identity.set(identity)
                with RegistrySession() as db:
                    principal = db.get(Principal, identity)
                    if principal is None or not principal.enabled:
                        raise HTTPException(
                            403, "No Mantel access has been assigned to this identity."
                        )
                    request.state.principal = principal
                    is_global = request.url.path == "/api/session" or request.url.path.startswith(
                        "/api/admin/"
                    )
                    if request.url.path.startswith("/api/admin/") and not principal.is_admin:
                        raise HTTPException(403, "Administrator access is required.")
                    if not is_global:
                        profile_id = request.headers.get(
                            "X-Mantel-Profile"
                        ) or request.query_params.get("profile")
                        if request.url.path == "/api/accounts/google/callback":
                            from .services.crypto import read_state

                            state = read_state(request.query_params.get("state", ""))
                            if (
                                not state
                                or state.get("identity") != identity
                                or not state.get("profile_id")
                            ):
                                raise HTTPException(
                                    400,
                                    "The Google link request expired or belongs to another person.",
                                )
                            profile_id = state["profile_id"]
                        available = member_profiles(db, identity)
                        if not profile_id:
                            ids = {p.id for p in available}
                            profile_id = (
                                principal.default_profile_id
                                if principal.default_profile_id in ids
                                else (available[0].id if available else None)
                            )
                        profile = db.get(Profile, profile_id) if profile_id else None
                        if (
                            profile is None
                            or not profile.active
                            or db.get(Membership, (identity, profile.id)) is None
                        ):
                            raise HTTPException(403, "You do not have access to this profile.")
                        token = current_profile.set(scope_for(profile))
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store, private"
            response.headers["Vary"] = "X-Mantel-Identity, X-Mantel-Profile"
            return response
        except HTTPException as exc:
            return JSONResponse(
                {"error": {"code": "access_denied", "message": str(exc.detail)}},
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store, private"},
            )
        finally:
            if token is not None:
                current_profile.reset(token)
            if identity_token is not None:
                current_identity.reset(identity_token)

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import ProfileMiddleware
from .bootstrap import ensure_defaults
from .config import get_settings
from .db import SessionLocal, engine
from .errors import register_error_handlers
from .profiles import active_scopes, bootstrap_registry, initialise_profile
from .routers import (
    accounts,
    calendars,
    dashboard,
    events,
    feeds,
    lists,
    meta,
    photos,
    profiles,
    sync,
    users,
    weather,
)
from .routers import (
    settings as settings_router,
)
from .schema_sync import sync as sync_schema
from .services import scheduler

settings = get_settings()

STATIC_DIR = next(
    (
        p
        for p in (Path("/app/static"), Path(__file__).resolve().parents[2] / "frontend" / "dist")
        if p.is_dir()
    ),
    None,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Creates missing tables AND adds columns added by a newer release, so
    # `git pull && ./run.sh` upgrades an existing database instead of 500ing.
    sync_schema(engine)
    with SessionLocal() as db:
        ensure_defaults(db)
    bootstrap_registry()
    # Upgrades apply to inactive profiles too when they are restored; active ones
    # are ready before requests or background syncing can reach their databases.
    from .profiles import Profile, RegistrySession

    with RegistrySession() as registry:
        for scope in active_scopes():
            initialise_profile(registry.get(Profile, scope.id))
    tasks = scheduler.start(asyncio.get_running_loop())
    try:
        yield
    finally:
        await scheduler.stop(tasks)


app = FastAPI(
    title="Family Calendar API",
    version=settings.version,
    description=(
        "Self-hosted calendar with certificate-proxy authentication and isolated profiles. "
        "Each profile requires membership. Every feature in the UI is backed by an endpoint, so "
        "external tools and AI agents can do anything the app can do.\n\n"
        "See `/api/ai-guide` for a task-oriented guide written for LLM agents."
    ),
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[]
    if settings.mantel_auth_mode == "proxy"
    else [o.strip() for o in settings.cors_origins.split(",")],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ProfileMiddleware)

register_error_handlers(app)

app.include_router(meta.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(calendars.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(accounts.router, prefix="/api")
app.include_router(sync.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(photos.router, prefix="/api")
app.include_router(weather.router, prefix="/api")
app.include_router(lists.router, prefix="/api")
app.include_router(feeds.router, prefix="/api")


if STATIC_DIR:
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        """SPA fallback. index.html is served no-cache so a redeployed build is picked up
        immediately; Vite's content-hashed assets are safe to cache forever."""
        if full_path.startswith("api/"):
            return JSONResponse(
                status_code=404,
                content={"error": {"code": "not_found", "message": "Unknown API route"}},
            )
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_relative_to(STATIC_DIR.resolve()) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(
            STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache, must-revalidate"}
        )

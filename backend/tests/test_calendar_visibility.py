"""Calendar visibility is a server preference for each person within each profile."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import AppSetting
from app.profiles import ProfilePreference, RegistrySession
from tests.test_profiles import headers, setup_shared


def test_calendar_visibility_is_independent_for_people_and_profiles(client):
    personal, shared = setup_shared(client)
    admin_shared = headers("local-admin", shared)
    partner_shared = headers(profile=shared)
    client.patch("/api/settings", json={"hidden_calendar_ids": [1]})
    client.patch(
        "/api/settings",
        headers=partner_shared,
        json={
            "hidden_calendar_ids": [1],
            "theme": "hearth",
            "day_start_hour": 9,
        },
    )
    admin = client.get("/api/settings", headers=admin_shared).json()
    assert admin["hidden_calendar_ids"] == []
    assert admin["theme"] == "midnight"
    assert admin["day_start_hour"] == 9
    client.patch("/api/settings", headers=partner_shared, json={"hidden_calendar_ids": []})
    assert client.get("/api/settings", headers=partner_shared).json()["hidden_calendar_ids"] == []
    assert client.get("/api/settings").json()["hidden_calendar_ids"] == [1]
    client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "profile_ids": [personal, shared],
            "default_profile_id": shared,
        },
    )
    assert (
        client.get("/api/settings", headers=headers(profile=personal)).json()["hidden_calendar_ids"]
        == []
    )
    client.patch(
        "/api/settings", headers=headers(profile=personal), json={"hidden_calendar_ids": [1]}
    )
    assert client.get("/api/settings", headers=partner_shared).json()["hidden_calendar_ids"] == []


def test_calendar_visibility_is_saved_on_the_server_and_available_to_another_device(client):
    _, shared = setup_shared(client)
    selected = headers(profile=shared)
    client.patch("/api/settings", headers=selected, json={"hidden_calendar_ids": [1]})
    with RegistrySession() as registry:
        assert registry.get(ProfilePreference, ("partner", shared)).hidden_calendar_ids == [1]
    # No cookies or browser storage are transferred to this separate client.
    device = TestClient(app)
    try:
        assert device.get("/api/settings", headers=selected).json()["hidden_calendar_ids"] == [1]
        device.patch("/api/settings", headers=selected, json={"hidden_calendar_ids": []})
        assert client.get("/api/settings", headers=selected).json()["hidden_calendar_ids"] == []
    finally:
        device.close()


def test_old_shared_selection_seeds_people_once_and_show_all_stays_personal(client, db):
    _, shared = setup_shared(client)
    db.get(AppSetting, "hidden_calendar_ids").value = {"value": [1]}
    db.commit()
    assert client.get("/api/settings").json()["hidden_calendar_ids"] == [1]
    client.patch("/api/settings", json={"hidden_calendar_ids": []})
    assert client.get("/api/settings").json()["hidden_calendar_ids"] == []
    # Saving a personal choice leaves the old shared value as a migration seed.
    db.expire_all()
    assert db.get(AppSetting, "hidden_calendar_ids").value == {"value": [1]}
    assert (
        client.get("/api/settings", headers=headers("local-admin", shared)).json()[
            "hidden_calendar_ids"
        ]
        == []
    )
    personal = client.get("/api/session").json()["default_profile_id"]
    client.put(
        "/api/admin/people/partner",
        json={
            "identity": "partner",
            "name": "Partner",
            "profile_ids": [personal, shared],
            "default_profile_id": shared,
        },
    )
    assert client.get("/api/settings", headers=headers(profile=personal)).json()[
        "hidden_calendar_ids"
    ] == [1]
    db.get(AppSetting, "hidden_calendar_ids").value = {"value": []}
    db.commit()
    assert client.get("/api/settings", headers=headers(profile=personal)).json()[
        "hidden_calendar_ids"
    ] == [1]
    assert client.get("/api/settings").json()["hidden_calendar_ids"] == []


@pytest.mark.parametrize("invalid", [None, "1", [True], [-1], [0], ["1"]])
def test_invalid_visibility_cannot_change_personal_or_shared_settings(client, invalid):
    client.patch("/api/settings", json={"hidden_calendar_ids": [1], "theme": "hearth"})
    response = client.patch(
        "/api/settings",
        json={
            "hidden_calendar_ids": invalid,
            "theme": "daylight",
            "day_start_hour": 3,
        },
    )
    assert response.status_code == 400
    saved = client.get("/api/settings").json()
    assert saved["hidden_calendar_ids"] == [1] and saved["theme"] == "hearth"
    assert saved["day_start_hour"] != 3

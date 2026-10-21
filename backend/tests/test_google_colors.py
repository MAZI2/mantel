import httpx

from app.services.google_api import GoogleCalendarClient
from app.services.providers.google import GoogleProvider


def test_google_event_colours_come_from_the_event_palette_once_per_batch():
    requests = []

    def google(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer test-token"
        if request.url.path.endswith("/colors"):
            return httpx.Response(200, json={
                "calendar": {"5": {"background": "#000000"}},
                "event": {"5": {"background": "#123abc", "foreground": "#ffffff"}},
            })
        return httpx.Response(200, json={"items": [
            {"id": "one", "colorId": "5", "start": {"date": "2026-08-03"},
             "end": {"date": "2026-08-04"}},
            {"id": "two", "colorId": "5", "start": {"date": "2026-08-03"},
             "end": {"date": "2026-08-04"}},
        ], "nextSyncToken": "next"})

    with httpx.Client(transport=httpx.MockTransport(google)) as http:
        provider = GoogleProvider(client=GoogleCalendarClient("test-token", http=http))
        events, token = provider.list_events("primary")
        assert token == "next"
        assert [event.color for event in events] == ["#123abc", "#123abc"]
        provider.list_events("primary", sync_token=token)
    assert sum(request.url.path.endswith("/colors") for request in requests) == 1


def test_google_does_not_request_a_palette_for_events_without_a_colour():
    def google(request):
        assert not request.url.path.endswith("/colors")
        return httpx.Response(200, json={"items": [
            {"id": "default", "start": {"date": "2026-08-03"},
             "end": {"date": "2026-08-04"}},
            {"id": "deleted", "status": "cancelled"},
        ]})

    with httpx.Client(transport=httpx.MockTransport(google)) as http:
        provider = GoogleProvider(client=GoogleCalendarClient("test-token", http=http))
        events, _ = provider.list_events("primary")
    assert events[0].color is None
    assert events[1].deleted

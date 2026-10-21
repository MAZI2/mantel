"""Which provider serves which linked account."""

from sqlalchemy.orm import Session

from ...models import LinkedAccount
from ..google_oauth import access_token_for
from ..timezones import home_timezone
from .base import CalendarProvider
from .google import GoogleProvider


def for_account(db: Session, account: LinkedAccount) -> CalendarProvider:
    """Builds a ready-to-use provider, refreshing credentials if that is needed.

    Google is the default rather than an explicit branch: every account predating
    the iCloud release has `provider="google"`, and so does anything that somehow
    arrives without one.
    """
    if account.provider == "icloud":
        from .. import icloud_auth
        from .icloud import ICloudProvider

        client = icloud_auth.client_for(account)
        home = icloud_auth.calendar_home_for(db, account, client)
        return ICloudProvider(client, home, home_timezone(db))
    return GoogleProvider(access_token_for(db, account))

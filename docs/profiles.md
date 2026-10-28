# Profiles and certificate proxy handoff

Mantel owns people, administrator roles, memberships and default profiles. Your
certificate layer authenticates the person and supplies these headers on **every
API request**, including Google OAuth callbacks and photo downloads:

| Header | Value |
| --- | --- |
| `X-Mantel-Identity` | Stable person identifier, for example `matjaz` or `partner`. Keep it unchanged when renewing certificates. Do not use a certificate fingerprint. |
| `X-Mantel-Proxy-Secret` | Random server-only secret matching `MANTEL_PROXY_SECRET`. |

Nginx must overwrite both incoming headers, derive the identity from the verified
certificate mapping, and reject unverified certificates. Keep the backend port
reachable only by this trusted proxy. Do not expose the shared secret to browser
JavaScript, URLs or public configuration. TLS/certificate issuance and Nginx
configuration are handled separately; this change implements the app side.

Set these in the production `.env` before deploying, then rebuild/recreate with
your normal deployment script:

```dotenv
MANTEL_AUTH_MODE=proxy
MANTEL_PROXY_SECRET=<same random server-only secret as Nginx>
MANTEL_BOOTSTRAP_ADMIN_IDENTITY=<your stable person ID>
PUBLIC_BASE_URL=https://calendar.mpog.dev
```

Keep your existing `SECRET_KEY`, database and volume. The default mode is `proxy`;
missing/incorrect secrets fail closed. `/api/health` remains public for container
health checks. The local preview uses `MANTEL_AUTH_MODE=local` on localhost and a
disposable database; do not use local mode on the server. Local mode recognizes
identity headers only when accompanied by the configured proxy secret.

## Existing data and first setup

At first startup, Mantel assigns the existing database, events, connections,
photos and settings to a **Personal** profile owned by the bootstrap administrator.
It does not copy or move the original database. Bootstrap runs only while there
are no registered people; changing the environment variable later does not grant
new administrator rights or reset existing roles.

In **Settings → Profiles**:

1. Rename Personal and your administrator display name if desired.
2. Create Shared, assigning yourself as a member.
3. Add your girlfriend using her stable proxy identity. Assign only Shared and
   select Shared as her default profile. Leave Administrator unchecked.
4. Keep Personal as your own default, with membership in both Personal and Shared.

Adding a person never creates a personal profile. If she later wants one, create
it and assign it explicitly. An enabled person without memberships sees a
“No profiles assigned” screen. An unknown or disabled identity has no access.

The bottom row shows only the person's assigned active profiles, followed by
Settings on the right. Opening `/` uses their default profile. A `?profile=<id>`
link selects an assigned profile directly. Switching profiles stays within the app,
with a fresh query cache and requests bound to the selected profile. Its settings,
calendar and appearance are loaded before revealing the new view. The top calendar dropdown controls
multiple calendars at once; those choices are saved per person within the selected
profile, persist across devices and do not change what another member sees.

## What a profile contains

Each profile has separate events, calendar owners (the Family settings tab),
calendars, Google/iCloud connections, OAuth configuration, screensaver
photos, weather and other settings. New profiles start with fresh defaults and a
local Family calendar, without copying anyone's events or linked accounts.
Server environment defaults, including any legacy Google client configuration,
may seed fresh defaults; connected account tokens are never copied.

All members can edit shared events and settings inside a profile. Colour theme,
calendar visibility and event importance are personal: the existing **Settings → Display → Colour theme**
control saves to the signed-in person's preferences for the selected profile, across devices.
Other members keep their own theme, and each person can choose different themes
for different profiles. On upgrade, the previous personal theme seeds each profile;
where no personal theme exists, that profile's old theme seeds the preference.
Later theme changes never change shared settings or another profile's appearance.
Calendar visibility starts from the previous shared selection on first use, then
saves independently for each person and profile. Personal preferences live in the
access registry. Tapping Settings while it is open returns to the selected profile's week calendar.

The calendar toolbar shows **Sync now** only while the selected profile has a
linked Google account. An iCloud-only or local-only profile has no toolbar sync
button; manual sync remains available in Settings.

Administrator status allows managing access but does not bypass profile membership. Google linking
records both the initiating person and profile in signed state; its callback
returns to that profile even if another tab has changed profiles. Configure the
same callback URL in Google as before:
`https://calendar.mpog.dev/api/accounts/google/callback`.

Archiving a profile removes it from everyone's available profiles and pauses its
background sync while retaining data. Restoring makes its memberships available
again. **Remove person** in Settings → Profiles deletes that person's memberships,
personal preferences and access, while retaining all profile events, connections
and settings. Removing a membership, disabling a person or removing them blocks
subsequent API calls; open screens recheck access on focus and every 30 seconds. Mantel prevents
removing or disabling the last enabled administrator.

## Storage and backups

The default volume contains:

- `/data/family.db` and `/data/photos/`: existing personal profile, unchanged.
- `/data/profile-registry.db`: people, roles, profile names, memberships and personal preferences.
- `/data/profiles/<profile-id>/family.db` and `photos/`: each new profile's data.

The registry and new profile directories live alongside `DATABASE_URL`, or under
`MANTEL_PROFILE_DATA_DIR` if explicitly configured. Back up the **whole data
volume** and your `SECRET_KEY`; stopping the app before copying provides a
consistent backup of SQLite databases and their WAL files. Continue using one
application worker as before.

Private API responses and images use `Cache-Control: no-store, private`. The
service worker caches public app assets only and removes private caches left by
older releases. Already loaded screens can retain their current schedule in
memory during a network interruption; a new page requires an authorized network
connection.

Read-only ICS subscription links carry profile-specific bearer tokens; sharing a
link grants read access to that profile independently of memberships. Archive
the profile to stop its feed, or rotate `SECRET_KEY` to invalidate all feed links
(and require reconnecting integrations). The proxy may require certificates for
feeds too; choosing to expose bearer feed links is part of its configuration.

## App API

`GET /api/session` returns the authenticated person, default profile and available
profiles. For profile data, send `X-Mantel-Profile: <profile-id>` or `?profile=<id>`;
the default is used if neither is supplied. All identifiers are checked against
memberships before the profile database is opened.

Administrator endpoints:

- `GET /api/admin/profiles`: all profile metadata and people/access assignments.
- `POST /api/admin/profiles`: `{ "name": "Shared", "members": ["matjaz"] }`.
- `PATCH /api/admin/profiles/<id>`: name, nonnegative position or active status.
- `PUT /api/admin/people/<identity>`: identity, name, enabled, is_admin,
  profile_ids and default_profile_id. The identity cannot be renamed.
- `DELETE /api/admin/people/<identity>`: remove the person and their access, retaining
  profile data. The last enabled administrator cannot be removed.

The browser sends only the selected profile ID. The certificate proxy supplies
the verified identity and secret, including on these administration requests.

## Personal event importance

**Settings → Display → Important by default** starts enabled and belongs to the
signed-in person across all profiles. It supplies the initial mark for new events
and events that person has not seen before. Changing the default leaves existing
personal marks unchanged. **Important for me** in event details or the event editor
changes only that person's mark, including on shared or read-only calendars.
A recurring series shares one personal mark across its occurrences. Marks survive
provider sync and full resync, and follow moves between calendars in the same profile.

The star beside Settings dims events you have not marked important to **25% opacity**,
including all-day events. It does not hide or disable them. The star state belongs
to the person and selected profile and persists across devices.

## Calendars linked from other profiles

In **Settings → Calendars**, choose **Add calendar from another profile**. The list
contains original calendars in your other active profiles. The link uses the
original events directly: changes, creation and deletion from either profile
update that calendar, and its original Google/iCloud connection continues syncing.
The original calendar names, colours and permissions are retained; manage its
calendar settings in the original profile. Removing a link keeps the source
calendar and events. To move an event between calendars, use its original profile.

Every read and write requires the person to belong to **both** profiles. Other
members of the destination who lack source membership cannot see the calendar,
its metadata or events. Revoking either membership or archiving a profile blocks
further linked access. Links cannot be nested, and they do not copy credentials
or unrelated source calendars. A person's importance mark refers to the same
event whether opened in the original profile or through a link; the star state
and visible-calendar selection remain separate for each profile.

Subscription feeds exclude linked calendars: a destination-profile bearer token
must not grant source-profile access. Subscribe from the original profile instead.

### Individual event links and optional interactions

In Display settings, **Link events to other calendars** enables **Add to another calendar**
in event details. It is off by default and personal within the selected profile. The
chosen destination receives a live reference inside Mantel, without copying provider
credentials or creating an event in the destination Google/iCloud account. Reading or
editing the reference always requires access to both profiles. Editing/deleting follows
the original event. A recurring event links the selected occurrence; its reference
follows scoped edits of that occurrence. Bearer feeds exclude these references.

**Hold and drag to create or move events** is also personal per profile and off by default.
A stationary hold on an empty time-grid spot arms a live duration selection. Holding
an editable event instead moves it while preserving its duration, including all-day
events. Recurring moves ask which occurrences to change. The personal **Long press
delay (ms)** setting applies to both actions, defaults to 750 ms and accepts 100–10000 ms.
Scrolling before the hold completes cancels it. Dragging can span days and auto-scrolls
near the timeline edges. Releasing opens the editor with both dates/times filled in.

The editor leaves the keyboard closed until an input is tapped, puts optional fields
under More, and asks which occurrences to change when saving a recurring event. The optional day-header count includes important visible timed and all-day events
overlapping that day. It is personal per profile, off by default, and shown only for
positive counts. The active profile button opens a compact calendar-visibility drop-up;
clicking another profile switches to it. Normal empty-grid clicks do nothing; use the
top-bar + button or enable hold-and-drag to create an event.

Individual references can also appear through imported calendars. Their IDs remain
opaque, and access is checked against the viewing profile, the imported calendar's
profile and the original event's profile. A Google-origin event stays linked to its
original resource: destination views create no additional Google event or connection;
edits go through the original profile's normal provider queue. Unavailable references
are isolated, and event loading errors leave the calendar shell, Settings and Retry
available. Positive important-event counts use a larger number on a blue circular badge.

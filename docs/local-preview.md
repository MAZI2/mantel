# Local preview on Arch Linux

Install Docker, Compose and Buildx (`sudo pacman -S docker docker-compose docker-buildx`),
start Docker (`sudo systemctl enable --now docker`) and ensure your user can run
`docker info`. Node, Python packages and browser test dependencies stay inside Docker.

From this checkout:

```bash
./local.sh up       # build current edits and open http://localhost:8081 yourself
./local.sh test     # rebuild, run frontend/backend checks and Chromium regression tests
./local.sh logs     # follow preview logs; Ctrl-C leaves the preview running
./local.sh stop     # stop temporarily, preserving test data
./local.sh clean    # delete this preview's containers, data, images and build cache
```

Run `./local.sh up` after each change attempt, then refresh the browser. The preview
starts on the current week. Add disposable events through the UI to try your layout;
they survive rebuilds until cleanup. `LOCAL_PORT=8091 ./local.sh up` selects another
port if needed (use the same value for subsequent commands).

**Settings → Display → Day starts / ends** controls the visible hours in the week
grid. Existing saved hours are respected; a fresh database defaults to 07:00–22:00.
Choose 00:00–24:00 if you want the entire day.

New events default to one hour. The event dialog's **Event colour** controls apply
to that event in Mantel; **Default colour** restores its imported Google event colour,
series colour or calendar colour. After upgrading, the next sync also fetches colours
for existing Google events in the configured sync window.

The separate Compose project binds only to localhost. It uses a fresh named database
volume, ignores the production `.env`, and disables calendar sync and release checks.
Browser tests mock calendar data and settings, with a disposable local calendar for
event-saving checks that is removed afterwards. They do not modify your preview events.
Tests use Europe/Ljubljana time and cover overnight week rollover, including DST.
No host `node_modules`, Python virtualenv or browser profiles are created.

Keep the preview running while reviewing changes. When you say **commit**, run the
checks, commit the agreed changes, then run `./local.sh clean`. This removes only the
`mantel-local-preview` project, its images and its dedicated Buildx builder/cache; it
does not prune Docker globally or touch other projects. These scripts stay in the repo
for the next round. The Raspberry Pi deployment commands stay the same.

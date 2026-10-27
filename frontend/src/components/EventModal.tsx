import { useQuery } from '@tanstack/react-query'
import { useApi } from '../api/client'
import { RecurringEditChoices } from './RecurringEditChoices'
import { RecurringDeleteChoices } from './RecurringDeleteChoices'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCalendars, useCreateEvent, useDeleteEvent, useSettings, useUpdateEvent, useUsers } from '../api/hooks'
import type { CalendarEvent, DeletionScope } from '../api/types'
import { calendarLabel, providerPossessive } from '../api/providers'
import { pickableCalendars } from './pickableCalendars'
import { moveNote } from './moveNote'
import { calendarsForProfile, initialSelection, profilesWithCalendars } from './eventProfiles'
import { rememberLastTarget } from './lastEventTarget'
import { allDayEndFor, allDayInput, DEFAULT_MINUTES, endFor, toLocalInput, utcMidnight } from './eventTimes'
import { acquireReloadGuard } from '../hooks/useVersionPoll'
import { type Freq, RecurrencePicker, buildRule, parseRule } from './RecurrencePicker'
import { PALETTE } from '../views/settings/palette'

interface Props {
  event: CalendarEvent | null
  defaultStart: Date | null
  defaultEnd?: Date | null
  onClose: () => void
}


export function EventModal({ event, defaultStart, defaultEnd, onClose }: Props) {
  const { data: settings } = useSettings()
  const [important, setImportant] = useState(event?.important ?? settings?.important_by_default ?? true)
  const { data: calendars = [] } = useCalendars()
  const { data: users = [] } = useUsers()
  const create = useCreateEvent()
  const update = useUpdateEvent()
  const remove = useDeleteEvent()
  const [choosingEdit, setChoosingEdit] = useState(false)
  const api = useApi()
  const context = useQuery({ queryKey: ['event-edit-context', event?.id], enabled: !!event?.recurring,
    queryFn: () => api.get<{ recurrence_rule: string | null }>(`/events/${event!.id}/edit-context`) })
  const [repeatChanged, setRepeatChanged] = useState(false)
  const [choosingDelete, setChoosingDelete] = useState(false)

  const isNew = event === null
  const readOnly = event !== null && !event.editable
  // One occurrence of a series is its own row at the provider, and the server refuses to
  // move those independently between calendars.
  const isOccurrence = !!event?.recurring && !event.recurrence_rule
  const isLinked = !!event?.linked_event || (!!event && !!calendars.find((calendar) => calendar.id === event.calendar_id)?.source_profile_id)
  const calendarLocked = readOnly || isOccurrence || isLinked

  // Only calendars that can actually carry an event -- see pickableCalendars for why a
  // switched-off synced calendar would swallow one silently.
  const writable = pickableCalendars(calendars)
  const choices = isNew ? writable : pickableCalendars(calendars, event.calendar_id)
    .filter((calendar) => !calendar.source_profile_id || calendar.id === event.calendar_id)

  const [title, setTitle] = useState(event?.title ?? '')
  const [location, setLocation] = useState(event?.location ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [colorOverride, setColorOverride] = useState<string | null>(event?.color_override ?? null)
  const [allDay, setAllDay] = useState(event?.all_day ?? false)
  // Whose event is this? Chosen first, because it is the question somebody actually
  // has in mind -- the calendar is a consequence of it. Derived from the event's own
  // calendar when editing, so an existing event opens showing the truth.
  const start0 = initialSelection(choices, users, event?.calendar_id ?? null)
  const [profileId, setProfileId] = useState<number | null>(start0.profileId)
  const [calendarId, setCalendarId] = useState<number | null>(start0.calendarId)

  const profiles = profilesWithCalendars(choices, users)
  const profileCalendars = calendarsForProfile(choices, profileId)
  const note = isNew
    ? null
    : moveNote(
        calendars.find((c) => c.id === event.calendar_id),
        calendars.find((c) => c.id === calendarId),
      )
  const [start, setStart] = useState(
    event?.all_day ? allDayInput(event.start_at)
      : toLocalInput(event ? new Date(event.start_at) : (defaultStart ?? new Date())),
  )
  const [end, setEnd] = useState(
    event?.all_day ? allDayInput(event.end_at, true) : toLocalInput(
      event
        ? new Date(event.end_at)
        : defaultEnd ?? new Date((defaultStart ?? new Date()).getTime() + DEFAULT_MINUTES * 60_000),
    ),
  )
  // An existing event's end was chosen by somebody; a new one's is only a default.
  const [endEdited, setEndEdited] = useState(!isNew || !!defaultEnd)
  const [error, setError] = useState<string | null>(null)
  const [repeatSelection, setRepeat] = useState<ReturnType<typeof parseRule> | null>(null)
  const originalRule = context.data?.recurrence_rule ?? event?.recurrence_rule
  const repeat = repeatSelection ?? parseRule(originalRule)

  useEffect(() => {
    // Calendars arrive after the first render, so the opening choice has to be made
    // again once they do.
    if (calendarId === null && choices.length > 0) {
      const pick = initialSelection(choices, users, event?.calendar_id ?? null)
      setProfileId(pick.profileId)
      setCalendarId(pick.calendarId)
    }
  }, [choices, users, calendarId, event])

  // Hold off the kiosk auto-reload while someone is mid-edit.
  useEffect(() => acquireReloadGuard(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const busy = create.isPending || update.isPending || remove.isPending

  const submit = async (scope?: DeletionScope) => {
    setError(null)
    if (!title.trim()) return setError('Give the event a title.')
    if (calendarId === null) return setError('No writable calendar available.')
    if (!start || !end) return setError('Choose a start and end date.')
    const startISO = allDay ? utcMidnight(start, 0) : new Date(start).toISOString()
    const endISO = allDay ? utcMidnight(end, 1) : new Date(end).toISOString()
    if (endISO <= startISO) return setError('The end time must be after the start time.')

    if (event?.recurring && !scope) { setChoosingEdit(true); return }
    const body = {
      calendar_id: calendarId,
      important,
      title: title.trim(),
      location: location.trim() || null,
      description: description.trim() || null,
      color_override: colorOverride,
      start_at: startISO,
      end_at: endISO,
      all_day: allDay,
      timezone: allDay ? null : event?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      recurrence_rule: repeatChanged || isNew ? buildRule(repeat.freq as Freq, repeat.byday, repeat.until) : originalRule,
      ...(scope ? { edit_scope: scope, occurrence_start: event!.original_start_at || event!.start_at } : {}),
    }
    try {
      if (isNew) {
        await create.mutateAsync(body)
        // Remembered only once it is actually used, so idly opening the dialog and
        // cancelling does not change where the next event goes.
        rememberLastTarget(profileId, calendarId)
      } else {
        await update.mutateAsync({ id: event.id, ...body })
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the event.')
    }
  }

  const destroy = async (scope?: DeletionScope) => {
    if (!event) return
    try {
      await remove.mutateAsync(scope ? {
        id: event.id, scope, occurrence_start: event.original_start_at || event.start_at,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      } : event.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the event.')
    }
  }

  // Rendered at the top of the document, not inside the app shell. The shell carries
  // a transform for burn-in shift, and a transformed ancestor makes `position: fixed`
  // resolve against *it* instead of the viewport -- so the dialog was being positioned
  // and sized relative to a box that itself moves with the keyboard. That is the
  // floating, and the scrolling that worked only sometimes.
  return createPortal(
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal__title">{isNew ? 'New event' : readOnly ? 'Event' : 'Edit event'}</h2>

        {readOnly && (
          <p className="modal__note">
            This calendar is read-only in{' '}
            {providerPossessive(calendars.find((c) => c.id === event.calendar_id)?.account_provider)}
            , so it can't be changed here.
          </p>
        )}

        {event?.recurring && !event.recurrence_rule && (
          <p className="modal__note">
            This is one occurrence of a repeating event. Choose which occurrences to update when you save.
          </p>
        )}
        {event?.recurrence_text && (
          <p className="modal__note">{event.recurrence_text}</p>
        )}

        <label className="field">
          <span>Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={readOnly}
            placeholder="Soccer practice"
          />
        </label>

        <div className="event-flags">
          <label className="toggle">
            <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} disabled={readOnly} />
            Important for me
          </label>
          <label className="toggle">
            <input type="checkbox" checked={allDay} disabled={readOnly} onChange={() => {
              if (allDay) {
                setStart(start ? `${start}T00:00` : '')
                setEnd(end ? `${utcMidnight(end, 1).slice(0, 10)}T00:00` : '')
              } else {
                setStart(start.slice(0, 10))
                setEnd(end.slice(0, 10))
              }
              setEndEdited(true)
              setAllDay(!allDay)
            }} />
            All day
          </label>
        </div>
        {isLinked && <p className="modal__note">Edits update the original calendar. Move events between calendars from the original profile.</p>}

        <label className="field">
          <span>Calendar</span>
          <select
            aria-label="Calendar"
            value={calendarId ?? ''}
            onChange={(e) => setCalendarId(Number(e.target.value))}
            disabled={calendarLocked}
          >
            {profileCalendars.map((c) => (
              <option key={c.id} value={c.id}>
                {calendarLabel(c)}
              </option>
            ))}
          </select>
        </label>

        {/* role=status so a screen reader announces the move as soon as it is chosen. */}
        {note && (
          <p className="modal__note" role="status">
            {note}
          </p>
        )}

        <fieldset className="event-colour" disabled={readOnly}>
          <legend>Event colour</legend>
          <div className="event-colour__choices">
            <button type="button" className="event-colour__swatch"
              style={{ background: event?.remote_color ?? choices.find((c) => c.id === calendarId)?.color ?? '#3b82f6' }}
              aria-label="Default event colour" title="Default colour" aria-pressed={colorOverride === null}
              onClick={() => setColorOverride(null)} />
            {PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                className="event-colour__swatch"
                style={{ background: color }}
                aria-label={`Event colour ${color}`}
                aria-pressed={colorOverride === color}
                onClick={() => setColorOverride(color)}
              />
            ))}
            <label className="event-colour__more" title="More colours">
              <span aria-hidden="true">+</span>
              <input
                type="color"
                className="event-colour__custom"
                aria-label="Custom event colour"
                value={colorOverride ?? event?.remote_color ?? choices.find((c) => c.id === calendarId)?.color ?? '#3b82f6'}
                onChange={(e) => setColorOverride(e.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <div className="field field--row">
          <label className="field">
            <span>Starts</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={start}
              onChange={(e) => {
                const next = e.target.value
                setStart(next)
                setEnd(allDay ? allDayEndFor(next, start, end) : endFor(next, start, end, endEdited))
              }}
              disabled={readOnly}
            />
          </label>
          <label className="field">
            <span>Ends</span>
            <input
              type={allDay ? 'date' : 'datetime-local'}
              value={end}
              onChange={(e) => {
                setEnd(e.target.value)
                setEndEdited(true)
              }}
              disabled={readOnly}
            />
          </label>
        </div>

        <details className="event-more">
          <summary>More</summary>
          <label className="field">
            <span>Who is this for?</span>
            <select
              aria-label="Who is this for?"
              value={profileId ?? ''}
              onChange={(e) => {
                const next = e.target.value === '' ? null : Number(e.target.value)
                setProfileId(next)
                // Their calendars are a different set, so the old choice may not be in
                // it. Land on their first one rather than leaving a stale selection.
                setCalendarId(calendarsForProfile(choices, next)[0]?.id ?? null)
              }}
              disabled={calendarLocked}
            >
              {profiles.map((p) => (
                <option key={p.id ?? 'household'} value={p.id ?? ''}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <RecurrencePicker
            freq={repeat.freq}
            byday={repeat.byday}
            until={repeat.until}
            start={new Date(allDay ? `${start}T00:00` : start)}
            disabled={readOnly}
            onChange={(value) => { setRepeat(value); setRepeatChanged(true) }}
          />

          <label className="field">
            <span>Location</span>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={readOnly}
              placeholder="Riverside Park"
            />
          </label>

          <label className="field">
            <span>Notes</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={readOnly}
              rows={2}
            />
          </label>

        </details>

        {context.error && <p role="alert">Could not load the repeat rule. <button onClick={() => void context.refetch()}>Retry</button></p>}
        {error && <p className="modal__error">{error}</p>}

        {choosingDelete && <RecurringDeleteChoices busy={busy}
          onChoose={(scope) => void destroy(scope)} onCancel={() => setChoosingDelete(false)} />}
        {choosingEdit && <RecurringEditChoices busy={busy} onChoose={(scope) => void submit(scope)} onCancel={() => setChoosingEdit(false)} />}
        {!choosingDelete && !choosingEdit && <div className="modal__actions">
          {!isNew && !readOnly && (
            <button className="btn btn--danger" onClick={() => event?.recurring ? setChoosingDelete(true) : void destroy()} disabled={busy}>
              Delete
            </button>
          )}
          <div className="modal__spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button className="btn btn--primary" onClick={() => void submit()} disabled={busy || (!!event?.recurring && !context.isSuccess)}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>}
      </div>
    </div>
  ,
    document.body,
  )
}

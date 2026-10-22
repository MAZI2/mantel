import { RecurringDeleteChoices } from './RecurringDeleteChoices'
import { format, isSameDay } from 'date-fns'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useCalendars, useDeleteEvent, useSettings, useUsers } from '../api/hooks'
import { calendarLabel } from '../api/providers'
import type { CalendarEvent, DeletionScope } from '../api/types'
import { acquireReloadGuard } from '../hooks/useVersionPoll'
import { allDayInput } from './eventTimes'
import { EventModal } from './EventModal'

interface Props {
  event: CalendarEvent | null
  defaultStart: Date | null
  onClose: () => void
}

/** Existing events open as details; empty slots still open the creation form. */
export function EventDialog({ event, defaultStart, onClose }: Props) {
  const [editing, setEditing] = useState(false)
  return event && !editing ? (
    <EventDetails event={event} onEdit={() => setEditing(true)} onClose={onClose} />
  ) : (
    <EventModal event={event} defaultStart={defaultStart} onClose={onClose} />
  )
}

function EventDetails({ event, onEdit, onClose }: {
  event: CalendarEvent
  onEdit: () => void
  onClose: () => void
}) {
  const { data: settings } = useSettings()
  const { data: calendars = [] } = useCalendars()
  const { data: users = [] } = useUsers()
  const remove = useDeleteEvent()
  const [choosingDelete, setChoosingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const calendar = calendars.find((c) => c.id === event.calendar_id)
  const person = users.find((u) => u.id === event.user_id)
  const busy = remove.isPending

  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => acquireReloadGuard(), [])
  useEffect(() => {
    if (busy) card.current?.focus()
  }, [busy])

  const keyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!busy) onClose()
    }
    if (e.key !== 'Tab') return
    const buttons = card.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    if (!buttons?.length) {
      e.preventDefault()
      return
    }
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const destroy = async (scope?: DeletionScope) => {
    setError(null)
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

  return createPortal(
    <div className="modal" onClick={() => !busy && onClose()} onKeyDown={keyDown}
      role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}>
      <div className="modal__card event-details" ref={card} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="event-details__header">
          <span className="event-details__colour" style={{ background: event.color }} aria-hidden="true" />
          <h2 id={titleId} className="event-details__title">{event.title}</h2>
          <button ref={close} className="iconbtn" aria-label="Close event details" onClick={onClose} disabled={busy}>×</button>
        </header>

        <dl className="event-details__facts">
          <div><dt>When</dt><dd>{when(event, settings?.time_format_24h ?? false)}</dd></div>
          <div><dt>Calendar</dt><dd>{calendar ? calendarLabel(calendar) : event.calendar_name}</dd></div>
          {person && <div><dt>Who</dt><dd>{person.name}</dd></div>}
          {event.location && <div><dt>Location</dt><dd>{event.location}</dd></div>}
          {event.recurring && <div><dt>Repeats</dt><dd>{event.recurrence_text || 'Repeating event'}</dd></div>}
        </dl>
        {event.description && <p className="event-details__notes">{event.description}</p>}
        {!event.editable && <p className="modal__note">This calendar is read-only.</p>}
        {error && <p className="modal__error" role="alert">{error}</p>}

        {event.editable && choosingDelete && <RecurringDeleteChoices busy={busy}
          onChoose={(scope) => void destroy(scope)} onCancel={() => setChoosingDelete(false)} />}
        {event.editable && !choosingDelete && (
          <div className="modal__actions">
            <button className="btn btn--danger" onClick={() => event?.recurring ? setChoosingDelete(true) : void destroy()} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
            <div className="modal__spacer" />
            <button className="btn btn--primary" onClick={onEdit} disabled={busy}>Edit</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

function when(event: CalendarEvent, use24h: boolean): string {
  // Date-only events must not move to the previous day west of UTC. Their stored
  // end is exclusive, while the popup names the last date somebody attends.
  const start = event.all_day ? new Date(`${allDayInput(event.start_at)}T00:00`) : new Date(event.start_at)
  const end = event.all_day ? new Date(`${allDayInput(event.end_at, true)}T00:00`) : new Date(event.end_at)
  const date = (d: Date) => format(d, 'EEE, d MMM yyyy')
  if (event.all_day) {
    return `${isSameDay(start, end) ? date(start) : `${date(start)} – ${date(end)}`} · All day`
  }
  const time = (d: Date) => format(d, use24h ? 'HH:mm' : 'h:mma').toLowerCase()
  return isSameDay(start, end)
    ? `${date(start)} · ${time(start)} – ${time(end)}`
    : `${date(start)} ${time(start)} – ${date(end)} ${time(end)}`
}

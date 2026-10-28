import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { RecurringEditChoices } from '../../components/RecurringEditChoices'
import { addDays, format, isSameMonth, startOfWeek } from 'date-fns'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAccounts, useEvents, useSettings, useSyncNow, useUpdateEvent } from '../../api/hooks'
import type { CalendarEvent, DeletionScope } from '../../api/types'
import { EventDialog } from '../../components/EventDialog'
import { TimeGridView } from './TimeGridView'
import { rangeFor, type Range } from './dateRange'

const SCALE_FACTOR: Record<string, number> = { normal: 1, large: 1.2, wall: 1.45 }

export function CalendarPage() {
  const { data: settings } = useSettings()
  const { data: accounts = [] } = useAccounts()
  const hasGoogle = accounts.some((account) => account.provider === 'google')
  const update = useUpdateEvent()
  const client = useQueryClient()
  const [moving, setMoving] = useState<{ event: CalendarEvent; start: Date; end: Date } | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const sync = useSyncNow()
  const { isSuccess: synced, reset: resetSync } = sync
  const [anchor, setAnchor] = useState(() => new Date())
  const [, setClock] = useState(() => Date.now())
  const [editing, setEditing] = useState<CalendarEvent | null>(null)
  const [creatingEnd, setCreatingEnd] = useState<Date | null>(null)
  const [creatingAt, setCreatingAt] = useState<Date | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const weekStartsOn = (settings?.first_day_of_week === 1 ? 1 : 0) as 0 | 1
  const range = rangeFor('week', anchor, weekStartsOn)
  const { data: fetched, isLoading, error, refetch } = useEvents(range.start, range.end)
  const previous = useRef<{ range: Range; events: CalendarEvent[] } | null>(null)
  const display = fetched ? { range, events: fetched } : previous.current ?? { range, events: [] }
  useLayoutEffect(() => {
    if (fetched) previous.current = { range, events: fetched }
  }, [range, fetched])
  const hidden = settings?.hidden_calendar_ids ?? []
  const events = display.events.filter((event) => !hidden.includes(event.calendar_id)).map((event) =>
    moving?.event.id === event.id && moving.event.start_at === event.start_at
      ? { ...event, start_at: moving.start.toISOString(), end_at: moving.end.toISOString() } : event)

  useEffect(() => {
    if (!synced) return
    const timer = window.setTimeout(resetSync, 3000)
    return () => window.clearTimeout(timer)
  }, [synced, resetSync])

  useEffect(() => {
    let currentWeek = startOfWeek(new Date(), { weekStartsOn }).getTime()
    const check = () => {
      const now = new Date()
      const week = startOfWeek(now, { weekStartsOn }).getTime()
      // Leave arrow navigation alone during the week. At the boundary, a wall display
      // returns to the new current week even if it had been left browsing another one.
      if (week !== currentWeek) {
        currentWeek = week
        setAnchor(now)
      }
      // Refresh today's highlight and the now-line even when no event data changes.
      setClock(now.getTime())
    }
    const timer = window.setInterval(check, 30_000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [weekStartsOn])

  const goToday = () => setAnchor(new Date())
  const goStep = (direction: 1 | -1) => setAnchor((date) => addDays(date, 7 * direction))
  const openEvent = (event: CalendarEvent) => {
    setEditing(event)
    setCreatingAt(null)
    setModalOpen(true)
  }
  const openSlot = (start: Date, end?: Date) => {
    setCreatingEnd(end ?? null)
    setEditing(null)
    setCreatingAt(start)
    setModalOpen(true)
  }

  const saveMove = async (move: NonNullable<typeof moving>, scope?: DeletionScope) => {
    setMoveError(null)
    try {
      await update.mutateAsync({ id: move.event.id, start_at: move.start.toISOString(), end_at: move.end.toISOString(),
        ...(scope ? { edit_scope: scope, occurrence_start: move.event.original_start_at || move.event.start_at } : {}) })
      await client.refetchQueries({ queryKey: ['events'], type: 'active' }, { cancelRefetch: false })
      setMoving(null)
    } catch (error) {
      setMoving(null)
      setMoveError(error instanceof Error ? error.message : 'Could not move the event.')
    }
  }
  const moveEvent = (event: CalendarEvent, start: Date, end: Date) => {
    const move = { event, start, end }
    setMoving(move)
    setMoveError(null)
    if (!event.recurring) void saveMove(move)
  }

  return (
    <div className="calpage" data-highlight-important={settings?.highlight_important || undefined}>
      <header className="calpage__bar">
        <div className="calpage__titlewrap">
          <h1 className="calpage__title">{titleFor(display.range.start, display.range.end)}</h1>
          {isLoading && <span className="calpage__loading">…</span>}
        </div>
        {hasGoogle && <button
          className="iconbtn calpage__syncbtn"
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          aria-label="Sync now"
          aria-busy={sync.isPending}
        >
          <span aria-live="polite">{sync.isPending ? 'Syncing…' : synced ? 'Synced' : 'Sync now'}</span>
        </button>}
        <button className="iconbtn" onClick={goToday}>
          Today
        </button>
        {/* One joined control, so the two arrows read as a pair and a thumb can find
            either without crossing the Today button. */}
        <div className="segmented">
          <button className="iconbtn" onClick={() => goStep(-1)} aria-label="Previous week">
            ‹
          </button>
          <button className="iconbtn" onClick={() => goStep(1)} aria-label="Next week">
            ›
          </button>
        </div>
        <button className="iconbtn" aria-label="Add event" onClick={() => openSlot(new Date())}>+</button>
      </header>

      {hasGoogle && sync.isError && (
        <div className="calpage__syncerror" role="alert">
          <span>{sync.error.message || 'Could not sync. Please try again.'}</span>
          <button onClick={resetSync} aria-label="Dismiss sync error">×</button>
        </div>
      )}

      {moveError && <div className="calpage__syncerror" role="alert">
        <span>{moveError}</span><button onClick={() => setMoveError(null)} aria-label="Dismiss move error">×</button>
      </div>}
      {moving && (!moving.event.recurring || update.isPending) && <p className="calpage__loading" role="status">Saving event position…</p>}
      {error && <div className="calpage__syncerror" role="alert">
        <span>Could not load this week. {error.message}</span><button onClick={() => void refetch()}>Retry</button>
      </div>}
      <div className="calpage__body">
        <TimeGridView
          days={display.range.days}
          events={events}
          dayStartHour={settings?.day_start_hour ?? 7}
          dayEndHour={settings?.day_end_hour ?? 22}
          use24h={settings?.time_format_24h ?? false}
          hourHeight={32 * SCALE_FACTOR[settings?.display_scale ?? 'normal']}
          onSelectEvent={openEvent}
          onSelectSlot={openSlot}
          holdToCreate={(settings?.hold_to_create ?? false) && !moving}
          longPressMs={settings?.long_press_ms ?? 750}
          onMoveEvent={moveEvent}
          showImportantCounts={settings?.show_important_counts ?? false}
        />
      </div>

      {moving?.event.recurring && createPortal(
        <div className="modal" role="dialog" aria-modal="true" aria-label="Move repeating event"
          onClick={() => { if (!update.isPending) setMoving(null) }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !update.isPending) setMoving(null) }}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal__title">Move repeating event</h2>
            <RecurringEditChoices busy={update.isPending} onChoose={(scope) => void saveMove(moving, scope)} onCancel={() => setMoving(null)} />
          </div>
        </div>, document.body)}
      {modalOpen && (
        <EventDialog
          event={editing}
          defaultStart={creatingAt}
          defaultEnd={creatingEnd}
          onClose={() => {
            setModalOpen(false)
            setEditing(null)
            setCreatingAt(null)
          }}
        />
      )}
    </div>
  )
}

function titleFor(start: Date, end: Date): string {
  const last = addDays(end, -1)
  return isSameMonth(start, last)
    ? `${format(start, 'MMM d')} – ${format(last, 'd, yyyy')}`
    : `${format(start, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`
}

import { addDays, format, isSameMonth, startOfWeek } from 'date-fns'
import { useEffect, useState } from 'react'
import { useEvents, useSettings, useUsers } from '../../api/hooks'
import type { CalendarEvent } from '../../api/types'
import { EventModal } from '../../components/EventModal'
import { usePersonFilter } from '../../hooks/usePersonFilter'
import { TimeGridView } from './TimeGridView'
import { rangeFor } from './dateRange'

const SCALE_FACTOR: Record<string, number> = { normal: 1, large: 1.2, wall: 1.45 }

export function CalendarPage() {
  const { data: settings } = useSettings()
  const { data: users = [] } = useUsers()
  const { toggle, showEveryone, isVisible, anyHidden } = usePersonFilter()
  const [anchor, setAnchor] = useState(() => new Date())
  const [, setClock] = useState(() => Date.now())
  const [editing, setEditing] = useState<CalendarEvent | null>(null)
  const [creatingAt, setCreatingAt] = useState<Date | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const weekStartsOn = (settings?.first_day_of_week === 1 ? 1 : 0) as 0 | 1
  const range = rangeFor('week', anchor, weekStartsOn)
  const { data: fetched = [], isLoading } = useEvents(range.start, range.end)
  const events = fetched.filter((event) => isVisible(event.user_id))

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
  const openSlot = (start: Date) => {
    setEditing(null)
    setCreatingAt(start)
    setModalOpen(true)
  }

  return (
    <div className="calpage">
      <header className="calpage__bar">
        <div className="calpage__titlewrap">
          <h1 className="calpage__title">{titleFor(range.start, range.end)}</h1>
          {isLoading && <span className="calpage__loading">…</span>}
        </div>
        {/* In the toolbar, beside the controls rather than the title, so they don't slide
            sideways every time the title changes length. A phone wraps them onto a
            second line of the same bar. */}
        {users.length > 0 && (
          <div className="peoplefilter">
            {users.map((u) => {
              const shown = isVisible(u.id)
              return (
                <button
                  key={u.id}
                  className="personchip"
                  data-hidden={!shown}
                  aria-pressed={shown}
                  style={shown ? { background: u.color, borderColor: u.color } : undefined}
                  onClick={() => toggle(u.id)}
                  title={shown ? `Hide ${u.name}'s events` : `Show ${u.name}'s events`}
                >
                  {u.avatar_emoji && <span aria-hidden>{u.avatar_emoji}</span>}
                  {u.name}
                </button>
              )
            })}
            {anyHidden && (
              <button className="personchip personchip--all" onClick={showEveryone}>
                Show everyone
              </button>
            )}
          </div>
        )}
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
        <button className="iconbtn iconbtn--primary" onClick={() => openSlot(nextHour())} aria-label="Add event">
          +
        </button>
      </header>

      <div className="calpage__body">
        <TimeGridView
          days={range.days}
          events={events}
          dayStartHour={settings?.day_start_hour ?? 7}
          dayEndHour={settings?.day_end_hour ?? 22}
          use24h={settings?.time_format_24h ?? false}
          hourHeight={32 * SCALE_FACTOR[settings?.display_scale ?? 'normal']}
          onSelectEvent={openEvent}
          onSelectSlot={openSlot}
        />
      </div>

      {modalOpen && (
        <EventModal
          event={editing}
          defaultStart={creatingAt}
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

function nextHour(): Date {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

function titleFor(start: Date, end: Date): string {
  const last = addDays(end, -1)
  return isSameMonth(start, last)
    ? `${format(start, 'MMM d')} – ${format(last, 'd, yyyy')}`
    : `${format(start, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`
}

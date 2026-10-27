import { format, isToday } from 'date-fns'
import { useLayoutEffect, useMemo, useRef } from 'react'
import type { CalendarEvent } from '../../api/types'
import { useHoldToCreate, type DraftRange } from './useHoldToCreate'
import { overlapsDay, startOfLocalDay } from './overlap'

interface Props {
  days: Date[]
  events: CalendarEvent[]
  dayStartHour: number
  dayEndHour: number
  use24h: boolean
  hourHeight: number
  showImportantCounts?: boolean
  holdToCreate?: boolean
  onSelectEvent: (e: CalendarEvent) => void
  onSelectSlot: (start: Date, end?: Date) => void
}

/** Below this height a block cannot show a title, start and end on separate lines.
 *  Sized for the largest text scale ("wall"), so the switch happens a little early on
 *  the smaller ones rather than too late on the display that matters most. */
const TWO_LINES_PX = 60

/** A fixed set of day columns with a vertically scrolling timeline. */
export function TimeGridView({
  days,
  events,
  dayStartHour,
  dayEndHour,
  use24h,
  hourHeight,
  onSelectEvent,
  onSelectSlot,
  showImportantCounts = false,
  holdToCreate = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selection = useHoldToCreate(scrollRef, days, dayStartHour, dayEndHour, hourHeight, holdToCreate, onSelectSlot)
  const hours = Array.from({ length: dayEndHour - dayStartHour }, (_, i) => dayStartHour + i)

  useLayoutEffect(() => {
    const now = new Date()
    const offset = (now.getHours() - dayStartHour - 1) * hourHeight
    if (scrollRef.current && offset > 0) scrollRef.current.scrollTop = offset
  }, [dayStartHour, hourHeight])

  const allDay = events.filter((e) => e.all_day)

  return (
    <div className="timegrid" style={{ ['--days' as string]: days.length }}>
      <div className="timegrid__head">
        <div className="timegrid__gutter-head" />
        {days.map((day) => {
          const count = events.filter((event) => event.important !== false && overlapsDay(event, day)).length
          return <div key={day.toISOString()} className="timegrid__dayhead" data-today={isToday(day)}>
            <div className="timegrid__dayname">{format(day, 'EEE')}</div>
            <div className="timegrid__daynum"><span className="timegrid__date-number">{format(day, 'd')}</span>
              {showImportantCounts && count > 0 && <span className="timegrid__important-count" aria-label={`${count} important events`}>{count}</span>}
            </div>
          </div>
        })}
      </div>

      {allDay.length > 0 && (
        <div className="timegrid__allday">
          <div className="timegrid__gutter-head">all day</div>
          {days.map((day) => (
            <div key={day.toISOString()} className="timegrid__alldaycell">
              <AllDayChips day={day} events={allDay} onSelectEvent={onSelectEvent} />
            </div>
          ))}
        </div>
      )}

      <div className="timegrid__body" ref={scrollRef} data-hold-to-create={holdToCreate || undefined} {...selection.handlers}>
        <HourGutter hours={hours} hourHeight={hourHeight} use24h={use24h} />
        {days.map((day) => (
          <DayColumn
            key={day.toISOString()}
            day={day}
            events={events}
            hours={hours}
            dayStartHour={dayStartHour}
            hourHeight={hourHeight}
            use24h={use24h}
            onSelectEvent={onSelectEvent}
            draft={selection.draft}
          />
        ))}
      </div>
    </div>
  )
}

export function HourGutter({
  hours,
  hourHeight,
  use24h,
}: {
  hours: number[]
  hourHeight: number
  use24h: boolean
}) {
  return (
    <div className="timegrid__gutter">
      {hours.map((h) => (
        <div key={h} className="timegrid__hourlabel" style={{ height: hourHeight }}>
          {formatHour(h, use24h)}
        </div>
      ))}
    </div>
  )
}

interface ColumnProps {
  day: Date
  events: CalendarEvent[]
  hours: number[]
  dayStartHour: number
  hourHeight: number
  use24h: boolean
  /** Far from the view in the scrolling strip: same height, nothing inside. */
  draft?: DraftRange | null
  placeholder?: boolean
  onSelectEvent: (e: CalendarEvent) => void
}

/** One day's hour slots, events and now-line. Shared by Day view and the scrolling strip
 *  so the two cannot drift apart. */
export function DayColumn({
  day,
  events,
  hours,
  dayStartHour,
  hourHeight,
  use24h,
  placeholder,
  draft,
  onSelectEvent,
}: ColumnProps) {
  const positioned = useMemo(
    () =>
      placeholder
        ? []
        : layout(
            events.filter((e) => !e.all_day && overlapsDay(e, day)),
            day,
            hourHeight,
          ),
    [placeholder, events, day, hourHeight],
  )
  if (placeholder) {
    // The height the slots would add up to, so swapping between this and a full column
    // never moves the scroll position.
    return (
      <div
        className="timegrid__col"
        data-today={isToday(day)}
        style={{ height: hours.length * hourHeight }}
        aria-hidden
      />
    )
  }
  return (
    <div className="timegrid__col" data-today={isToday(day)} style={{ ['--hour-height' as string]: `${hourHeight}px` }}>
      {hours.map((h) => (
        <div
          key={h}
          className="timegrid__slot"
          style={{ height: hourHeight }}
          aria-label={`${format(day, 'EEE d')} ${formatHour(h, use24h)}`}
        />
      ))}
      {positioned.map(({ event, top, height, left, width }) => (
        <button
          key={event.id}
          className="event-block"
          data-important={event.important !== false}
          // A block this short cannot fit a title above a time; the CSS
          // lays those out on one line instead.
          data-compact={height < TWO_LINES_PX}
          aria-label={`${event.title}, ${formatTime(new Date(event.start_at), use24h)} – ${formatTime(new Date(event.end_at), use24h)}`}
          style={{
            top: top - dayStartHour * hourHeight,
            height,
            left: `${left}%`,
            width: `${width}%`,
            background: event.color,
          }}
          onClick={() => onSelectEvent(event)}
        >
          <span className="event-block__content">
            <span className="event-block__title">{event.title}</span>
            <span className="event-block__time">{formatTime(new Date(event.start_at), use24h)}</span>
          </span>
          <span className="event-block__end">{formatTime(new Date(event.end_at), use24h)}</span>
        </button>
      ))}
      {draft && draft.start < new Date(new Date(day).setDate(day.getDate() + 1)) && draft.end > day && (
        <div className="event-draft" aria-label="New event duration" style={{
          top: (draft.start.toDateString() === day.toDateString() ? draft.start.getHours() + draft.start.getMinutes() / 60 - dayStartHour : 0) * hourHeight,
          bottom: (draft.end.toDateString() === day.toDateString() ? hours.length + dayStartHour - draft.end.getHours() - draft.end.getMinutes() / 60 : 0) * hourHeight,
        }}>{formatTime(draft.start, use24h)} – {formatTime(draft.end, use24h)}</div>
      )}
      {isToday(day) && <NowLine dayStartHour={dayStartHour} hourHeight={hourHeight} />}
    </div>
  )
}

/** The all-day chips for one day, shared like DayColumn. */
export function AllDayChips({
  day,
  events,
  onSelectEvent,
}: {
  day: Date
  events: CalendarEvent[]
  onSelectEvent: (e: CalendarEvent) => void
}) {
  return (
    <>
      {events
        .filter((e) => e.all_day && overlapsDay(e, day))
        .map((e) => (
          <button
            key={e.id}
            className="chip"
            data-important={e.important !== false}
            style={{ background: e.color }}
            onClick={() => onSelectEvent(e)}
          >
            {e.title}
          </button>
        ))}
    </>
  )
}

function NowLine({ dayStartHour, hourHeight }: { dayStartHour: number; hourHeight: number }) {
  const now = new Date()
  const top = (now.getHours() + now.getMinutes() / 60 - dayStartHour) * hourHeight
  if (top < 0) return null
  return <div className="nowline" style={{ top }} />
}

interface Positioned {
  event: CalendarEvent
  top: number
  height: number
  left: number
  width: number
}

/** Side-by-side placement for events that overlap in time, so nothing is hidden behind
 *  something else on a wall display nobody can hover. */
function layout(events: CalendarEvent[], day: Date, hourHeight: number): Positioned[] {
  const dayStart = startOfLocalDay(day)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)
  const clockHour = (d: Date) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600

  const spans = events
    .map((event) => {
      const s = new Date(event.start_at)
      const e = new Date(event.end_at)
      // The grid is labelled by local clock hours. Elapsed time since midnight
      // shifts everything after a DST transition by one row on that Sunday.
      const startH = s <= dayStart ? 0 : clockHour(s)
      let endH = e >= dayEnd ? 24 : clockHour(e)
      if (endH <= startH && e > s) {
        // The repeated hour has only one row. Keep an event spanning the backward
        // jump visible even when its end clock reading is earlier than its start.
        endH = Math.min(24, startH + (e.getTime() - s.getTime()) / 3_600_000)
      }
      return { event, startH, endH: Math.max(endH, startH) }
    })
    .sort((a, b) => a.startH - b.startH || b.endH - a.endH)

  // Each connected group of overlapping events shares the width. A later event
  // with no overlaps must regain the whole column, even if the morning was busy.
  let columns: number[] = []
  let group: (typeof spans[number] & { col: number })[] = []
  const placed: Positioned[] = []
  const finishGroup = () => {
    for (const p of group) {
      placed.push({
        event: p.event,
        top: p.startH * hourHeight,
        height: (p.endH - p.startH) * hourHeight,
        left: (p.col / columns.length) * 100,
        width: 100 / columns.length,
      })
    }
    columns = []
    group = []
  }
  for (const span of spans) {
    if (columns.length && columns.every((end) => end <= span.startH)) finishGroup()
    let col = columns.findIndex((endsAt) => endsAt <= span.startH)
    if (col === -1) {
      col = columns.length
      columns.push(span.endH)
    } else {
      columns[col] = span.endH
    }
    group.push({ ...span, col })
  }
  finishGroup()
  return placed
}

export function formatHour(hour: number, use24h: boolean): string {
  if (use24h) return `${String(hour).padStart(2, '0')}:00`
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}${hour < 12 ? 'a' : 'p'}`
}

export function formatTime(d: Date, use24h: boolean): string {
  return format(d, use24h ? 'HH:mm' : 'h:mma').toLowerCase()
}

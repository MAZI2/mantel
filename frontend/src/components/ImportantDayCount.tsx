import { format } from 'date-fns'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CalendarEvent } from '../api/types'

export function ImportantDayCount({ day, events }: { day: Date; events: CalendarEvent[] }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 8 })
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const closing = useRef<number | undefined>(undefined)
  const id = useId()
  const cancelClose = () => window.clearTimeout(closing.current)
  const close = () => { cancelClose(); setOpen(false); setPinned(false) }
  const leave = () => {
    if (!pinned) closing.current = window.setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => () => window.clearTimeout(closing.current), [])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!button.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = button.current?.getBoundingClientRect(), panel = popup.current?.getBoundingClientRect()
      if (!anchor || !panel) return
      const below = anchor.bottom + 6
      setPosition({
        left: Math.max(8, Math.min(anchor.left + anchor.width / 2 - panel.width / 2, window.innerWidth - panel.width - 8)),
        top: Math.max(8, Math.min(below + panel.height <= window.innerHeight - 8 ? below : anchor.top - panel.height - 6,
          window.innerHeight - panel.height - 8)),
      })
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open, events])

  return <>
    <button ref={button} type="button" className="timegrid__important-count"
      aria-label={`${events.length} important events`} aria-expanded={open}
      aria-controls={open ? id : undefined} aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') { cancelClose(); setOpen(true) } }}
      onPointerLeave={(event) => { if (event.pointerType !== 'touch') leave() }}
      onFocus={() => { if (button.current?.matches(':focus-visible')) { cancelClose(); setOpen(true) } }}
      onBlur={() => { if (!pinned) setOpen(false) }}
      onClick={() => { cancelClose(); setPinned(!pinned); setOpen(!pinned) }}>
      {events.length}
    </button>
    {open && createPortal(<div ref={popup} id={id} role="tooltip" className="important-events-popup" style={position}
      onPointerEnter={cancelClose} onPointerLeave={leave}>
      <h2>Important events · {format(day, 'EEE, d MMM')}</h2>
      <ul>{[...events].sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start_at.localeCompare(b.start_at))
        .map((event) => <li key={`${event.id}:${event.start_at}`}>{event.title}</li>)}</ul>
    </div>, document.body)}
  </>
}

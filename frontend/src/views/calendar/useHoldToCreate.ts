import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RefObject } from 'react'
import type { CalendarEvent } from '../../api/types'

export interface DraftRange { start: Date; end: Date; event?: CalendarEvent }
interface Gesture {
  id: number; x: number; y: number; initialX: number; initialY: number
  start: Date; active: boolean; timer: number; event?: CalendarEvent
}

/** Native scrolling wins until the stationary hold arms a create or move gesture. */
export function useHoldToCreate(body: RefObject<HTMLDivElement | null>, days: Date[], dayStart: number,
  dayEnd: number, hourHeight: number, enabled: boolean, delay: number, events: CalendarEvent[],
  onCreate: (start: Date, end?: Date) => void, onMove: (event: CalendarEvent, start: Date, end: Date) => void) {
  const [draft, setDraft] = useState<DraftRange | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const suppressUntil = useRef(0)
  const locate = (x: number, y: number, end = false) => {
    const columns = body.current?.querySelectorAll<HTMLElement>('.timegrid__col')
    if (!columns?.length) return null
    let index = Array.from(columns).findIndex((el) => x < el.getBoundingClientRect().right)
    if (index < 0) index = columns.length - 1
    const top = columns[index].getBoundingClientRect().top
    const raw = (y - top) / hourHeight * 60 + dayStart * 60
    const minutes = Math.max(dayStart * 60, Math.min(dayEnd * 60, (end ? Math.ceil : Math.floor)(raw / 15) * 15))
    const time = new Date(days[index])
    time.setHours(0, minutes, 0, 0)
    return time
  }
  const rangeAt = (g: Gesture, x: number, y: number): DraftRange | null => {
    const point = locate(x, y, !g.event)
    if (!point) return null
    if (!g.event) return { start: g.start, end: new Date(Math.max(point.getTime(), g.start.getTime() + 15 * 60_000)) }
    const event = g.event
    let shift = point.getTime() - g.start.getTime()
    if (event.all_day) {
      // All-day dates are UTC dates; a DST boundary must not add or remove an hour.
      const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
      shift = day(point) - day(g.start)
    }
    return { event, start: new Date(new Date(event.start_at).getTime() + shift),
      end: new Date(new Date(event.end_at).getTime() + shift) }
  }
  const update = () => {
    const g = gesture.current
    if (g?.active) setDraft(rangeAt(g, g.x, g.y))
  }
  const cancel = () => {
    if (gesture.current) window.clearTimeout(gesture.current.timer)
    gesture.current = null
    setDraft(null)
  }
  useEffect(() => {
    const prevent = (e: TouchEvent) => { if (gesture.current?.active) e.preventDefault() }
    document.addEventListener('touchmove', prevent, { passive: false })
    return () => {
      document.removeEventListener('touchmove', prevent)
      if (gesture.current) window.clearTimeout(gesture.current.timer)
    }
  }, [])
  useEffect(() => {
    if (!draft) return
    const timer = window.setInterval(() => {
      const g = gesture.current, node = body.current
      if (!g?.active || !node || g.event?.all_day) return
      const rect = node.getBoundingClientRect()
      const speed = g.y < rect.top + 35 ? -8 : g.y > rect.bottom - 35 ? 8 : 0
      if (speed) { node.scrollTop += speed; update() }
    }, 30)
    return () => window.clearInterval(timer)
    // Pointer positions are read from refs while this gesture remains armed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!draft])
  return { draft, handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.isPrimary && gesture.current) { cancel(); suppressUntil.current = Date.now() + 1000; return }
      if (!enabled || !e.isPrimary || e.button !== 0) return
      if (gesture.current) { cancel(); return }
      const target = e.target as HTMLElement
      const eventElement = target.closest<HTMLElement>('[data-event-id]')
      const event = eventElement ? events.find((item) => String(item.id) === eventElement.dataset.eventId && item.start_at === eventElement.dataset.eventStart) : undefined
      if (eventElement && (!event || !event.editable)) return
      if (!event && !target.closest('.timegrid__col')) return
      const start = locate(e.clientX, e.clientY)
      if (!start) return
      const g: Gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, initialX: e.clientX, initialY: e.clientY,
        start, active: false, timer: 0, event }
      gesture.current = g
      g.timer = window.setTimeout(() => {
        if (gesture.current !== g) return
        g.active = true
        suppressUntil.current = Date.now() + 1000
        body.current?.setPointerCapture(g.id)
        update()
      }, delay)
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gesture.current
      if (!g || g.id !== e.pointerId) return
      g.x = e.clientX; g.y = e.clientY
      if (!g.active && Math.hypot(g.x - g.initialX, g.y - g.initialY) > 10) { cancel(); return }
      if (g.active) { e.preventDefault(); update() }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gesture.current
      if (!g || e.pointerId !== g.id) return
      const range = rangeAt(g, e.clientX, e.clientY)
      if (g.active && range) {
        e.preventDefault()
        suppressUntil.current = Date.now() + 1000
        if (g.event) {
          if (range.start.getTime() !== new Date(g.event.start_at).getTime()) onMove(g.event, range.start, range.end)
        } else onCreate(range.start, range.end)
      }
      cancel()
    },
    onPointerCancel: () => { if (gesture.current?.active) suppressUntil.current = Date.now() + 1000; cancel() },
    onClickCapture: (e: React.MouseEvent<HTMLDivElement>) => {
      if (Date.now() < suppressUntil.current || gesture.current?.active) { e.preventDefault(); e.stopPropagation() }
    },
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => { if (enabled) e.preventDefault() },
  } }
}

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RefObject } from 'react'

export interface DraftRange { start: Date; end: Date }

/** Scrolling remains native until a stationary three-second hold has armed selection. */
export function useHoldToCreate(body: RefObject<HTMLDivElement | null>, days: Date[], dayStart: number,
  dayEnd: number, hourHeight: number, enabled: boolean, onCreate: (start: Date, end?: Date) => void) {
  const [draft, setDraft] = useState<DraftRange | null>(null)
  const gesture = useRef<{ id: number; x: number; y: number; initialX: number; initialY: number;
    start: Date; active: boolean; timer: number } | null>(null)
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
  const update = () => {
    const g = gesture.current
    if (!g?.active) return
    const end = locate(g.x, g.y, true)
    if (end) setDraft({ start: g.start, end: new Date(Math.max(end.getTime(), g.start.getTime() + 15 * 60_000)) })
  }
  const cancel = () => {
    const g = gesture.current
    if (g) window.clearTimeout(g.timer)
    gesture.current = null
    setDraft(null)
  }
  useEffect(() => {
    const node = body.current
    const prevent = (e: TouchEvent) => { if (gesture.current?.active) e.preventDefault() }
    node?.addEventListener('touchmove', prevent, { passive: false })
    return () => { node?.removeEventListener('touchmove', prevent); if (gesture.current) window.clearTimeout(gesture.current.timer) }
  }, [body])
  useEffect(() => {
    if (!draft) return
    const timer = window.setInterval(() => {
      const g = gesture.current, node = body.current
      if (!g?.active || !node) return
      const rect = node.getBoundingClientRect()
      const speed = g.y < rect.top + 35 ? -8 : g.y > rect.bottom - 35 ? 8 : 0
      if (speed) { node.scrollTop += speed; update() }
    }, 30)
    return () => window.clearInterval(timer)
    // Coordinates are read from refs; the timer need not restart on every movement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!draft])
  return { draft, handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled || !e.isPrimary || e.button !== 0) return
      if (gesture.current) { cancel(); return }
      const start = locate(e.clientX, e.clientY)
      if (!start) return
      const g = { id: e.pointerId, x: e.clientX, y: e.clientY, initialX: e.clientX, initialY: e.clientY,
        start, active: false, timer: 0 }
      gesture.current = g
      g.timer = window.setTimeout(() => {
        if (gesture.current !== g) return
        g.active = true
        suppressUntil.current = Date.now() + 1000
        body.current?.setPointerCapture(g.id)
        update()
      }, 3000)
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
      const end = locate(e.clientX, e.clientY, true)
      if (g.active && end) {
        e.preventDefault()
        suppressUntil.current = Date.now() + 1000
        onCreate(g.start, new Date(Math.max(end.getTime(), g.start.getTime() + 15 * 60_000)))
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

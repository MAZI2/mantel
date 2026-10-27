import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../api/client'
import { useCalendars, useSettings } from '../api/hooks'
import { calendarLabel } from '../api/providers'
import type { AppSettings } from '../api/types'

export function CalendarPicker({ profileName, onCalendar }: { profileName: string; onCalendar: boolean }) {
  const api = useApi()
  const { data: calendars = [] } = useCalendars()
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<number[] | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, bottom: 64 })
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  const hidden = selection ?? settings?.hidden_calendar_ids ?? []
  const save = useMutation({
    mutationFn: (ids: number[]) => api.patch<AppSettings>('/settings', { hidden_calendar_ids: ids }),
    onSuccess: (next) => { qc.setQueryData(['settings'], next); setSelection(null) },
    onError: () => setSelection(null),
  })
  const choose = (ids: number[]) => { setSelection(ids); save.mutate(ids) }
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); button.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = button.current?.getBoundingClientRect()
      if (!anchor) return
      const width = menu.current?.getBoundingClientRect().width ?? 0
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        bottom: window.innerHeight - anchor.top + 6 })
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [open, calendars])
  return (
    <div className="calendar-picker" ref={wrapper}>
      <button ref={button} className="navbtn" aria-pressed="true" aria-current={onCalendar ? 'page' : undefined}
        aria-expanded={open} aria-controls={id} aria-haspopup="true" title="Choose calendars"
        onClick={() => setOpen(!open)}>{profileName}</button>
      {open && createPortal(
        <div ref={menu} style={{ left: position.left, bottom: position.bottom, maxHeight: `max(44px, calc(100dvh - ${position.bottom + 8}px))` }} id={id} className="calendar-picker__menu" role="group" aria-label="Visible calendars">
          <h2>Visible calendars</h2>
          {calendars.map((calendar) => (
            <label className="calendar-picker__choice" key={calendar.id}>
              <input type="checkbox" checked={!hidden.includes(calendar.id)} disabled={save.isPending}
                onChange={(e) => choose(e.target.checked ? hidden.filter((n) => n !== calendar.id) : [...hidden, calendar.id])} />
              <span className="calendar-picker__colour" style={{ background: calendar.color }} aria-hidden="true" />
              <span>{calendarLabel(calendar)}</span>
            </label>
          ))}
          {!calendars.length && <p className="hint">Add a calendar in Settings.</p>}
          <button className="btn" disabled={save.isPending || !hidden.length} onClick={() => choose([])}>Show all</button>
          {save.error && <p className="modal__error" role="alert">{save.error.message}</p>}
        </div>, document.body
      )}
    </div>
  )
}

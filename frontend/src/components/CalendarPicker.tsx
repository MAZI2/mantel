import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi } from '../api/client'
import { useCalendars, useSettings } from '../api/hooks'
import { calendarLabel } from '../api/providers'
import type { AppSettings } from '../api/types'

export function CalendarPicker() {
  const api = useApi()
  const { data: calendars = [] } = useCalendars()
  const { data: settings } = useSettings()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<number[] | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
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
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); button.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return (
    <div className="calendar-picker" ref={wrapper}>
      <button ref={button} className="iconbtn iconbtn--primary" aria-label="Choose calendars"
        aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M7 3v5M17 3v5M7 14h3M14 14h3M7 18h3" />
        </svg><span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={id} className="calendar-picker__menu" role="group" aria-label="Visible calendars">
          <h2>Visible calendars</h2>
          <p className="hint">Choose calendars to show in this profile.</p>
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
        </div>
      )}
    </div>
  )
}

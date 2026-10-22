import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../../api/client'
import { calendarLabel } from '../../api/providers'
import type { CalendarInfo } from '../../api/types'

interface Option { profile_id: string; profile_name: string; calendar: CalendarInfo }

export function LinkedCalendarForm() {
  const api = useApi()
  const client = useQueryClient()
  const [selected, setSelected] = useState('')
  const options = useQuery({ queryKey: ['calendar-import-options'],
    queryFn: () => api.get<Option[]>('/calendars/import-options') })
  const save = useMutation({
    mutationFn: () => {
      const [profile, calendar] = selected.split(':')
      return api.post('/calendars/import', { source_profile_id: profile, source_calendar_id: Number(calendar) })
    },
    onSuccess: async () => {
      setSelected('')
      await Promise.all(['calendars', 'events', 'calendar-import-options'].map((key) =>
        client.invalidateQueries({ queryKey: [key] })))
    },
  })
  return <div className="linked-calendar-form">
    <h3>Add calendar from another profile</h3>
    <p className="hint">Changes update the original calendar. You must have access to both profiles to see or edit its events.</p>
    <div className="row">
      <select aria-label="Calendar from another profile" value={selected} disabled={save.isPending}
        onChange={(e) => setSelected(e.target.value)}>
        <option value="">Choose a calendar</option>
        {options.data?.map((option) => <option key={`${option.profile_id}:${option.calendar.id}`}
          value={`${option.profile_id}:${option.calendar.id}`}>{option.profile_name} · {calendarLabel(option.calendar)}{option.calendar.writable ? '' : ' · read only'}</option>)}
      </select>
      <button className="btn btn--primary" disabled={!selected || save.isPending}
        onClick={() => save.mutate()}>{save.isPending ? 'Adding…' : 'Add linked calendar'}</button>
    </div>
    {options.isSuccess && !options.data.length && <p className="hint">No other calendars are available from your profiles.</p>}
    {(options.error || save.error) && <p role="alert">{options.error?.message || save.error?.message}</p>}
  </div>
}

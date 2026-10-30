import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../api/client'
import type { CalendarEvent, CalendarInfo } from '../api/types'

interface Option { profile_id: string; profile_name: string; calendar: CalendarInfo }
export function EventLinkForm({ event, onCancel }: { event: CalendarEvent; onCancel: () => void }) {
  const api = useApi()
  const [selected, setSelected] = useState('')
  const options = useQuery({ queryKey: ['event-link-options', event.id], queryFn: () => api.get<Option[]>(`/events/${event.id}/link-options`) })
  const save = useMutation({ mutationFn: () => {
    const [profile_id, calendar] = selected.split(':')
    return api.post(`/events/${event.id}/links`, { profile_id, calendar_id: Number(calendar), occurrence_start: event.original_start_at || event.start_at })
  } })
  return <div className="event-link-form">
    <label className="field"><span>Add to another calendar</span>
      <select aria-label="Destination profile and calendar" value={selected} disabled={save.isPending || save.isSuccess} onChange={(e) => setSelected(e.target.value)}>
        <option value="">Choose a calendar</option>
        {options.data?.map((option) => <option key={`${option.profile_id}:${option.calendar.id}`} value={`${option.profile_id}:${option.calendar.id}`}>{option.profile_name} · {option.calendar.name}</option>)}
      </select>
    </label>
    <p className="hint">Everyone in the destination profile can see this event. Edits and deletion affect the original.{event.recurring ? ' Links this occurrence.' : ''}</p>
    {save.isSuccess ? <p role="status">Event linked.</p> : <button className="btn btn--primary" disabled={!selected || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Adding…' : 'Add linked event'}</button>}
    <button className="btn" disabled={save.isPending} onClick={onCancel}>{save.isSuccess ? 'Done' : 'Cancel'}</button>
    {(save.error || options.error) && <p role="alert">{save.error?.message || options.error?.message}</p>}
  </div>
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../../api/client'
import { useSettings } from '../../api/hooks'
import type { AppSettings } from '../../api/types'

function PersonalOption({ name, label, hint }: { name: 'enable_event_linking' | 'hold_to_create' | 'show_important_counts'; label: string; hint: string }) {
  const api = useApi(), client = useQueryClient()
  const { data: settings } = useSettings()
  const [selection, setSelection] = useState<boolean | null>(null)
  const save = useMutation({
    mutationFn: (value: boolean) => api.patch<AppSettings>('/settings', { [name]: value }),
    onSuccess: (next) => { client.setQueryData(['settings'], next); setSelection(null) },
    onError: () => setSelection(null),
  })
  return <div className="row row--stack">
    <label className="toggle"><input type="checkbox" checked={selection ?? settings?.[name] ?? false}
      disabled={save.isPending} onChange={(e) => { setSelection(e.target.checked); save.mutate(e.target.checked) }} />{label}</label>
    <p className="hint">{hint} Saved for you in this profile.</p>
    {save.error && <p role="alert">Could not save this option. Please try again.</p>}
  </div>
}
export function OptionalEventSettings() {
  return <>
    <PersonalOption name="show_important_counts" label="Show important event counts" hint="Show the number of important visible events beside each date. Days without important events have no count." />
    <PersonalOption name="enable_event_linking" label="Link events to other calendars" hint="Show Add to another calendar in event details. Links stay in Mantel and require access to both profiles." />
    <PersonalOption name="hold_to_create" label="Hold and drag to create events" hint="Hold the same spot for 3 seconds, then drag to choose the end date and time. Release to finish the event." />
  </>
}

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
function LongPressDelay() {
  const api = useApi(), client = useQueryClient()
  const { data: settings } = useSettings()
  const [draft, setDraft] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (value: number) => api.patch<AppSettings>('/settings', { long_press_ms: value }),
    onSuccess: (next) => { client.setQueryData(['settings'], next); setDraft(null) },
  })
  return <div className="row row--stack">
    <label className="field"><span>Long press delay (ms)</span>
      <input type="number" min="100" max="10000" step="1" value={draft ?? settings?.long_press_ms ?? 750}
        disabled={save.isPending} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        onBlur={(e) => { if (draft !== null && e.target.checkValidity()) save.mutate(Number(draft)) }} />
    </label>
    <p className="hint">100–10000 ms. Applies to creating and moving events, for you in this profile.</p>
    {draft !== null && (!/^\d+$/.test(draft) || Number(draft) < 100 || Number(draft) > 10000) && <p role="alert">Choose a whole number from 100 to 10000 ms.</p>}
    {save.error && <p role="alert">Could not save the delay. Please try again.</p>}
  </div>
}
export function OptionalEventSettings() {
  return <>
    <PersonalOption name="show_important_counts" label="Show important event counts" hint="Show the number of important visible events beside each date. Days without important events have no count." />
    <PersonalOption name="enable_event_linking" label="Link events to other calendars" hint="Show Add to another calendar in event details. Links stay in Mantel and require access to both profiles." />
    <PersonalOption name="hold_to_create" label="Hold and drag to create or move events" hint="Hold an empty spot to select a new event's duration. Hold an existing event to move it while keeping its duration." />
    <LongPressDelay />
  </>
}

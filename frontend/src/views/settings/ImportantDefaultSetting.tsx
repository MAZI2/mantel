import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../../api/client'
import { useSettings } from '../../api/hooks'
import type { AppSettings } from '../../api/types'

export function ImportantDefaultSetting() {
  const api = useApi()
  const client = useQueryClient()
  const { data: settings } = useSettings()
  const [selection, setSelection] = useState<boolean | null>(null)
  const save = useMutation({
    mutationFn: (value: boolean) => api.patch<AppSettings>('/settings', { important_by_default: value }),
    onSuccess: (next) => { client.setQueryData(['settings'], next); setSelection(null) },
    onError: () => setSelection(null),
  })
  return <div className="row row--stack">
    <label className="toggle">
      <input type="checkbox" checked={selection ?? settings?.important_by_default ?? true}
        disabled={save.isPending} onChange={(e) => {
          setSelection(e.target.checked)
          save.mutate(e.target.checked)
        }} /> Important by default
    </label>
    <p className="hint">Your default for new and previously unseen events, across all your profiles. Existing marks stay as you set them.</p>
    {save.error && <p role="alert">Could not save your default. Please try again.</p>}
  </div>
}

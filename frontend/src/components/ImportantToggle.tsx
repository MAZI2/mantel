import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../api/client'
import { useSettings } from '../api/hooks'
import type { AppSettings } from '../api/types'

export function ImportantToggle() {
  const api = useApi()
  const { data: settings } = useSettings()
  const client = useQueryClient()
  const [selection, setSelection] = useState<boolean | null>(null)
  const active = selection ?? settings?.highlight_important ?? false
  const save = useMutation({
    mutationFn: (value: boolean) => api.patch<AppSettings>('/settings', { highlight_important: value }),
    onSuccess: (next) => { client.setQueryData(['settings'], next); setSelection(null) },
    onError: () => setSelection(null),
  })
  return <>
    <button className="navbtn profile-importance" aria-label="Highlight important events"
      aria-pressed={active} disabled={save.isPending}
      title="Dim events you have not marked important"
      onClick={() => { setSelection(!active); save.mutate(!active) }}>
      <StarIcon filled={active} />
    </button>
    {save.error && <p className="profile-importance-error" role="alert">Could not save the star filter. Please try again.</p>}
  </>
}

export function StarIcon({ filled = false }: { filled?: boolean }) {
  return <svg className="navbtn__icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"
    fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" />
  </svg>
}

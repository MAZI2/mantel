import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { selectProfile } from '../api/client'
import { ProfilesTab } from '../views/settings/ProfilesTab'

export interface ProfileInfo {
  id: string
  name: string
  position: number
  active: boolean
  legacy: boolean
}

export interface SessionInfo {
  identity: string
  name: string
  is_admin: boolean
  default_profile_id: string | null
  profiles: ProfileInfo[]
}

const SessionContext = createContext<SessionInfo | null>(null)
export function useSession(): SessionInfo {
  const session = useContext(SessionContext)
  if (!session) throw new Error('Session has not loaded')
  return session
}

export function newQueryClient() {
  return new QueryClient({ defaultOptions: {
    queries: { refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 15_000, retry: 1 },
  } })
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [error, setError] = useState('')
  const [client] = useState(newQueryClient)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/session', { cache: 'no-store' })
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message || 'Could not load your profiles.')
        if (cancelled) return
        const info = body as SessionInfo
        const requested = new URLSearchParams(window.location.search).get('profile')
        const id = requested || info.default_profile_id || ''
        if (id && !info.profiles.some((p) => p.id === id)) {
          throw new Error('This profile is not available to your identity. Open the home page to use your default profile.')
        }
        selectProfile(info.identity, id)
        setSession(info)
        setReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your profiles.')
      }
    })()
    return () => { cancelled = true }
  }, [])
  if (error) return <main className="session-message"><h1>Calendar access</h1><p role="alert">{error}</p><a href="/">Open home</a></main>
  if (!ready || !session) return <main className="session-message" role="status">Loading your profiles…</main>
  return (
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={client}>
        {session.profiles.length ? children : session.is_admin ? (
          <main className="session-message"><ProfilesTab /></main>
        ) : <main className="session-message"><h1>No profiles assigned</h1><p>Ask your administrator to add you to a profile.</p></main>}
      </QueryClientProvider>
    </SessionContext.Provider>
  )
}

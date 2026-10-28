import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { ApiContext, ApiError, createApi, selectProfile, type ProfileApi } from '../api/client'
import { eventQueryOptions } from '../api/hooks'
import type { AppSettings, CalendarInfo, LinkedAccount, User } from '../api/types'
import { applyTheme } from '../theme'
import { rangeFor } from '../views/calendar/dateRange'
import { ProfilesTab } from '../views/settings/ProfilesTab'
import { ProfileNavigation } from './ProfileNavigation'

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

interface LoadedProfile {
  attempt: number
  id: string
  session: SessionInfo
  client: QueryClient
  api: ProfileApi
  settings?: AppSettings
}

async function readSession(signal: AbortSignal): Promise<SessionInfo> {
  const response = await fetch('/api/session', { cache: 'no-store', signal })
  const body = await response.json()
  if (!response.ok) throw new Error(body?.error?.message || 'Could not load your profiles.')
  signal.throwIfAborted()
  return body as SessionInfo
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const requested = new URLSearchParams(useLocation().search).get('profile')
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [loaded, setLoaded] = useState<LoadedProfile | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const id = requested || session?.default_profile_id || ''
  const ready = !loading && loaded?.id === id && loaded.attempt === attempt
  const error = failure?.id === id ? failure.message : ''

  useEffect(() => {
    const controller = new AbortController()
    void readSession(controller.signal).then(setSession).catch((e) => {
      if (!controller.signal.aborted) setFailure({ id, message: e.message })
    })
    return () => controller.abort()
  }, [attempt])

  useLayoutEffect(() => {
    if (!session) return
    setLoading(true)
    const controller = new AbortController()
    const client = newQueryClient()
    setFailure(null)
    void (async () => {
      try {
        const verified = loaded ? await readSession(controller.signal) : session
        if (verified.identity !== session.identity) {
          throw new Error('Your sign-in changed. Open the home page to reload your profiles.')
        }
        if (id && !verified.profiles.some((p) => p.id === id)) {
          throw new Error('This profile is not available to your identity. Open the home page to use your default profile.')
        }
        const api = createApi(id, controller.signal)
        let settings: AppSettings | undefined
        if (id) {
          // Fetch independent resources together, then use the actual week settings.
          // Nothing renders with fallback hours, scale, theme or an empty event list.
          const optional = async <T,>(request: Promise<T>) => {
            try { return await request } catch (error) {
              if (error instanceof ApiError && [401, 403].includes(error.status)) throw error
              // Data failures belong in the mounted page, where Settings and profile
              // switching remain available. Access failures still stop the profile.
              return undefined
            }
          }
          const [saved] = await Promise.all([
            client.fetchQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/settings') }),
            optional(client.fetchQuery({ queryKey: ['accounts'], queryFn: () => api.get<LinkedAccount[]>('/accounts') })),
            optional(client.fetchQuery({ queryKey: ['calendars'], queryFn: () => api.get<CalendarInfo[]>('/calendars') })),
            optional(client.fetchQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') })),
          ])
          settings = saved
          const range = rangeFor('week', new Date(), settings.first_day_of_week === 1 ? 1 : 0)
          await optional(client.fetchQuery(eventQueryOptions(api, range.start, range.end)))
        }
        controller.signal.throwIfAborted()
        selectProfile(verified.identity, id)
        setLoaded({ attempt, id, session: verified, client, api, settings })
        setLoading(false)
      } catch (e) {
        if (!controller.signal.aborted) {
          setFailure({ id, message: e instanceof Error ? e.message : 'Could not load this profile.' })
        }
      }
    })()
    return () => {
      // Old mutations keep their bound profile, and aborted follow-up calls cannot
      // touch a new profile or paint late results into its query cache.
      controller.abort()
      client.clear()
    }
  }, [id, session, attempt])

  useLayoutEffect(() => {
    if (ready && loaded.settings) {
      applyTheme(loaded.settings.theme)
      document.documentElement.dataset.scale = loaded.settings.display_scale
    }
    if (ready || error) document.documentElement.removeAttribute('data-booting')
  }, [ready, loaded, error])

  if (error) return <main className="session-message"><h1>Calendar access</h1><p role="alert">{error}</p><button className="btn" onClick={() => { setFailure(null); setAttempt((n) => n + 1) }}>Retry</button> <a href="/">Open home</a></main>
  if (!ready || !loaded) return (
    <div className="shell shell--profiles" aria-busy="true">
      <main className="shell__main profile-loading"><p role="status">Loading profile…</p></main>
      {loaded && <ProfileNavigation session={loaded.session} activeId={loaded.id} />}
    </div>
  )
  return (
    <SessionContext.Provider value={loaded.session}>
      <ApiContext.Provider value={loaded.api}>
        <QueryClientProvider key={`${loaded.id}:${attempt}`} client={loaded.client}>
          {loaded.session.profiles.length ? children : loaded.session.is_admin ? (
            <main className="session-message"><ProfilesTab /></main>
          ) : <main className="session-message"><h1>No profiles assigned</h1><p>Ask your administrator to add you to a profile.</p></main>}
        </QueryClientProvider>
      </ApiContext.Provider>
    </SessionContext.Provider>
  )
}

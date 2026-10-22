import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApi, type ProfileApi } from './client'
import type {
  AppSettings,
  CalendarEvent,
  CalendarInfo,
  EventInput,
  LinkedAccount,
  SyncStatus,
  ScopedEventDeletion,
  User,
  Weather,
} from './types'

export function useUsers() {
  const api = useApi()
  return useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') })
}

export function useCalendars() {
  const api = useApi()
  return useQuery({ queryKey: ['calendars'], queryFn: () => api.get<CalendarInfo[]>('/calendars') })
}

export function useAccounts() {
  const api = useApi()
  return useQuery({ queryKey: ['accounts'], queryFn: () => api.get<LinkedAccount[]>('/accounts') })
}

export function useSettings() {
  const api = useApi()
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/settings') })
}

export function useWeather() {
  const api = useApi()
  return useQuery({
    queryKey: ['weather'],
    queryFn: () => api.get<Weather>('/weather'),
    // Upstream data only moves every half hour; polling harder just annoys NWS.
    refetchInterval: 15 * 60_000,
    staleTime: 10 * 60_000,
  })
}

export function eventQueryOptions(api: ProfileApi, start: Date, end: Date, userIds: number[] = []) {
  const s = start.toISOString()
  const e = end.toISOString()
  // Sorted so ['1','2'] and ['2','1'] share one cache entry instead of two.
  const people = [...userIds].sort((a, b) => a - b).join(',')
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return {
    queryKey: ['events', s, e, people, timezone],
    queryFn: () => {
      const params = new URLSearchParams({ start: s, end: e, timezone })
      if (people) params.set('user_ids', people)
      return api.get<CalendarEvent[]>(`/events?${params}`)
    },
  }
}

export function useEvents(start: Date, end: Date, userIds: number[] = []) {
  const api = useApi()
  return useQuery(eventQueryOptions(api, start, end, userIds))
}

/** Everything that can change the calendar invalidates the same key, so every open
 *  screen converges on the next refetch. */
function useCalendarMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['events'] })
    },
  })
}

export function useCreateEvent() {
  const api = useApi()
  return useCalendarMutation((input: EventInput) => api.post<CalendarEvent>('/events', input))
}

export function useUpdateEvent() {
  const api = useApi()
  return useCalendarMutation(({ id, ...patch }: Partial<EventInput> & { id: number }) =>
    api.patch<CalendarEvent>(`/events/${id}`, patch),
  )
}

export function useDeleteEvent() {
  const api = useApi()
  return useCalendarMutation((input: number | ScopedEventDeletion) => {
    if (typeof input === 'number') return api.del<void>(`/events/${input}`)
    const { id, ...params } = input
    return api.del<void>(`/events/${id}?${new URLSearchParams(params)}`)
  })
}

export function useSyncNow() {
  const api = useApi()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await api.post('/sync/run')
      // A provider failure is recorded in status even when the sync endpoint returns 200.
      const status = await api.get<SyncStatus>('/sync/status')
      qc.setQueryData(['sync-status'], status)
      const failed = status.calendars.filter((calendar) => calendar.sync_enabled && calendar.sync_error)
      if (failed.length) {
        throw new Error(failed.map((calendar) => `${calendar.name}: ${calendar.sync_error}`).join('; '))
      }
      if (status.accounts_needing_reauth.length) {
        throw new Error(`Reconnect these accounts in Settings: ${status.accounts_needing_reauth.join(', ')}`)
      }
    },
    // Refresh the grid even after a partial failure: other calendars may have synced.
    onSettled: () => Promise.all(
      ['events', 'calendars', 'accounts', 'sync-status'].map((key) =>
        qc.invalidateQueries({ queryKey: [key] }),
      ),
    ),
  })
}

export function useEntityMutation<TVars, TData>(fn: (v: TVars) => Promise<TData>, keys: string[]) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] })),
  })
}

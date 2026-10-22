import { createContext, useContext } from 'react'

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

let activeProfileId = ''
let activeIdentity = ''

export function selectProfile(identity: string, profileId: string) {
  activeIdentity = identity
  activeProfileId = profileId
}

export function profileHref(path: string, id = activeProfileId): string {
  const url = new URL(path, window.location.origin)
  if (id) url.searchParams.set('profile', id)
  return `${url.pathname}${url.search}${url.hash}`
}

export function profileStorageKey(key: string): string {
  return activeProfileId ? `${key}:${activeIdentity}:${activeProfileId}` : key
}

async function request<T>(
  profileId: string, signal: AbortSignal | undefined, path: string, init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    signal,
    cache: 'no-store',
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(profileId ? { 'X-Mantel-Profile': profileId } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let code = 'error'
    let message = res.statusText
    try {
      const body = await res.json()
      code = body?.error?.code ?? code
      message = body?.error?.message ?? message
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, message, res.status)
  }
  const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T)
  signal?.throwIfAborted()
  return data
}

/** Each mounted profile owns its client. Delayed callbacks keep their original
 *  headers and cannot send a follow-up request to a newly selected profile. */
export function createApi(profileId: string, signal?: AbortSignal) {
  return {
    get: <T>(path: string) => request<T>(profileId, signal, path),
    post: <T>(path: string, body?: unknown) =>
      request<T>(profileId, signal, path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
    patch: <T>(path: string, body: unknown) =>
      request<T>(profileId, signal, path, { method: 'PATCH', body: JSON.stringify(body) }),
    put: <T>(path: string, body: unknown) =>
      request<T>(profileId, signal, path, { method: 'PUT', body: JSON.stringify(body) }),
    upload: <T>(path: string, body: FormData) => request<T>(profileId, signal, path, { method: 'POST', body }),
    del: <T>(path: string) => request<T>(profileId, signal, path, { method: 'DELETE' }),
  }
}
export type ProfileApi = ReturnType<typeof createApi>
export const ApiContext = createContext<ProfileApi | null>(null)
export function useApi(): ProfileApi {
  const api = useContext(ApiContext)
  if (!api) throw new Error('Profile API has not loaded')
  return api
}

export interface VersionInfo {
  version: string
  build_time: string
  // Null/false until the server's daily GitHub check has succeeded.
  latest_version?: string | null
  update_available?: boolean
  checked_at?: string | null
  release_url?: string | null
}

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

export function profileHeaders(): Record<string, string> {
  return activeProfileId ? { 'X-Mantel-Profile': activeProfileId } : {}
}

export function profileHref(path: string, id = activeProfileId): string {
  const url = new URL(path, window.location.origin)
  if (id) url.searchParams.set('profile', id)
  return `${url.pathname}${url.search}${url.hash}`
}

export function profileStorageKey(key: string): string {
  return activeProfileId ? `${key}:${activeIdentity}:${activeProfileId}` : key
}

export function personalStorageKey(key: string): string {
  return `${key}:${activeIdentity}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...profileHeaders(), ...(init?.headers ?? {}) },
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
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
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

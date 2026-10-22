import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApi, selectProfile } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('profile request isolation', () => {
  it('keeps delayed follow-up requests bound to the original profile', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const original = createApi('personal')
    await original.post('/sync/run')
    selectProfile('person', 'shared')
    await original.get('/sync/status')
    const shared = createApi('shared')
    await shared.get('/events')
    expect(fetch.mock.calls.map(([, init]) => init.headers['X-Mantel-Profile'])).toEqual([
      'personal', 'personal', 'shared',
    ])
  })

  it('rejects a late response after leaving its profile', async () => {
    const controller = new AbortController()
    let complete!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { complete = resolve })))
    const pending = createApi('personal', controller.signal).get('/settings')
    controller.abort()
    complete(new Response('{"theme":"hearth"}'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

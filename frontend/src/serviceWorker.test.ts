import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function worker() {
  const stores = new Map<string, Map<string, string>>([
    ['famcal-data-local', new Map([['http://calendar.test/api/events', 'private events']])],
    ['famcal-shell-old', new Map([['http://calendar.test/api/photos/1/file', 'private photo']])],
    ['famcal-shell-local', new Map([
      ['http://calendar.test/api/photos/1/file', 'private photo'],
      ['http://calendar.test/assets/app.js', 'public code'],
    ])],
    ['unrelated-cache', new Map([['http://calendar.test/example', 'unrelated']])],
  ])
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (key: string) => stores.delete(key),
    open: async (key: string) => {
      if (!stores.has(key)) stores.set(key, new Map())
      const entries = stores.get(key)!
      return {
        keys: async () => [...entries.keys()].map((url) => ({ url })),
        delete: async (request: { url: string }) => entries.delete(request.url),
      }
    },
  }
  const handlers: Record<string, (event: unknown) => void> = {}
  const fetch = vi.fn()
  const claim = vi.fn()
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    caches, fetch, URL,
    self: {
      location: new URL('http://calendar.test/sw.js?v=local'),
      clients: { claim }, skipWaiting: vi.fn(),
      addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler },
    },
  })
  return { stores, handlers, fetch, claim }
}

describe('private profile data in the service worker', () => {
  it('removes old private caches including photos mixed into the current shell cache', async () => {
    const { stores, handlers, claim } = worker()
    let completion: Promise<unknown> | undefined
    handlers.activate({ waitUntil: (work: Promise<unknown>) => { completion = work } })
    await completion
    expect(stores.has('famcal-data-local')).toBe(false)
    expect(stores.has('famcal-shell-old')).toBe(false)
    expect([...stores.get('famcal-shell-local')!.keys()]).toEqual(['http://calendar.test/assets/app.js'])
    expect(stores.has('unrelated-cache')).toBe(true)
    expect(claim).toHaveBeenCalledOnce()
  })

  it('leaves every API request to the network even when an old cached response exists', () => {
    const { handlers, fetch } = worker()
    for (const path of ['/api/events', '/api/settings?profile=other', '/api/photos/1/file', '/api/session', '/api/version']) {
      for (const mode of ['cors', 'navigate']) {
        const respondWith = vi.fn()
        handlers.fetch({ request: { method: 'GET', url: `http://calendar.test${path}`, mode }, respondWith })
        expect(respondWith).not.toHaveBeenCalled()
      }
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

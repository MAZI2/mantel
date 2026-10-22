import { ImportantToggle } from './components/ImportantToggle'
import { useEffect, useInsertionEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useSettings } from './api/hooks'
import { bookmarkLabel, safeBookmarkUrl } from './components/bookmark'
import { Screensaver } from './components/Screensaver'
import { useVersionPoll } from './hooks/useVersionPoll'
import { ProfileNavigation } from './profiles/ProfileNavigation'
import { useSession } from './profiles/ProfileProvider'
import { useBurnInShift } from './hooks/useIdle'
import { useOnline } from './hooks/useOnline'
import { useViewportFit } from './hooks/useViewportFit'
import { applyTheme, isThemeId } from './theme'

export function App() {
  const session = useSession()
  const location = useLocation()
  const activeId = new URLSearchParams(location.search).get('profile') || session.default_profile_id
  useVersionPoll()
  const { data: settings } = useSettings()

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const check = async () => {
      try {
        const response = await fetch('/api/session', { cache: 'no-store', signal: controller.signal })
        if (cancelled) return
        if (!response.ok) { window.location.reload(); return }
        const next = await response.json()
        if (cancelled) return
        if (next.identity !== session.identity || next.is_admin !== session.is_admin ||
            !next.profiles.some((p: { id: string }) => p.id === activeId)) window.location.assign('/')
        else if (JSON.stringify(next.profiles) !== JSON.stringify(session.profiles)) window.location.reload()
      } catch { /* Keep the current screen while offline. */ }
    }
    const timer = setInterval(() => void check(), 30_000)
    const focus = () => void check()
    window.addEventListener('focus', focus)
    window.addEventListener('mantel:access-changed', focus)
    return () => { cancelled = true; controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('mantel:access-changed', focus) }
  }, [session, activeId])

  // Keeps the app the height of the space actually available, so a phone keyboard
  // never covers the nav or a modal's Save button.
  useViewportFit()

  const shift = useBurnInShift(settings?.burn_in_shift ?? false)
  const online = useOnline()

  // Optional shortcut to somewhere else in the house. No bookmark, no bar --
  // the grid row collapses, so nobody pays vertical space for a feature they
  // haven't set up. That matters on a wall display.
  const bookmark = safeBookmarkUrl(settings?.bookmark_url)

  // Apply CSS variables before child layout effects measure the grid and scroll it.
  useInsertionEffect(() => {
    document.documentElement.dataset.scale = settings?.display_scale ?? 'normal'
    if (isThemeId(settings?.theme)) applyTheme(settings.theme)
  }, [settings?.display_scale, settings?.theme])

  return (
    <div
      className="shell shell--profiles"
      style={{ transform: `translate(${shift.x}px, ${shift.y}px)`, transition: 'transform 2s ease-in-out' }}
    >
      {bookmark && (
        <div className="topbar">
          <a className="topbar__link" href={bookmark} rel="noreferrer">
            <span aria-hidden>🔗</span>
            {bookmarkLabel(settings?.bookmark_label, bookmark)}
          </a>
        </div>
      )}
      <main className="shell__main">
        <Outlet />
      </main>
      <ProfileNavigation session={session} activeId={activeId} importanceToggle={<ImportantToggle />} />
      {!online && <div className="offline">Offline — showing the last known schedule</div>}
      <Screensaver />
    </div>
  )
}

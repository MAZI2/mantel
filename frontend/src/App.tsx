import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useSettings } from './api/hooks'
import { bookmarkLabel, safeBookmarkUrl } from './components/bookmark'
import { Screensaver } from './components/Screensaver'
import { useVersionPoll } from './hooks/useVersionPoll'
import { profileHref } from './api/client'
import { useSession } from './profiles/ProfileProvider'
import { useBurnInShift } from './hooks/useIdle'
import { useOnline } from './hooks/useOnline'
import { useViewportFit } from './hooks/useViewportFit'
import { applyTheme, isThemeId } from './theme'

export function App() {
  const session = useSession()
  const navigate = useNavigate()
  const activeId = new URLSearchParams(useLocation().search).get('profile') || session.default_profile_id
  useVersionPoll()
  const { data: settings } = useSettings()
  const onCalendar = useLocation().pathname.startsWith('/calendar')

  useEffect(() => {
    const check = async () => {
      try {
        const response = await fetch('/api/session', { cache: 'no-store' })
        if (!response.ok) { window.location.reload(); return }
        const next = await response.json()
        if (next.identity !== session.identity || next.is_admin !== session.is_admin ||
            !next.profiles.some((p: { id: string }) => p.id === activeId)) window.location.assign('/')
        else if (JSON.stringify(next.profiles) !== JSON.stringify(session.profiles)) window.location.reload()
      } catch { /* Keep the current screen while offline. */ }
    }
    const timer = setInterval(() => void check(), 30_000)
    const focus = () => void check()
    window.addEventListener('focus', focus)
    window.addEventListener('mantel:access-changed', focus)
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('mantel:access-changed', focus) }
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

  useEffect(() => {
    document.documentElement.dataset.scale = settings?.display_scale ?? 'normal'
  }, [settings?.display_scale])

  useEffect(() => {
    // An unrecognised value (a newer server, a hand-edited row) keeps whatever is
    // already showing rather than blanking every token.
    if (isThemeId(settings?.theme)) applyTheme(settings.theme)
  }, [settings?.theme])

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
      <nav className="shell__nav">
        <div className="profile-nav" role="group" aria-label="Profiles">
          {session.profiles.map((profile) => (
            <button key={profile.id} className="navbtn" aria-pressed={profile.id === activeId}
              aria-current={onCalendar && profile.id === activeId ? 'page' : undefined}
              onClick={() => {
                const target = profileHref('/calendar/week', profile.id)
                // A fresh app instance gives each profile its own query/mutation
                // lifecycle; a slow request cannot finish in another profile's UI.
                if (profile.id === activeId) void navigate(target)
                else window.location.assign(target)
              }}>
              {profile.name}
            </button>
          ))}
        </div>
        <NavLink to={profileHref('/settings')} className="navbtn profile-settings">Settings</NavLink>
      </nav>
      {!online && <div className="offline">Offline — showing the last known schedule</div>}
      <Screensaver />
    </div>
  )
}

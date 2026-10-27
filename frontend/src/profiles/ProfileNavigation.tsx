import { StarIcon } from '../components/ImportantToggle'
import { Fragment, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { profileHref } from '../api/client'
import type { SessionInfo } from './ProfileProvider'

export function ProfileNavigation({ session, activeId, importanceToggle, calendarPicker }: { session: SessionInfo; activeId: string | null; importanceToggle?: ReactNode; calendarPicker?: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const onCalendar = location.pathname.startsWith('/calendar')
  const onSettings = location.pathname === '/settings'
  return (
    <nav className="shell__nav">
      <div className="profile-nav" role="group" aria-label="Profiles">
        {session.profiles.map((profile) => profile.id === activeId && calendarPicker ? (
          <Fragment key={profile.id}>{calendarPicker}</Fragment>
        ) : (
          <button key={profile.id} className="navbtn" aria-pressed={profile.id === activeId}
            aria-current={onCalendar && profile.id === activeId ? 'page' : undefined}
            onClick={() => void navigate(profileHref('/calendar/week', profile.id))}>
            {profile.name}
          </button>
        ))}
      </div>
      {importanceToggle ?? <button className="navbtn profile-importance" aria-label="Highlight important events" disabled><StarIcon /></button>}
      <Link to={profileHref(onSettings ? '/calendar/week' : '/settings', activeId || '')}
        aria-current={onSettings ? 'page' : undefined} className="navbtn profile-settings">Settings</Link>
    </nav>
  )
}

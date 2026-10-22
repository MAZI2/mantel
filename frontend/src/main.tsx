import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom'
import { App } from './App'
import './styles/global.css'
import './styles/calendar.css'
import './styles/settings.css'
import './styles/dashboard.css'
import './styles/screensaver.css'
import { CalendarPage } from './views/calendar/CalendarPage'
import { DashboardPage } from './views/dashboard/DashboardPage'
import { ListsPage } from './views/lists/ListsPage'
import { SettingsPage } from './views/settings/SettingsPage'
import { ProfileProvider } from './profiles/ProfileProvider'
import { profileHref } from './api/client'

function WeekRedirect() {
  return <Navigate to={profileHref('/calendar/week')} replace />
}

function DocsRedirect() {
  return <Navigate to={profileHref('/settings?tab=api')} replace />
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <ProfileProvider><App /></ProfileProvider>,
    children: [
      { index: true, element: <WeekRedirect /> },
      { path: 'calendar/week', element: <CalendarPage /> },
      { path: 'calendar/:view', element: <WeekRedirect /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'lists', element: <ListsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      // The API guide used to be its own page. Keep old bookmarks and kiosk
      // shortcuts working by sending them to the tab that replaced it.
      { path: 'docs', element: <DocsRedirect /> },
      { path: '*', element: <WeekRedirect /> },
    ],
  },
])

// Registered after load so the worker never competes with the first paint.
// The worker deliberately leaves /api/version alone -- see public/sw.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // The version is in the URL so a new release registers a new worker, whose
    // activate step purges the previous release's caches.
    const v = encodeURIComponent(import.meta.env.VITE_APP_VERSION ?? 'dev')
    void navigator.serviceWorker.register(`/sw.js?v=${v}`)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

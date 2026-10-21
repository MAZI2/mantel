import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseURL = process.env.PREVIEW_URL ?? 'http://localhost:8081'
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] })
const settings = await (await fetch(`${baseURL}/api/settings`)).json()
const errors = []

async function open({ viewport = { width: 1280, height: 720 }, scale = 'normal', allDay = false,
  weekStartsOn = 1, dayStartHour = 0, dayEndHour = 24,
  time = '2026-10-21T12:00:00+02:00', path = '/' } = {}) {
  const context = await browser.newContext({ baseURL, viewport, timezoneId: 'Europe/Ljubljana',
    hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install({ time: new Date(time) })
  const savedSettings = {
    ...settings, first_day_of_week: weekStartsOn, display_scale: scale, time_format_24h: true,
    day_start_hour: dayStartHour, day_end_hour: dayEndHour, screensaver_enabled: false, sleep_enabled: false,
    burn_in_shift: false, bookmark_url: '',
  }
  await context.route('**/api/settings', (route) => {
    if (route.request().method() === 'PATCH') Object.assign(savedSettings, route.request().postDataJSON())
    return route.fulfill({ json: savedSettings })
  })
  await context.route('**/api/users', (route) => route.fulfill({ json: [] }))
  const eventRanges = []
  await context.route('**/api/events?*', (route) => {
    eventRanges.push(new URL(route.request().url()).searchParams.get('start'))
    return route.fulfill({ json: allDay ? [{
      id: 9001, calendar_id: 1, calendar_name: 'Family', title: 'All-day test',
      color: '#38bdf8', user_id: null, start_at: '2026-10-21T00:00:00Z',
      end_at: '2026-10-22T00:00:00Z', all_day: true, editable: true,
      recurring: false, origin: 'local', sync_state: 'synced',
    }] : [] })
  })
  await page.goto(path)
  await page.waitForFunction(({ scale, weekStartsOn, dayStartHour, dayEndHour }) => document.documentElement.dataset.scale === scale &&
    document.querySelectorAll('.timegrid__slot').length === (dayEndHour - dayStartHour) * 7 &&
    document.querySelector('.timegrid__dayname')?.textContent === (weekStartsOn === 1 ? 'Mon' : 'Sun'),
    { scale, weekStartsOn, dayStartHour, dayEndHour })
  return { context, page, eventRanges }
}

async function titleIs(page, title) {
  await page.waitForFunction((expected) => document.querySelector('h1')?.textContent === expected, title)
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    for (const scale of ['normal', 'large', 'wall']) {
      for (const allDay of [false, true]) {
        const { context, page } = await open({ viewport, scale, allDay })
        assert.equal(new URL(page.url()).pathname, '/calendar/week')
        assert.equal(await page.locator('.timegrid__dayhead').count(), 7)
        assert.equal(await page.locator('.viewtabs, .navviews, .timestrip').count(), 0)
        assert.equal(await page.getByRole('link', { name: 'Calendar', exact: true }).count(), 1)
        const syncBounds = await page.getByRole('button', { name: 'Sync now', exact: true }).boundingBox()
        assert.ok(syncBounds.x >= 0 && syncBounds.x + syncBounds.width <= viewport.width,
          'Sync now is outside the screen')
        if (allDay) await page.getByRole('button', { name: 'All-day test' }).waitFor()
        const body = page.locator('.timegrid__body')
        const aligned = await page.evaluate(() => {
          const headers = [...document.querySelectorAll('.timegrid__dayhead')]
          const columns = [...document.querySelectorAll('.timegrid__body .timegrid__col')]
          return headers.every((header, i) => Math.abs(header.getBoundingClientRect().x -
            columns[i].getBoundingClientRect().x) < 1)
        })
        assert.ok(aligned, 'day headers and hour columns are misaligned')
        const height = await page.locator('.timegrid__slot').first().evaluate((el) => el.getBoundingClientRect().height)
        assert.ok(Math.abs(height - 32 * { normal: 1, large: 1.2, wall: 1.45 }[scale]) < 0.1)
        for (const edge of ['start', 'end']) {
          const result = await body.evaluate((el, edge) => {
            el.scrollTop = edge === 'start' ? 0 : el.scrollHeight
            const col = el.querySelector('.timegrid__col')
            const slot = edge === 'start' ? col.firstElementChild : col.lastElementChild
            const rect = slot.getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return { slotTop: rect.top, slotBottom: rect.bottom, top: box.top, bottom: box.bottom,
              horizontalOverflow: el.scrollWidth - el.clientWidth, pageBottom: innerHeight }
          }, edge)
          assert.ok(result.slotTop >= result.top - 1, `first hour clipped: ${JSON.stringify(result)}`)
          assert.ok(result.slotBottom <= result.bottom + 1, `last hour clipped: ${JSON.stringify(result)}`)
          assert.ok(result.bottom <= result.pageBottom + 1)
          assert.ok(result.horizontalOverflow <= 1)
        }
        const title = await page.locator('h1').textContent()
        await body.hover()
        await page.mouse.wheel(900, 0)
        const session = await context.newCDPSession(page)
        const box = await body.boundingBox()
        const y = box.y + Math.min(box.height / 2, 100)
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.8, y }] })
        for (const fraction of [0.6, 0.4, 0.2]) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * fraction, y }] })
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(200)
        assert.equal(await page.locator('h1').textContent(), title, 'horizontal gestures changed the week')
        assert.equal(await body.evaluate((el) => el.scrollLeft), 0)
        if (viewport.width === 1280 && scale === 'normal' && allDay) {
          await body.evaluate((el) => { el.scrollTop = 7 * 32 })
          await page.screenshot({ path: '/tmp/mantel-week.png' })
        }
        await context.close()
      }
    }
  }
  console.log('PASS: full-day scrolling, compact rows and no horizontal navigation at 18 size/scale/all-day combinations')

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    const { context, page } = await open({ viewport })
    let syncRequests = 0
    let hasSynced = false
    let finishSync
    let syncStarted
    const started = new Promise((resolve) => { syncStarted = resolve })
    const pending = new Promise((resolve) => { finishSync = resolve })
    let serverError = false
    let calendarError = false
    await context.route('**/api/events?*', (route) => route.fulfill({ json: hasSynced ? [{
      id: 9002, calendar_id: 1, calendar_name: 'Family', title: 'Arrived after sync',
      color: '#fbd75b', color_override: null, remote_color: '#fbd75b', user_id: null,
      start_at: '2026-10-21T12:00:00Z', end_at: '2026-10-21T13:00:00Z',
      all_day: false, recurring: false, editable: true, origin: 'google', sync_state: 'synced',
    }] : [] }))
    await context.route('**/api/sync/status', (route) => route.fulfill({ json: {
      google_configured: true, icloud_linked: false, sync_enabled: true,
      interval_seconds: 300, accounts_needing_reauth: [], pending_pushes: 0,
      calendars: calendarError ? [{ calendar_id: 1, name: 'Family Google', sync_enabled: true,
        sync_error: 'Google connection failed', last_synced_at: null, account_email: 'test@example.com' }] : [],
    } }))
    await context.route('**/api/sync/run', async (route) => {
      assert.equal(route.request().method(), 'POST')
      syncRequests += 1
      syncStarted()
      await pending
      if (serverError) return route.fulfill({ status: 503,
        json: { error: { code: 'unavailable', message: 'Sync service unavailable' } } })
      hasSynced = true
      return route.fulfill({ json: { pulled: 1, pushed: 0, new_calendars: 0 } })
    })
    const button = page.getByRole('button', { name: 'Sync now', exact: true })
    await button.click()
    await started
    await page.waitForFunction(() => document.querySelector('[aria-label="Sync now"]')?.disabled)
    assert.equal(await button.textContent(), 'Syncing…')
    await button.evaluate((el) => { el.click(); el.click() })
    assert.equal(syncRequests, 1, 'a pending sync must not be started again')
    finishSync()
    await page.locator('.event-block').filter({ hasText: 'Arrived after sync' }).waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label="Sync now"]')?.textContent === 'Synced')
    await page.clock.runFor(3500)
    await page.waitForFunction(() => document.querySelector('[aria-label="Sync now"]')?.textContent === 'Sync now')

    serverError = true
    await button.click()
    await page.getByRole('alert').filter({ hasText: 'Sync service unavailable' }).waitFor()
    assert.equal(await button.isEnabled(), true)
    await page.getByRole('button', { name: 'Dismiss sync error', exact: true }).click()
    await page.getByRole('alert').waitFor({ state: 'hidden' })

    serverError = false
    calendarError = true
    await button.click()
    await page.getByRole('alert').filter({ hasText: 'Family Google: Google connection failed' }).waitFor()
    assert.equal(await button.isEnabled(), true)
    calendarError = false
    await button.click()
    await page.waitForFunction(() => document.querySelector('[aria-label="Sync now"]')?.textContent === 'Synced')
    await page.getByRole('alert').waitFor({ state: 'hidden' })
    await context.close()
  }
  console.log('PASS: toolbar sync posts once, refreshes events, reports failures and supports retry on phone and desktop')

  const { context, page, eventRanges } = await open()
  await titleIs(page, 'Oct 19 – 25, 2026')
  await page.getByRole('button', { name: 'Next week', exact: true }).evaluate((el) => { el.click(); el.click(); el.click() })
  await titleIs(page, 'Nov 9 – 15, 2026')
  await page.clock.fastForward(60_000)
  await titleIs(page, 'Nov 9 – 15, 2026')
  await page.getByRole('button', { name: 'Previous week', exact: true }).click()
  await titleIs(page, 'Nov 2 – 8, 2026')
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await titleIs(page, 'Oct 19 – 25, 2026')
  assert.ok(eventRanges.some((date) => date?.startsWith('2026-11-08')), 'navigation did not fetch the new week')
  await page.locator('.timegrid__col').first().locator('.timegrid__slot').last().click()
  await page.locator('.modal').waitFor()
  assert.ok((await page.locator('input[type="datetime-local"]').first().inputValue()).endsWith('T23:00'))
  await context.close()
  for (const path of ['/calendar/today', '/calendar/month', '/calendar/3day', '/calendar', '/unknown']) {
    const result = await open({ path })
    assert.equal(new URL(result.page.url()).pathname, '/calendar/week')
    await result.context.close()
  }
  console.log('PASS: arrows, rapid taps, Today, late-hour event creation and legacy URL redirects')

  for (const [start, end] of [[6, 23], [9, 21], [0, 24]]) {
    const { context, page } = await open({ dayStartHour: 7, dayEndHour: 22 })
    await page.goto('/settings?tab=display')
    const starts = page.getByRole('combobox', { name: 'Day starts', exact: true })
    const ends = page.getByRole('combobox', { name: 'Day ends', exact: true })
    assert.equal(await starts.inputValue(), '7')
    assert.equal(await ends.inputValue(), '22')
    assert.equal(await starts.locator('option[value="22"]').isDisabled(), true)
    assert.equal(await ends.locator('option[value="7"]').isDisabled(), true)
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH'),
      starts.selectOption(String(start)),
    ])
    await page.waitForFunction((value) => document.querySelector('[aria-label="Day starts"]')?.value === String(value), start)
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH'),
      ends.selectOption(String(end)),
    ])
    await page.getByRole('link', { name: 'Calendar', exact: true }).click()
    await page.reload()
    await page.waitForFunction((count) => document.querySelectorAll('.timegrid__slot').length === count, (end - start) * 7)
    const slots = page.locator('.timegrid__col').first().locator('.timegrid__slot')
    const hour = (value) => `${String(value).padStart(2, '0')}:00`
    assert.ok((await slots.first().getAttribute('aria-label')).endsWith(hour(start)))
    assert.ok((await slots.last().getAttribute('aria-label')).endsWith(hour(end - 1)))
    for (const edge of ['start', 'end']) {
      await page.locator('.timegrid__body').evaluate((el, edge) => { el.scrollTop = edge === 'start' ? 0 : el.scrollHeight }, edge)
      const slot = edge === 'start' ? slots.first() : slots.last()
      const bounds = await slot.boundingBox()
      const body = await page.locator('.timegrid__body').boundingBox()
      assert.ok(bounds.y >= body.y - 1 && bounds.y + bounds.height <= body.y + body.height + 1,
        `configured ${edge} hour is clipped`)
    }
    await context.close()
  }
  console.log('PASS: day start/end settings save, survive reload and control the scrollable hours')

  const colourTest = await open()
  let testCalendarId
  try {
    const { context, page } = colourTest
    const response = await context.request.post('/api/calendars', { data: {
      name: 'Browser event colour test', color_override: '#3b82f6',
    } })
    assert.equal(response.status(), 201)
    testCalendarId = (await response.json()).id
    await context.unroute('**/api/events?*')
    await page.locator('.timegrid__col').first().locator('.timegrid__slot').nth(10).click()
    const starts = page.getByLabel('Starts', { exact: true })
    const ends = page.getByLabel('Ends', { exact: true })
    assert.ok((await starts.inputValue()).endsWith('T10:00'))
    assert.ok((await ends.inputValue()).endsWith('T11:00'), 'new event should last one hour')
    await starts.fill('2026-10-21T14:00')
    assert.equal(await ends.inputValue(), '2026-10-21T15:00', 'default end should follow the start')
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Individual colour test')
    await page.getByRole('combobox', { name: 'Calendar', exact: true }).selectOption(String(testCalendarId))
    await page.getByRole('button', { name: 'Event colour #ec4899', exact: true }).click()
    const createdResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/events' && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const created = await (await createdResponse).json()
    assert.equal(created.color_override, '#ec4899')
    assert.equal(new Date(created.end_at) - new Date(created.start_at), 3_600_000)
    await page.locator('.modal').waitFor({ state: 'hidden' })

    for (const [colour, expected] of [['#123abc', '#123abc'], [null, '#3b82f6']]) {
      await page.reload()
      const event = page.locator('.event-block').filter({ hasText: 'Individual colour test' })
      await event.waitFor()
      assert.equal(await event.evaluate((el) => el.style.background),
        colour === '#123abc' ? 'rgb(236, 72, 153)' : 'rgb(18, 58, 188)')
      await event.click()
      if (colour) await page.getByLabel('Custom event colour', { exact: true }).fill(colour)
      else await page.getByRole('button', { name: 'Default colour', exact: true }).click()
      const savedResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/events/${created.id}` && response.request().method() === 'PATCH')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const saved = await (await savedResponse).json()
      assert.equal(saved.color_override, colour)
      assert.equal(saved.color, expected)
      await page.locator('.modal').waitFor({ state: 'hidden' })
    }
    await page.reload()
    const restored = page.locator('.event-block').filter({ hasText: 'Individual colour test' })
    await restored.waitFor()
    assert.equal(await restored.evaluate((el) => el.style.background), 'rgb(59, 130, 246)')
  } finally {
    if (testCalendarId) await colourTest.context.request.delete(`/api/calendars/${testCalendarId}`)
    await colourTest.context.close()
  }
  console.log('PASS: one-hour defaults and per-event preset/custom colours persist and reset in the UI')

  for (const scenario of [
    { weekStartsOn: 1, time: '2026-10-25T23:59:45+01:00', title: 'Oct 26 – Nov 1, 2026' },
    { weekStartsOn: 0, time: '2026-10-24T23:59:45+02:00', title: 'Oct 25 – 31, 2026' },
    { weekStartsOn: 1, time: '2026-12-27T23:59:45+01:00', title: 'Dec 28 – Jan 3, 2027' },
  ]) {
    const { context, page } = await open(scenario)
    await page.getByRole('button', { name: 'Previous week', exact: true }).click()
    await page.clock.fastForward(31_000)
    await titleIs(page, scenario.title)
    assert.equal(await page.locator('.timegrid__dayhead[data-today="true"]').count(), 1)
    await context.close()
  }
  for (const wakeEvent of ['focus', 'visibilitychange']) {
    const { context, page } = await open()
    await page.clock.setSystemTime(new Date('2026-11-02T08:00:00+01:00'))
    await page.evaluate((event) => (event === 'focus' ? window : document).dispatchEvent(new Event(event)), wakeEvent)
    await titleIs(page, 'Nov 2 – 8, 2026')
    await context.close()
  }
  console.log('PASS: automatic week rollover for Sunday/Monday, DST, year boundary and wake after missed weeks')
  assert.deepEqual(errors, [], 'browser JavaScript errors')
} finally {
  await browser.close()
}

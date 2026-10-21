import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseURL = process.env.PREVIEW_URL ?? 'http://localhost:8081'
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] })
const settings = await (await fetch(`${baseURL}/api/settings`)).json()
const errors = []

async function open({ viewport = { width: 1280, height: 720 }, scale = 'normal', allDay = false,
  weekStartsOn = 1, dayStartHour = 0, dayEndHour = 24,
  timezoneId = 'Europe/Ljubljana', fixtureEvents = null, fixtureUsers = [],
  time = '2026-10-21T12:00:00+02:00', path = '/' } = {}) {
  const context = await browser.newContext({ baseURL, viewport, timezoneId,
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
  await context.route('**/api/users', (route) => route.fulfill({ json: fixtureUsers }))
  const eventRanges = []
  await context.route('**/api/events?*', (route) => {
    eventRanges.push(new URL(route.request().url()).searchParams.get('start'))
    return route.fulfill({ json: fixtureEvents ?? (allDay ? [{
      id: 9001, calendar_id: 1, calendar_name: 'Family', title: 'All-day test',
      color: '#38bdf8', user_id: null, start_at: '2026-10-21T00:00:00Z',
      end_at: '2026-10-22T00:00:00Z', all_day: true, editable: true,
      recurring: false, origin: 'local', sync_state: 'synced',
    }] : []) })
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
    const users = [
      { id: 9501, name: 'Alexandria with a long family member name', color: '#38bdf8', avatar_emoji: '🌻' },
      { id: 9502, name: 'Sam', color: '#fbbf24', avatar_emoji: null },
    ]
    const events = [
      { id: 9501, title: 'Alex appointment', user_id: 9501 },
      { id: 9502, title: 'Sam appointment', user_id: 9502 },
      { id: 9503, title: 'Household reminder', user_id: null },
    ].map((event) => ({ ...event, calendar_id: 1, calendar_name: 'Family', color: '#38bdf8',
      start_at: '2026-10-21T14:00:00+02:00', end_at: '2026-10-21T15:00:00+02:00',
      all_day: false, editable: true, origin: 'local',
    }))
    const { context, page } = await open({ viewport, fixtureUsers: users, fixtureEvents: events })
    await page.evaluate(() => localStorage.setItem('famcal.hiddenPeople', '[9502]'))
    await page.reload()
    const alex = page.locator('.event-block').filter({ hasText: 'Alex appointment' })
    const sam = page.locator('.event-block').filter({ hasText: 'Sam appointment' })
    const household = page.locator('.event-block').filter({ hasText: 'Household reminder' })
    await alex.waitFor()
    await sam.waitFor({ state: 'hidden' })
    await household.waitFor()
    assert.equal(await page.locator('.calpage__bar .peoplefilter, .calpage__bar .personchip').count(), 0)
    let mutations = 0
    context.on('request', (request) => {
      if (['POST', 'PATCH', 'DELETE'].includes(request.method())) mutations += 1
    })
    const group = page.getByRole('group', { name: 'Shown on this screen', exact: true })
    const alexToggle = group.getByRole('button', { name: users[0].name, exact: true })
    const samToggle = group.getByRole('button', { name: 'Sam', exact: true })
    const settingsFilters = async () => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Calendars', exact: true }).click()
      await group.waitFor()
    }
    await settingsFilters()
    assert.equal(await alexToggle.getAttribute('aria-pressed'), 'true')
    assert.equal(await samToggle.getAttribute('aria-pressed'), 'false', 'previously hidden choices were lost')
    assert.ok(await group.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'toggles overflow on mobile')
    await alexToggle.click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('famcal.hiddenPeople')).length === 2)
    await page.getByRole('link', { name: 'Calendar', exact: true }).click()
    await household.waitFor()
    await alex.waitFor({ state: 'hidden' })
    await sam.waitFor({ state: 'hidden' })
    await page.reload()
    await household.waitFor()
    await alex.waitFor({ state: 'hidden' })

    await settingsFilters()
    await samToggle.click()
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('famcal.hiddenPeople')).includes(9502))
    await page.getByRole('link', { name: 'Calendar', exact: true }).click()
    await sam.waitFor()
    await alex.waitFor({ state: 'hidden' })
    await settingsFilters()
    assert.equal(await samToggle.getAttribute('aria-pressed'), 'true')
    assert.equal(await alexToggle.getAttribute('aria-pressed'), 'false')
    await group.getByRole('button', { name: 'Show everyone', exact: true }).click()
    await page.waitForFunction(() => localStorage.getItem('famcal.hiddenPeople') === '[]')
    await page.getByRole('link', { name: 'Calendar', exact: true }).click()
    await alex.waitFor()
    await sam.waitFor()
    await page.reload()
    await alex.waitFor()
    await sam.waitFor()
    assert.equal(mutations, 0, 'visibility preferences must not change syncing or saved events')
    await context.close()
  }
  console.log('PASS: Settings visibility toggles preserve choices, filter events after navigation/reload and restore everyone without toolbar controls')

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    for (const scale of ['normal', 'large', 'wall']) {
      const timed = (id, title, start, end) => ({
        id, calendar_id: 1, calendar_name: 'Family', title, color: '#38bdf8',
        user_id: null, start_at: `2026-10-21T${start}:00+02:00`,
        end_at: `2026-10-21T${end}:00+02:00`, all_day: false,
        recurring: false, editable: true, origin: 'local', sync_state: 'synced',
      })
      const { context, page } = await open({ viewport, scale, allDay: true, fixtureEvents: [
        timed(9101, 'Morning overlap A', '08:00', '10:00'),
        timed(9102, 'Morning overlap B', '09:00', '10:00'),
        timed(9103, 'Full-width afternoon', '10:00', '13:00'),
        timed(9104, 'Following hour', '13:00', '14:00'),
        timed(9105, 'Five minutes', '14:00', '14:05'),
      ] })
      const block = page.locator('.event-block').filter({ hasText: 'Full-width afternoon' })
      await block.scrollIntoViewIfNeeded()
      const geometry = await block.evaluate((el) => {
        const rect = (node) => {
          const r = node.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }
        }
        const col = el.parentElement
        const slots = col.querySelectorAll('.timegrid__slot')
        const overlay = getComputedStyle(col, '::after')
        const start = el.querySelector('.event-block__time')
        const end = el.querySelector('.event-block__end')
        const following = [...col.querySelectorAll('.event-block')].find((e) => e.textContent.includes('Following hour'))
        const overlaps = [...col.querySelectorAll('.event-block')].filter((e) => e.textContent.includes('Morning overlap'))
        return { block: rect(el), column: rect(col), slot: rect(slots[10]),
          endSlot: rect(slots[13]), following: rect(following), end: rect(end),
          short: rect(col.querySelector('[aria-label^="Five minutes,"]')),
          overlaps: overlaps.map(rect), radius: getComputedStyle(el).borderRadius,
          startSize: parseFloat(getComputedStyle(start).fontSize), endSize: parseFloat(getComputedStyle(end).fontSize),
          startText: start.textContent, endText: end.textContent,
          overlay: { background: overlay.backgroundImage, pointerEvents: overlay.pointerEvents, zIndex: overlay.zIndex },
          hit: el.contains(document.elementFromPoint(rect(el).left + 2, rect(slots[11]).top + 0.5)),
        }
      })
      const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.15, `${message}: ${actual} vs ${expected}`)
      near(geometry.block.left, geometry.column.left, 'left grid edge')
      near(geometry.block.right, geometry.column.right, 'right grid edge')
      near(geometry.block.top, geometry.slot.top, 'top grid edge')
      near(geometry.block.bottom, geometry.endSlot.top, 'bottom grid edge')
      near(geometry.block.bottom, geometry.following.top, 'consecutive events have a gap')
      near(geometry.overlaps[0].right, geometry.overlaps[1].left, 'overlap lanes have a gap')
      near(geometry.overlaps[1].right, geometry.column.right, 'overlap lanes leave space on the right')
      near(geometry.short.height, geometry.slot.height / 12, 'short events must retain their actual duration')
      assert.equal(geometry.radius, '0px')
      assert.ok(Math.abs(geometry.endSize - geometry.startSize * 0.75) < 0.01)
      near(geometry.end.bottom, geometry.block.bottom - 1, 'end label is not above the bottom edge')
      assert.equal(geometry.startText, '10:00')
      assert.equal(geometry.endText, '13:00')
      assert.ok(geometry.overlay.background.includes('repeating-linear-gradient'))
      assert.equal(geometry.overlay.pointerEvents, 'none')
      assert.ok(Number(geometry.overlay.zIndex) > 0)
      assert.ok(geometry.hit, 'grid lines blocked an event tap')
      if (viewport.width === 1280 && scale === 'normal' && process.env.ARTIFACT_DIR) {
        await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/timed-events.png` })
      }
      await block.click()
      await page.getByRole('dialog').waitFor()
      await context.close()
    }
  }
  console.log('PASS: square timed events align on every edge, retain short durations, show 75%-size end times and allow taps through the grid')

  for (const [date, offset] of [['2026-03-29', '+02:00'], ['2026-10-25', '+01:00']]) {
    const { context, page } = await open({ time: `${date}T12:00:00${offset}`, fixtureEvents: [{
      id: 9401, calendar_id: 1, calendar_name: 'Family', title: 'Clock-change Sunday',
      color: '#38bdf8', user_id: null, start_at: `${date}T14:00:00${offset}`,
      end_at: `${date}T15:00:00${offset}`, all_day: false, editable: true, origin: 'google',
    }, ...(date === '2026-10-25' ? [{
      id: 9402, calendar_id: 1, calendar_name: 'Family', title: 'Spans the repeated hour',
      color: '#fbbf24', user_id: null, start_at: '2026-10-25T02:30:00+02:00',
      end_at: '2026-10-25T02:15:00+01:00', all_day: false, editable: true, origin: 'local',
    }] : [])] })
    const event = page.locator('.event-block').filter({ hasText: 'Clock-change Sunday' })
    await event.scrollIntoViewIfNeeded()
    const aligned = await event.evaluate((el) => {
      const slots = el.parentElement.querySelectorAll('.timegrid__slot')
      const rect = el.getBoundingClientRect()
      return Math.abs(rect.top - slots[14].getBoundingClientRect().top) < 0.1 &&
        Math.abs(rect.bottom - slots[15].getBoundingClientRect().top) < 0.1
    })
    assert.ok(aligned, `14:00 event is on the wrong grid row on ${date}`)
    assert.equal(await event.locator('.event-block__time').textContent(), '14:00')
    if (date === '2026-10-25') {
      const repeatedHour = page.locator('.event-block').filter({ hasText: 'Spans the repeated hour' })
      assert.ok((await repeatedHour.boundingBox()).height > 0, 'a backward clock jump hid the event')
    }
    await context.close()
  }

  const weekly = await open()
  let weeklyCalendarId
  try {
    const { context, page } = weekly
    const calendar = await context.request.post('/api/calendars', { data: { name: 'DST recurrence test' } })
    assert.equal(calendar.status(), 201)
    weeklyCalendarId = (await calendar.json()).id
    await context.unroute('**/api/events?*')
    await page.getByRole('button', { name: 'Add event', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Always two pm')
    await page.getByRole('combobox', { name: 'Calendar', exact: true }).selectOption(String(weeklyCalendarId))
    await page.getByLabel('Starts', { exact: true }).fill('2026-10-21T14:00')
    await page.getByRole('button', { name: 'Weekly', exact: true }).click()
    const savedResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const saved = await (await savedResponse).json()
    assert.equal(saved.timezone, 'Europe/Ljubljana', 'series must retain the creator’s named timezone')
    await page.locator('.modal').waitFor({ state: 'hidden' })
    for (let week = 0; week < 3; week += 1) {
      if (week) await page.getByRole('button', { name: 'Next week', exact: true }).click()
      const event = page.locator('.event-block').filter({ hasText: 'Always two pm' })
      await event.waitFor()
      assert.equal(await event.locator('.event-block__time').textContent(), '14:00')
      assert.equal(await event.locator('.event-block__end').textContent(), '15:00')
      assert.equal(await event.evaluate((el) => el.style.top), '448px')
      await event.click()
      const details = page.locator('.event-details')
      await details.waitFor()
      assert.ok((await details.textContent()).includes('14:00 – 15:00'))
      await page.getByRole('button', { name: 'Close event details', exact: true }).click()
      await details.waitFor({ state: 'hidden' })
    }
  } finally {
    if (weeklyCalendarId) await weekly.context.request.delete(`/api/calendars/${weeklyCalendarId}`)
    await weekly.context.close()
  }
  console.log('PASS: recurring events stay at the same local hour across DST and clock-change Sundays align with their labels')

  for (const [viewport, scale] of [
    [{ width: 320, height: 640 }, 'normal'],
    [{ width: 390, height: 844 }, 'wall'],
    [{ width: 600, height: 400 }, 'normal'],
    [{ width: 1280, height: 720 }, 'normal'],
  ]) {
    const { context, page } = await open({ viewport, scale })
    let calendarId
    try {
      const response = await context.request.post('/api/calendars', { data: { name: 'Quick event details' } })
      assert.equal(response.status(), 201)
      calendarId = (await response.json()).id
      const longTitle = `Family appointment with a full title that must wrap on mobile ${'UnbrokenTitle'.repeat(5)}`
      const eventResponse = await context.request.post('/api/events', { data: {
        calendar_id: calendarId, title: longTitle, location: 'Main reception, second floor',
        description: 'Bring the documents.\nMeet by the entrance.',
        start_at: '2026-10-21T14:00:00+02:00', end_at: '2026-10-21T15:00:00+02:00',
      } })
      assert.equal(eventResponse.status(), 201)
      const eventId = (await eventResponse.json()).id
      await context.unroute('**/api/events?*')
      await page.reload()
      let mutations = 0
      context.on('request', (request) => {
        if (new URL(request.url()).pathname === `/api/events/${eventId}` && ['PATCH', 'DELETE'].includes(request.method())) mutations += 1
      })
      const block = page.locator('.event-block').filter({ hasText: longTitle })
      await block.click()
      const details = page.locator('.event-details')
      await details.waitFor()
      assert.equal(await page.getByRole('heading', { name: longTitle, exact: true }).count(), 1)
      assert.equal(await details.locator('input, select, textarea').count(), 0, 'opening an event should show details before the form')
      assert.ok((await details.textContent()).includes('Wed, 21 Oct 2026 · 14:00 – 15:00'))
      assert.ok((await details.textContent()).includes('Quick event details'))
      assert.ok((await details.textContent()).includes('Main reception, second floor'))
      assert.ok((await details.textContent()).includes('Bring the documents.\nMeet by the entrance.'))
      const titleFits = await details.evaluate((el) => {
        const title = el.querySelector('.event-details__title')
        const r = title.getBoundingClientRect()
        const card = el.getBoundingClientRect()
        return title.scrollWidth <= title.clientWidth + 1 && title.scrollHeight <= title.clientHeight + 1 &&
          r.left >= card.left && r.right <= card.right && card.left >= 0 && card.right <= innerWidth && card.width <= 420
      })
      assert.ok(titleFits, 'full title must wrap without clipping or horizontal overflow')
      if (viewport.width === 390 && process.env.ARTIFACT_DIR) {
        await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/event-details-phone.png` })
      }
      await page.keyboard.press('Shift+Tab')
      assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).evaluate((el) => el === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(await page.getByRole('button', { name: 'Close event details', exact: true }).evaluate((el) => el === document.activeElement), true)
      await page.keyboard.press('Escape')
      await details.waitFor({ state: 'hidden' })
      assert.equal(await block.evaluate((el) => el === document.activeElement), true)
      assert.equal(mutations, 0, 'viewing or dismissing details must not change an event')

      await block.click()
      await page.locator('.modal').click({ position: { x: 1, y: 1 } })
      await details.waitFor({ state: 'hidden' })
      await block.click()
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), longTitle)
      await page.getByLabel('Title', { exact: true }).fill(`${longTitle} updated`)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.locator('.modal').waitFor({ state: 'hidden' })
      const updated = page.locator('.event-block').filter({ hasText: `${longTitle} updated` })
      await updated.click()

      let failDelete = true
      let releaseDelete
      const pendingDelete = new Promise((resolve) => { releaseDelete = resolve })
      await context.route(`**/api/events/${eventId}`, async (route) => {
        if (route.request().method() !== 'DELETE' || !failDelete) return route.continue()
        await pendingDelete
        return route.fulfill({ status: 503, json: { error: { message: 'Could not reach the calendar. Try again.' } } })
      })
      const deletion = page.getByRole('button', { name: 'Delete', exact: true })
      await deletion.click()
      await page.getByRole('button', { name: 'Deleting…', exact: true }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true)
      releaseDelete()
      await page.getByRole('alert').filter({ hasText: 'Could not reach the calendar. Try again.' }).waitFor()
      failDelete = false
      await deletion.click()
      await page.locator('.modal').waitFor({ state: 'hidden' })
      await updated.waitFor({ state: 'hidden' })
      assert.equal((await context.request.get(`/api/events/${eventId}`)).status(), 404)
    } finally {
      if (calendarId) await context.request.delete(`/api/calendars/${calendarId}`)
      await context.close()
    }
  }
  for (const [start, end, expected] of [
    ['2026-10-21', '2026-10-22', 'Wed, 21 Oct 2026 · All day'],
    ['2026-10-24', '2026-10-26', 'Sat, 24 Oct 2026 – Sun, 25 Oct 2026 · All day'],
  ]) {
    const { context, page } = await open({ timezoneId: 'America/Los_Angeles', fixtureEvents: [{
      id: 9201, calendar_id: 1, calendar_name: 'Read-only calendar', title: 'All-day information',
      color: '#38bdf8', user_id: null, start_at: `${start}T00:00:00Z`, end_at: `${end}T00:00:00Z`,
      all_day: true, editable: false, recurring: true, recurrence_text: 'Every week', origin: 'google', sync_state: 'synced',
    }] })
    await page.locator('.timegrid__allday .chip').first().click()
    const details = page.locator('.event-details')
    await details.waitFor()
    assert.ok((await details.textContent()).includes(expected))
    assert.ok((await details.textContent()).includes('Every week'))
    assert.ok((await details.textContent()).includes('This calendar is read-only.'))
    assert.equal(await details.getByRole('button', { name: 'Edit', exact: true }).count(), 0)
    assert.equal(await details.getByRole('button', { name: 'Delete', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Close event details', exact: true }).click()
    await details.waitFor({ state: 'hidden' })
    await context.route('**/api/dashboard/widgets', (route) => route.fulfill({ json: [{
      id: 9301, widget_type: 'upcoming_events', size: 'medium', position: 0, config: {},
    }] }))
    await page.goto('/dashboard')
    await page.locator('.agenda__main').filter({ hasText: 'All-day information' }).click()
    await details.waitFor()
    assert.ok((await details.textContent()).includes(expected))
    await context.close()
  }
  console.log('PASS: compact event details wrap full mobile titles, preserve all-day dates, respect read-only calendars and support editing, deletion and retry')

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
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
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

  for (const timezoneId of ['Europe/Ljubljana', 'America/Los_Angeles', 'Pacific/Auckland']) {
    const { context, page } = await open({ timezoneId })
    let calendarId
    try {
      const response = await context.request.post('/api/calendars', { data: { name: `All-day dates ${timezoneId}` } })
      assert.equal(response.status(), 201)
      calendarId = (await response.json()).id
      await context.unroute('**/api/events?*')
      for (const [title, start, end, lastDay, chips] of [
        ['Single all-day', '2026-10-21', '2026-10-22', '2026-10-21', 1],
        ['All-day across DST', '2026-10-24', '2026-10-26', '2026-10-25', 2],
      ]) {
        const createdResponse = await context.request.post('/api/events', { data: {
          calendar_id: calendarId, title, all_day: true,
          start_at: `${start}T00:00:00Z`, end_at: `${end}T00:00:00Z`,
        } })
        assert.equal(createdResponse.status(), 201)
        const created = await createdResponse.json()
        for (const colour of ['#ec4899', '#123abc', null]) {
          await page.reload()
          const event = page.locator('.timegrid__allday .chip').filter({ hasText: title })
          await event.first().waitFor()
          assert.equal(await event.count(), chips, `${title} gained a day in ${timezoneId}`)
          await event.first().click()
          await page.getByRole('button', { name: 'Edit', exact: true }).click()
          assert.equal(await page.getByLabel('Starts', { exact: true }).getAttribute('type'), 'date')
          assert.equal(await page.getByLabel('Starts', { exact: true }).inputValue(), start)
          assert.equal(await page.getByLabel('Ends', { exact: true }).inputValue(), lastDay)
          if (colour) await page.getByLabel('Custom event colour', { exact: true }).fill(colour)
          else await page.getByRole('button', { name: 'Default colour', exact: true }).click()
          const savedResponse = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/events/${created.id}` && r.request().method() === 'PATCH')
          await page.getByRole('button', { name: 'Save', exact: true }).click()
          const saved = await (await savedResponse).json()
          assert.equal(saved.start_at.slice(0, 10), start)
          assert.equal(saved.end_at.slice(0, 10), end)
          assert.equal(saved.color_override, colour)
          await page.locator('.modal').waitFor({ state: 'hidden' })
        }
        await page.reload()
        await page.locator('.timegrid__allday .chip').filter({ hasText: title }).first().waitFor()
        assert.equal(await page.locator('.timegrid__allday .chip').filter({ hasText: title }).count(), chips)
      }
      // Creating an all-day event uses inclusive dates too, without changing the
      // one-hour default for the usual timed-event flow.
      await page.getByRole('button', { name: 'Add event', exact: true }).click()
      await page.getByRole('textbox', { name: 'Title', exact: true }).fill('New all-day')
      await page.getByRole('combobox', { name: 'Calendar', exact: true }).selectOption(String(calendarId))
      await page.getByRole('button', { name: 'All day' }).click()
      await page.getByLabel('Starts', { exact: true }).fill('2026-10-21')
      await page.getByLabel('Ends', { exact: true }).fill('2026-10-21')
      const createdResponse = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/events' && r.request().method() === 'POST')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const created = await (await createdResponse).json()
      assert.equal(created.start_at.slice(0, 10), '2026-10-21')
      assert.equal(created.end_at.slice(0, 10), '2026-10-22')
      await page.locator('.modal').waitFor({ state: 'hidden' })
      await page.locator('.timegrid__allday .chip').filter({ hasText: 'New all-day' }).waitFor()
    } finally {
      if (calendarId) await context.request.delete(`/api/calendars/${calendarId}`)
      await context.close()
    }
  }
  console.log('PASS: repeated all-day colour edits preserve single/multiple dates across DST and three time zones; new all-day events save correctly')

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

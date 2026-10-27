import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseURL = process.env.PREVIEW_URL ?? 'http://localhost:8081'
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] })
const settings = await (await fetch(`${baseURL}/api/settings`)).json()
const errors = []

async function open({ viewport = { width: 1280, height: 720 }, scale = 'normal', allDay = false,
  weekStartsOn = 1, dayStartHour = 0, dayEndHour = 24,
  timezoneId = 'Europe/Ljubljana', fixtureEvents = null, fixtureUsers = [], fixtureCalendars = null, fixtureAccounts = [],
  time = '2026-10-21T12:00:00+02:00', path = '/', holdToCreate = false, showImportantCounts = false } = {}) {
  const context = await browser.newContext({ baseURL, viewport, timezoneId,
    hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install({ time: new Date(time) })
  const savedSettings = {
    ...settings, first_day_of_week: weekStartsOn, display_scale: scale, time_format_24h: true,
    day_start_hour: dayStartHour, day_end_hour: dayEndHour, screensaver_enabled: false, sleep_enabled: false,
    burn_in_shift: false, bookmark_url: '', hold_to_create: holdToCreate, show_important_counts: showImportantCounts,
  }
  await context.route('**/api/settings', (route) => {
    if (route.request().method() === 'PATCH') Object.assign(savedSettings, route.request().postDataJSON())
    return route.fulfill({ json: savedSettings })
  })
  await context.route('**/api/accounts', (route) => route.fulfill({ json: fixtureAccounts }))
  await context.route('**/api/users', (route) => route.fulfill({ json: fixtureUsers }))
  if (fixtureCalendars) await context.route('**/api/calendars', (route) => route.fulfill({ json: fixtureCalendars }))
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
  await page.addInitScript(() => {
    const sample = () => {
      const grid = document.querySelector('.timegrid__body')
      const slot = document.querySelector('.timegrid__slot')
      if (grid && slot && !document.documentElement.hasAttribute('data-booting')) {
        window.firstCalendarFrame = {
          theme: document.documentElement.dataset.theme,
          scale: document.documentElement.dataset.scale,
          slots: document.querySelectorAll('.timegrid__slot').length,
          hourHeight: slot.getBoundingClientRect().height,
          allDay: !!document.querySelector('.timegrid__allday'),
          scrollTop: grid.scrollTop,
          maxScroll: grid.scrollHeight - grid.clientHeight,
        }
      } else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.goto(path)
  await page.waitForFunction(({ scale, weekStartsOn, dayStartHour, dayEndHour }) => document.documentElement.dataset.scale === scale &&
    document.querySelectorAll('.timegrid__slot').length === (dayEndHour - dayStartHour) * 7 &&
    document.querySelector('.timegrid__dayname')?.textContent === (weekStartsOn === 1 ? 'Mon' : 'Sun'),
    { scale, weekStartsOn, dayStartHour, dayEndHour })
  await page.waitForFunction(() => !!window.firstCalendarFrame)
  const first = await page.evaluate(() => window.firstCalendarFrame)
  assert.equal(first.theme, savedSettings.theme, 'first calendar frame used the wrong theme')
  assert.equal(first.scale, scale, 'first calendar frame used fallback sizing')
  assert.equal(first.slots, (dayEndHour - dayStartHour) * 7, 'first calendar frame used fallback hours')
  assert.equal(first.allDay, fixtureEvents ? fixtureEvents.some((e) => e.all_day) : allDay,
    'the all-day row arrived after the first calendar frame')
  const height = 32 * { normal: 1, large: 1.2, wall: 1.45 }[scale]
  assert.ok(Math.abs(first.hourHeight - height) < 0.1)
  const hour = await page.evaluate(() => new Date().getHours())
  const expectedScroll = Math.min(first.maxScroll, Math.max(0, (hour - dayStartHour - 1) * height))
  assert.ok(Math.abs(first.scrollTop - expectedScroll) <= 1, 'initial scroll position changed after paint')
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
        assert.equal(await page.locator('.timegrid__important-count').count(), 0, 'day counts are disabled by default')
        assert.equal(await page.locator('.calpage__bar .calendar-picker').count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Add event', exact: true }).textContent(), '+')
        assert.equal(await page.locator('.profile-nav button[aria-pressed=true]').count(), 1)
        assert.equal(await page.getByRole('button', { name: 'Sync now', exact: true }).count(), 0)
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
    const calendars = ['Work', 'Shared', 'Home'].map((name, i) => ({
      id: i + 9501, name, color: '#38bdf8', is_local: true, writable: true, claimed_by_user_id: null,
    }))
    const events = calendars.map((calendar, i) => ({
      id: i + 9501, title: `${calendar.name} appointment`, calendar_id: calendar.id,
      calendar_name: calendar.name, user_id: null, color: '#38bdf8',
      start_at: '2026-10-21T14:00:00+02:00', end_at: '2026-10-21T15:00:00+02:00',
      all_day: false, editable: true, origin: 'local',
    }))
    const { context, page } = await open({ viewport, fixtureCalendars: calendars, fixtureEvents: events })
    const work = page.locator('.event-block').filter({ hasText: 'Work appointment' })
    const shared = page.locator('.event-block').filter({ hasText: 'Shared appointment' })
    await work.waitFor()
    await shared.waitFor()
    assert.equal(await page.getByRole('button', { name: 'Add event', exact: true }).count(), 1)
    const picker = page.locator('.profile-nav button[aria-pressed=true]')
    await picker.click()
    const group = page.getByRole('group', { name: 'Visible calendars', exact: true })
    const dropup = await group.boundingBox(), trigger = await picker.boundingBox()
    assert.ok(dropup.y + dropup.height < trigger.y, 'calendar visibility must open above the profile button')
    assert.ok(dropup.height < viewport.height * .75, 'the drop-up should fit its content')
    assert.equal(await group.getByText('Choose calendars to show for you in this profile.', { exact: true }).count(), 0)
    await group.getByRole('checkbox', { name: 'Work', exact: true }).uncheck()
    await work.waitFor({ state: 'hidden' })
    await shared.waitFor()
    assert.ok(await group.evaluate((el) => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0))
    await page.keyboard.press('Escape')
    assert.equal(await picker.getAttribute('aria-expanded'), 'false')
    await page.reload()
    await shared.waitFor()
    await work.waitFor({ state: 'hidden' })
    await picker.click()
    await group.getByRole('checkbox', { name: 'Shared', exact: true }).uncheck()
    await shared.waitFor({ state: 'hidden' })
    await group.getByRole('button', { name: 'Show all', exact: true }).click()
    await work.waitFor()
    await shared.waitFor()
    const nav = await page.locator('.shell__nav').boundingBox()
    assert.ok(nav.y + nav.height >= viewport.height - 2, 'profiles must be in the bottom row in landscape too')
    const settingsButton = await page.getByRole('link', { name: 'Settings', exact: true }).boundingBox()
    assert.ok(settingsButton.x + settingsButton.width >= viewport.width - 20)
    assert.equal(await page.getByRole('link', { name: /Dashboard|Lists/ }).count(), 0)
    await context.close()
  }
  console.log('PASS: calendar dropdown supports simultaneous calendars, persistence and show all; profile row stays at the bottom')

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
    await page.reload()
    await page.locator('.timegrid__slot').first().waitFor()
    await context.unroute('**/api/events?*')
    await page.getByRole('button', { name: 'Add event', exact: true }).click()
    await page.getByLabel('Title', { exact: true }).fill('Always two pm')
    await page.getByRole('combobox', { name: 'Calendar', exact: true }).selectOption(String(weeklyCalendarId))
    await page.getByLabel('Starts', { exact: true }).fill('2026-10-21T14:00')
    await page.locator('.event-more summary').click()
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
      assert.equal(await details.locator('input:not([type="checkbox"]), select, textarea').count(), 0, 'opening an event should show details before the form')
      assert.equal(await details.getByRole('checkbox', { name: 'Important for me', exact: true }).count(), 1)
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
    const { context, page } = await open({ viewport, fixtureAccounts: [{ id: 1, provider: 'google', email: 'test@example.com', status: 'active' }] })
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
    const syncBounds = await button.boundingBox()
    assert.ok(syncBounds.x >= 0 && syncBounds.x + syncBounds.width <= viewport.width)
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
  for (const accounts of [
    [],
    [{ id: 1, provider: 'icloud', email: 'apple@example.test', status: 'active' }],
    [{ id: 2, provider: 'google', email: 'google@example.test', status: 'needs_reauth' }],
  ]) {
    const { context, page } = await open({ fixtureAccounts: accounts })
    const google = accounts.some((account) => account.provider === 'google')
    if (google) await page.getByRole('button', { name: 'Sync now', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Sync now', exact: true }).count(), google ? 1 : 0)
    accounts.length = 0
    await page.reload()
    await page.locator('.profile-nav button[aria-pressed=true]').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Sync now', exact: true }).count(), 0)
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
  assert.equal(await page.getByRole('dialog').count(), 0, 'a normal empty-grid click must not create an event')
  await page.getByRole('button', { name: 'Add event', exact: true }).click()
  await page.getByLabel('Starts', { exact: true }).fill('2026-10-21T23:00')
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
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
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
    await page.reload()
    await page.locator('.timegrid__slot').first().waitFor()
    await context.unroute('**/api/events?*')
    await page.getByRole('button', { name: 'Add event', exact: true }).click()
    await page.getByLabel('Starts', { exact: true }).fill('2026-10-21T10:00')
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
      else await page.getByRole('button', { name: 'Default event colour', exact: true }).click()
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
          else await page.getByRole('button', { name: 'Default event colour', exact: true }).click()
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
      await page.getByRole('checkbox', { name: 'All day', exact: true }).check()
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
  for (const [viewport, scope, expected] of [
    [{ width: 390, height: 844 }, 'this', ['2026-10-21', '2026-11-04', '2026-11-11']],
    [{ width: 1280, height: 720 }, 'future', ['2026-10-21']],
    [{ width: 390, height: 844 }, 'all', []],
  ]) {
    const { context, page } = await open({ viewport })
    let calendarId
    try {
      const calendar = await context.request.post('/api/calendars', { data: { name: 'Recurring deletion browser test' } })
      calendarId = (await calendar.json()).id
      const response = await context.request.post('/api/events', { data: {
        calendar_id: calendarId, title: 'Recurring deletion', start_at: '2026-10-21T12:00:00Z',
        end_at: '2026-10-21T13:00:00Z', timezone: 'Europe/Ljubljana', recurrence_rule: 'FREQ=WEEKLY;COUNT=4',
      } })
      const event = await response.json()
      assert.equal(response.status(), 201)
      await context.unroute('**/api/events?*')
      await page.reload()
      await page.getByRole('button', { name: 'Next week', exact: true }).click()
      const block = page.locator('.event-block').filter({ hasText: 'Recurring deletion' })
      await block.click()
      if (scope === 'all') await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      const choices = page.getByRole('group', { name: 'Delete repeating event', exact: true })
      await choices.waitFor()
      let deleted = 0
      context.on('request', (request) => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/events/${event.id}`) deleted += 1 })
      await choices.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(deleted, 0, 'opening or cancelling choices must not delete anything')
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      const label = { this: 'This event only', future: 'This and all future events', all: 'All events in this series' }[scope]
      if (scope === 'this') {
        await context.route(`**/api/events/${event.id}?*`, (route) => {
          if (route.request().method() !== 'DELETE') return route.continue()
          return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Please retry this deletion' } } })
        }, { times: 1 })
        await choices.getByRole('button', { name: label, exact: true }).click()
        await page.getByRole('alert').filter({ hasText: 'Please retry this deletion' }).waitFor()
      }
      const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/events/${event.id}` && r.status() === 204)
      await choices.getByRole('button', { name: label, exact: true }).click()
      const request = (await removed).request()
      const params = new URL(request.url()).searchParams
      assert.equal(params.get('scope'), scope)
      assert.equal(params.get('occurrence_start'), '2026-10-28T13:00:00Z')
      await page.locator('.modal').waitFor({ state: 'hidden' })
      await block.waitFor({ state: 'hidden' })
      await page.reload()
      await page.getByRole('button', { name: 'Next week', exact: true }).click()
      await titleIs(page, 'Oct 26 – Nov 1, 2026')
      await page.locator('.calpage__loading').waitFor({ state: 'hidden' })
      assert.equal(await block.count(), 0)
      const remaining = await (await context.request.get('/api/events?start=2026-10-01T00:00:00Z&end=2026-12-01T00:00:00Z')).json()
      assert.deepEqual(remaining.filter((e) => e.calendar_id === calendarId).map((e) => e.start_at.slice(0, 10)), expected)
    } finally {
      if (calendarId) await context.request.delete(`/api/calendars/${calendarId}`)
      await context.close()
    }
  }
  console.log('PASS: all three recurring deletion scopes work from details and editor, with cancellation, retry, reload and DST-safe occurrence dates')

  // Real isolated databases, two authenticated people and the administrator UI.
  const admin = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
  const adminPage = await admin.newPage()
  adminPage.on('pageerror', (e) => errors.push(e.message))
  const adminSession = await (await admin.request.get('/api/session')).json()
  const personalId = adminSession.default_profile_id
  await admin.request.patch(`/api/settings?profile=${personalId}`, { data: { theme: 'midnight' } })
  const sharedName = `Shared browser ${Date.now()}`
  const partnerIdentity = `partner-${Date.now()}`
  const partnerName = `Browser partner ${Date.now()}`
  let sharedId
  let partner
  try {
    await adminPage.goto('/settings?tab=profiles')
    await adminPage.getByRole('heading', { name: 'Profiles and access', exact: true }).waitFor()
    await adminPage.getByLabel('New profile name', { exact: true }).fill(sharedName)
    await adminPage.getByRole('button', { name: 'Create profile', exact: true }).click()
    await adminPage.getByRole('button', { name: sharedName, exact: true }).waitFor()
    sharedId = (await (await admin.request.get('/api/session')).json()).profiles.find((p) => p.name === sharedName).id
    await adminPage.getByRole('button', { name: 'Profiles', exact: true }).click()
    const addPerson = adminPage.getByRole('form', { name: 'Access for new person', exact: true })
    await addPerson.getByRole('textbox', { name: 'Identifier for new person', exact: true }).fill(partnerIdentity)
    await addPerson.getByRole('textbox', { name: 'Display name for new person', exact: true }).fill(partnerName)
    await addPerson.getByRole('checkbox', { name: sharedName, exact: true }).check()
    await addPerson.getByRole('button', { name: 'Add person', exact: true }).click()
    await adminPage.getByRole('form', { name: `Access for ${partnerName}`, exact: true }).waitFor()
    const sharedSettings = await (await admin.request.patch(`/api/settings?profile=${sharedId}`, { data: { theme: 'daylight', day_start_hour: 7 } })).json()
    // Hold the target profile's events back: its theme and calendar must appear together.
    await adminPage.evaluate(() => { window.profileDocumentMarker = 'same-document' })
    const previousTheme = await adminPage.evaluate(() => document.documentElement.dataset.theme)
    let releaseEvents
    const eventGate = new Promise((resolve) => { releaseEvents = resolve })
    const delayEvents = async (route) => {
      if (route.request().headers()['x-mantel-profile'] === sharedId) {
        const response = await route.fetch()
        await eventGate
        try { await route.fulfill({ response }) } catch { /* A rapid switch can cancel the request. */ }
      } else await route.continue()
    }
    await admin.route('**/api/events?*', delayEvents)
    await adminPage.getByRole('button', { name: sharedName, exact: true }).click()
    await adminPage.locator('.shell[aria-busy=true]').waitFor()
    assert.equal(await adminPage.locator('.timegrid').count(), 0)
    assert.equal(await adminPage.evaluate(() => document.documentElement.dataset.theme), previousTheme)
    assert.equal(await adminPage.evaluate(() => window.profileDocumentMarker), 'same-document')
    releaseEvents()
    await adminPage.waitForFunction(() => document.documentElement.dataset.theme === 'daylight')
    await adminPage.locator('.timegrid').waitFor()
    await admin.unroute('**/api/events?*', delayEvents)
    assert.equal(await adminPage.evaluate(() => window.profileDocumentMarker), 'same-document')
    assert.equal(new URL(adminPage.url()).searchParams.get('profile'), sharedId)
    assert.equal(await adminPage.locator('.timegrid__slot').count(), (sharedSettings.day_end_hour - 7) * 7)
    let releaseWeek
    const weekGate = new Promise((resolve) => { releaseWeek = resolve })
    const previousWeek = await adminPage.locator('h1').textContent()
    const delayWeek = async (route) => {
      const response = await route.fetch()
      await weekGate
      await route.fulfill({ response })
    }
    await admin.route('**/api/events?*', delayWeek)
    await adminPage.getByRole('button', { name: 'Next week', exact: true }).click()
    await adminPage.locator('.calpage__loading').waitFor()
    assert.equal(await adminPage.locator('h1').textContent(), previousWeek)
    assert.equal(await adminPage.locator('.timegrid__dayhead').count(), 7)
    releaseWeek()
    await adminPage.waitForFunction((title) => document.querySelector('h1')?.textContent !== title, previousWeek)
    await admin.unroute('**/api/events?*', delayWeek)
    await adminPage.getByRole('button', { name: 'Today', exact: true }).click()
    await adminPage.waitForFunction((title) => document.querySelector('h1')?.textContent === title, previousWeek)
    // Browser history and quick repeated switches must finish on the final profile.
    await adminPage.getByRole('button', { name: 'Personal', exact: true }).click()
    await adminPage.getByRole('button', { name: sharedName, exact: true }).click()
    await adminPage.locator('.timegrid').waitFor()
    await adminPage.waitForFunction(() => document.documentElement.dataset.theme === 'daylight')
    await adminPage.goBack()
    await adminPage.waitForFunction(() => document.documentElement.dataset.theme === 'midnight')
    await adminPage.goForward()
    await adminPage.waitForFunction(() => document.documentElement.dataset.theme === 'daylight')
    assert.equal(await adminPage.evaluate(() => window.profileDocumentMarker), 'same-document')
    // The existing Settings link toggles back to the selected profile, from any tab.
    for (const width of [390, 1280]) {
      await adminPage.setViewportSize({ width, height: 844 })
      const settingsLink = adminPage.getByRole('link', { name: 'Settings', exact: true })
      await settingsLink.click()
      await adminPage.getByRole('button', { name: 'Display', exact: true }).click()
      assert.equal(new URL(adminPage.url()).searchParams.get('profile'), sharedId)
      assert.equal(await settingsLink.getAttribute('aria-current'), 'page')
      await settingsLink.click()
      await adminPage.locator('.timegrid__dayhead').first().waitFor()
      assert.equal(new URL(adminPage.url()).pathname, '/calendar/week')
      assert.equal(new URL(adminPage.url()).searchParams.get('profile'), sharedId)
      assert.equal(await settingsLink.getAttribute('aria-current'), null)
      assert.equal(await adminPage.locator('.timegrid__dayhead').count(), 7)
    }
    await adminPage.goto('/')
    await adminPage.waitForURL(`**/calendar/week?profile=${personalId}`)
    await adminPage.locator('.profile-nav button[aria-pressed=true]').waitFor()
    assert.equal(new URL(adminPage.url()).searchParams.get('profile'), personalId)

    partner = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
      extraHTTPHeaders: { 'X-Mantel-Identity': partnerIdentity, 'X-Mantel-Proxy-Secret': 'local-preview-identity-testing-only' } })
    const page = await partner.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await page.waitForURL(`**/calendar/week?profile=${sharedId}`)
    await page.getByRole('button', { name: sharedName, exact: true }).waitFor()
    assert.equal(await page.locator('.profile-nav button').count(), 1)
    assert.equal(new URL(page.url()).searchParams.get('profile'), sharedId)
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight')
    const extraCalendar = await (await admin.request.post(`/api/calendars?profile=${sharedId}`, {
      data: { name: 'Personal visibility test' },
    })).json()
    const start = new Date()
    start.setHours(14, 0, 0, 0)
    const end = new Date(start.getTime() + 3_600_000)
    for (const [calendarId, title] of [[1, 'Shared family appointment'], [extraCalendar.id, 'Extra calendar appointment']]) {
      const created = await admin.request.post(`/api/events?profile=${sharedId}`, {
        data: { calendar_id: calendarId, title, start_at: start.toISOString(), end_at: end.toISOString() },
      })
      assert.equal(created.status(), 201)
    }
    await admin.request.patch(`/api/settings?profile=${sharedId}`, {
      data: { hidden_calendar_ids: [extraCalendar.id] },
    })
    await page.reload()
    const familyEvent = page.locator('.event-block').filter({ hasText: 'Shared family appointment' })
    const extraEvent = page.locator('.event-block').filter({ hasText: 'Extra calendar appointment' })
    await familyEvent.waitFor()
    await extraEvent.waitFor()
    await page.locator('.profile-nav button[aria-pressed=true]').click()
    await page.getByRole('group', { name: 'Visible calendars', exact: true })
      .getByRole('checkbox', { name: 'Family', exact: true }).uncheck()
    await familyEvent.waitFor({ state: 'hidden' })
    await extraEvent.waitFor()
    assert.deepEqual((await (await admin.request.get(`/api/settings?profile=${sharedId}`)).json()).hidden_calendar_ids, [extraCalendar.id])
    const otherDevice = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, serviceWorkers: 'block',
      extraHTTPHeaders: { 'X-Mantel-Identity': partnerIdentity, 'X-Mantel-Proxy-Secret': 'local-preview-identity-testing-only' } })
    try {
      const otherPage = await otherDevice.newPage()
      otherPage.on('pageerror', (e) => errors.push(e.message))
      await otherPage.goto(`/calendar/week?profile=${sharedId}`)
      await otherPage.locator('.timegrid').waitFor()
      assert.equal(await otherPage.locator('.event-block').filter({ hasText: 'Shared family appointment' }).count(), 0)
      await otherPage.locator('.event-block').filter({ hasText: 'Extra calendar appointment' }).waitFor()
      await otherPage.locator('.profile-nav button[aria-pressed=true]').click()
      const choices = otherPage.getByRole('group', { name: 'Visible calendars', exact: true })
      assert.equal(await choices.getByRole('checkbox', { name: 'Family', exact: true }).isChecked(), false)
      assert.equal(await choices.getByRole('checkbox', { name: 'Personal visibility test', exact: true }).isChecked(), true)
      await choices.getByRole('button', { name: 'Show all', exact: true }).click()
      await otherPage.locator('.event-block').filter({ hasText: 'Shared family appointment' }).waitFor()
    } finally {
      await otherDevice.close()
    }
    await page.reload()
    await familyEvent.waitFor()
    await extraEvent.waitFor()
    assert.deepEqual((await (await admin.request.get(`/api/settings?profile=${sharedId}`)).json()).hidden_calendar_ids, [extraCalendar.id])
    await admin.request.patch(`/api/settings?profile=${sharedId}`, { data: { hidden_calendar_ids: [] } })
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Profiles', exact: true }).count(), 0)
    assert.equal((await partner.request.get(`/api/settings?profile=${personalId}`)).status(), 403)
    assert.equal((await partner.request.get('/api/admin/profiles')).status(), 403)
    // Shared settings still propagate while the existing theme control saves personally.
    await page.getByRole('button', { name: 'Display', exact: true }).click()
    await page.getByRole('group', { name: 'Colour theme' }).getByRole('button', { name: 'Hearth', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'hearth')
    await page.reload()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'hearth')
    await partner.request.patch(`/api/settings?profile=${sharedId}`, { data: { day_start_hour: 9 } })
    await adminPage.getByRole('button', { name: sharedName, exact: true }).click()
    await adminPage.waitForFunction(() => document.documentElement.dataset.theme === 'daylight')
    await adminPage.waitForFunction(() => document.querySelectorAll('.timegrid__slot').length === 13 * 7)
    // The same browser can authenticate as another person without sharing its theme cache.
    await partner.setExtraHTTPHeaders({ 'X-Mantel-Identity': 'local-admin', 'X-Mantel-Proxy-Secret': 'local-preview-identity-testing-only' })
    await page.goto('/')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight')
    assert.equal(await page.evaluate((id) => localStorage.getItem(`mantel.theme:local-admin:${id}`), personalId), 'midnight')
    await page.getByRole('button', { name: sharedName, exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'daylight')
    assert.equal(await page.evaluate((id) => localStorage.getItem(`mantel.theme:local-admin:${id}`), sharedId), 'daylight')
    await page.reload()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'daylight')
    await page.getByRole('button', { name: 'Personal', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'midnight')
    await partner.setExtraHTTPHeaders({ 'X-Mantel-Identity': partnerIdentity, 'X-Mantel-Proxy-Secret': 'local-preview-identity-testing-only' })
    await page.goto('/')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'hearth')
    assert.equal(await page.evaluate(([identity, profile]) => localStorage.getItem(`mantel.theme:${identity}:${profile}`), [partnerIdentity, sharedId]), 'hearth')
    await page.goto(`/calendar/week?profile=${personalId}`)
    await page.getByRole('alert').filter({ hasText: 'not available' }).waitFor()
    await page.goto('/')
    await page.waitForURL(`**/calendar/week?profile=${sharedId}`)
    await page.getByRole('button', { name: sharedName, exact: true }).waitFor()
    await adminPage.getByRole('link', { name: 'Settings', exact: true }).click()
    await adminPage.getByRole('button', { name: 'Profiles', exact: true }).click()
    const partnerForm = adminPage.getByRole('form', { name: `Access for ${partnerName}`, exact: true })
    await partnerForm.getByRole('button', { name: 'Remove person', exact: true }).click()
    await partnerForm.waitFor({ state: 'hidden' })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.getByRole('alert').filter({ hasText: 'No Mantel access' }).waitFor()
  } finally {
    if (sharedId) await admin.request.delete(`/api/admin/people/${partnerIdentity}`)
    if (sharedId) await admin.request.patch(`/api/admin/profiles/${sharedId}`, { data: { active: false } })
    await partner?.close()
    await admin.close()
  }
  console.log('PASS: administrator creates profiles and memberships; two people get independent defaults and themes per person/profile, personal calendar visibility across devices, Settings toggle, shared settings, person removal and enforced access')

  // Personal importance and live calendar links through real isolated profile databases.
  {
    const admin = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const personId = `importance-person-${Date.now()}`
    const blockedId = `importance-blocked-${Date.now()}`
    const sourceName = `Source ${Date.now()}`
    const targetName = `Target ${Date.now()}`
    const oldSettings = await (await admin.request.get('/api/settings')).json()
    let sourceId, targetId, other, blocked, fresh
    const sourceHeaders = () => ({ 'X-Mantel-Profile': sourceId })
    try {
      sourceId = (await (await admin.request.post('/api/admin/profiles', { data: { name: sourceName, members: ['local-admin'] } })).json()).id
      targetId = (await (await admin.request.post('/api/admin/profiles', { data: { name: targetName, members: ['local-admin'] } })).json()).id
      for (const [identity, profiles] of [[personId, [sourceId, targetId]], [blockedId, [targetId]]]) {
        assert.equal((await admin.request.put(`/api/admin/people/${identity}`, { data: {
          identity, name: identity, profile_ids: profiles, default_profile_id: targetId,
        } })).status(), 200)
      }
      const make = async (title, important, allDay = false) => {
        const response = await admin.request.post(`/api/events?profile=${sourceId}`, { data: {
          calendar_id: 1, title, important, all_day: allDay,
          start_at: allDay ? '2026-10-21T00:00:00Z' : '2026-10-21T12:00:00Z',
          end_at: allDay ? '2026-10-22T00:00:00Z' : '2026-10-21T14:00:00Z',
        } })
        assert.equal(response.status(), 201)
        return response.json()
      }
      const important = await make('Important source event', true)
      const quiet = await make('Quiet source event', false)
      await make('Quiet all-day event', false, true)
      const page = await admin.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
      await page.goto(`/settings?tab=calendars&profile=${targetId}`)
      await page.getByLabel('Calendar from another profile', { exact: true }).selectOption(`${sourceId}:1`)
      await page.getByRole('button', { name: 'Add linked calendar', exact: true }).click()
      await page.getByRole('button', { name: 'Remove link', exact: true }).waitFor()
      const link = (await (await admin.request.get(`/api/calendars?profile=${targetId}`)).json()).find((cal) => cal.source_profile_id === sourceId)
      assert.ok(link)
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      const importantBlock = page.locator('.event-block').filter({ hasText: 'Important source event' })
      const quietBlock = page.locator('.event-block').filter({ hasText: 'Quiet source event' })
      const allDay = page.getByRole('button', { name: 'Quiet all-day event', exact: true })
      await quietBlock.waitFor()
      const star = page.getByRole('button', { name: 'Highlight important events', exact: true })
      assert.equal(await star.getAttribute('aria-pressed'), 'false')
      const starBounds = await star.boundingBox()
      const settingsBounds = await page.getByRole('link', { name: 'Settings', exact: true }).boundingBox()
      assert.ok(starBounds.x + starBounds.width <= settingsBounds.x + 1)
      await star.click()
      await page.waitForFunction(() => document.querySelector('.calpage')?.dataset.highlightImportant === 'true')
      assert.equal(await quietBlock.evaluate((el) => getComputedStyle(el).opacity), '0.25')
      assert.equal(await allDay.evaluate((el) => getComputedStyle(el).opacity), '0.25')
      assert.equal(await importantBlock.evaluate((el) => getComputedStyle(el).opacity), '1')
      if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/important-phone.png` })
      await quietBlock.click()
      const details = page.getByRole('dialog')
      await details.getByLabel('Important for me', { exact: true }).check()
      await page.waitForFunction(() => document.querySelectorAll('.event-block[data-important=true]').length === 2)
      await details.getByRole('button', { name: 'Edit', exact: true }).click()
      assert.equal(await page.getByLabel('Important for me', { exact: true }).isChecked(), true)
      await page.getByLabel('Title', { exact: true }).fill('Edited through imported calendar')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal((await (await admin.request.get(`/api/events/${quiet.id}`, { headers: sourceHeaders() })).json()).title, 'Edited through imported calendar')
      assert.equal((await (await admin.request.get(`/api/events/${quiet.id}`, { headers: sourceHeaders() })).json()).important, true)
      await page.reload()
      await page.locator('.timegrid').waitFor()
      assert.equal(await star.getAttribute('aria-pressed'), 'true')
      await page.getByRole('button', { name: sourceName, exact: true }).click()
      await page.locator('.profile-nav button[aria-pressed=true]').filter({ hasText: sourceName }).waitFor()
      await page.locator('.timegrid').waitFor()
      assert.equal(await star.getAttribute('aria-pressed'), 'false')
      await page.getByRole('button', { name: targetName, exact: true }).click()
      await page.locator('.profile-nav button[aria-pressed=true]').filter({ hasText: targetName }).waitFor()
      await page.locator('.timegrid').waitFor()
      assert.equal(await star.getAttribute('aria-pressed'), 'true')
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Display', exact: true }).click()
      const defaultChanged = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/settings')
      await page.getByLabel('Important by default', { exact: true }).uncheck()
      assert.equal((await defaultChanged).status(), 200)
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Add event', exact: true }).click()
      assert.equal(await page.getByLabel('Important for me', { exact: true }).isChecked(), false)
      await page.getByLabel('Title', { exact: true }).fill('Created through imported calendar')
      await page.getByLabel('Calendar', { exact: true }).selectOption(String(link.id))
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      const created = page.locator('.event-block').filter({ hasText: 'Created through imported calendar' })
      await created.waitFor()
      assert.equal(await created.evaluate((el) => getComputedStyle(el).opacity), '0.25')
      const originalEvents = await (await admin.request.get(`/api/events?profile=${sourceId}&start=2026-10-01T00:00:00Z&end=2026-12-01T00:00:00Z`)).json()
      assert.equal(originalEvents.length, 4)
      assert.ok(originalEvents.some((event) => event.title === 'Created through imported calendar'))
      fresh = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' })
      const freshPage = await fresh.newPage()
      await freshPage.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
      await freshPage.goto(`/calendar/week?profile=${targetId}`)
      await freshPage.locator('.timegrid').waitFor()
      assert.equal(await freshPage.getByRole('button', { name: 'Highlight important events', exact: true }).getAttribute('aria-pressed'), 'true')
      assert.equal(await freshPage.locator('.event-block').filter({ hasText: 'Created through imported calendar' }).evaluate((el) => getComputedStyle(el).opacity), '0.25')
      other = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
        extraHTTPHeaders: { 'X-Mantel-Identity': personId, 'X-Mantel-Proxy-Secret': 'local-preview-identity-testing-only' } })
      const otherPage = await other.newPage()
      otherPage.on('pageerror', (e) => errors.push(e.message))
      await otherPage.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
      await otherPage.goto(`/calendar/week?profile=${targetId}`)
      const theirBlock = otherPage.locator('.event-block').filter({ hasText: 'Important source event' })
      await theirBlock.waitFor()
      assert.equal(await otherPage.getByRole('button', { name: 'Highlight important events', exact: true }).getAttribute('aria-pressed'), 'false')
      await theirBlock.click()
      await otherPage.getByRole('dialog').getByLabel('Important for me', { exact: true }).uncheck()
      await otherPage.waitForFunction(() => !!document.querySelector('.event-block[data-important=false]'))
      await otherPage.getByRole('button', { name: 'Close event details', exact: true }).click()
      await otherPage.getByRole('button', { name: 'Highlight important events', exact: true }).click()
      await otherPage.waitForFunction(() => document.querySelector('.calpage')?.dataset.highlightImportant === 'true')
      assert.equal(await theirBlock.evaluate((el) => getComputedStyle(el).opacity), '0.25')
      await page.reload()
      await importantBlock.waitFor()
      assert.equal(await importantBlock.evaluate((el) => getComputedStyle(el).opacity), '1')
      assert.equal((await (await other.request.get(`/api/settings?profile=${targetId}`)).json()).important_by_default, true)
      blocked = await browser.newContext({ baseURL, serviceWorkers: 'block',
        extraHTTPHeaders: { 'X-Mantel-Identity': blockedId, 'X-Mantel-Proxy-Secret': 'local-preview-identity-testing-only' } })
      const blockedPage = await blocked.newPage()
      await blockedPage.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
      await blockedPage.goto(`/calendar/week?profile=${targetId}`)
      await blockedPage.locator('.timegrid').waitFor()
      assert.equal(await blockedPage.locator('.event-block').count(), 0)
      const virtualEvents = await (await admin.request.get(`/api/events?profile=${targetId}&start=2026-10-01T00:00:00Z&end=2026-12-01T00:00:00Z`)).json()
      assert.equal((await blocked.request.get(`/api/events/${virtualEvents[0].id}?profile=${targetId}`)).status(), 403)
      await admin.request.put(`/api/admin/people/${personId}`, { data: {
        identity: personId, name: personId, profile_ids: [targetId], default_profile_id: targetId,
      } })
      await otherPage.reload()
      await otherPage.locator('.timegrid').waitFor()
      assert.equal(await otherPage.locator('.event-block').count(), 0)
      await created.click()
      await page.getByRole('button', { name: 'Delete', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      assert.equal((await (await admin.request.get(`/api/events?profile=${sourceId}&start=2026-10-01T00:00:00Z&end=2026-12-01T00:00:00Z`)).json()).length, 3)
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Calendars', exact: true }).click()
      await page.getByRole('button', { name: 'Remove link', exact: true }).click()
      await page.getByRole('button', { name: 'Remove link', exact: true }).waitFor({ state: 'hidden' })
      assert.equal((await admin.request.get(`/api/events/${important.id}`, { headers: sourceHeaders() })).status(), 200)
    } finally {
      await admin.request.patch('/api/settings', { data: { important_by_default: oldSettings.important_by_default } })
      for (const identity of [personId, blockedId]) await admin.request.delete(`/api/admin/people/${identity}`)
      for (const id of [targetId, sourceId]) if (id) await admin.request.patch(`/api/admin/profiles/${id}`, { data: { active: false } })
      await Promise.all([other?.close(), blocked?.close(), fresh?.close(), admin.close()])
    }
    console.log('PASS: personal importance defaults and marks, 25% star filter, per-profile persistence across devices, live linked calendar editing and membership revocation')
  }

  // Optional event linking and scoped saving through the real editor.
  {
    const admin = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    let sourceId, targetId
    const sourceName = `Edit source ${Date.now()}`, targetName = `Edit target ${Date.now()}`
    try {
      sourceId = (await (await admin.request.post('/api/admin/profiles', { data: { name: sourceName, members: ['local-admin'] } })).json()).id
      targetId = (await (await admin.request.post('/api/admin/profiles', { data: { name: targetName, members: ['local-admin'] } })).json()).id
      const create = async (title, recurrence_rule = null) => {
        const response = await admin.request.post(`/api/events?profile=${sourceId}`, { data: {
          calendar_id: 1, title, recurrence_rule, important: true, timezone: 'Europe/Ljubljana',
          start_at: '2026-10-21T12:00:00Z', end_at: '2026-10-21T13:00:00Z',
        } })
        assert.equal(response.status(), 201)
        return response.json()
      }
      const original = await create('Event to link')
      await create('Scoped weekly', 'FREQ=WEEKLY;COUNT=3')
      const page = await admin.newPage()
      page.on('pageerror', (e) => errors.push(e.message))
      await page.clock.install({ time: new Date('2026-10-21T12:00:00Z') })
      await page.goto(`/calendar/week?profile=${sourceId}`)
      const eventBlock = (title) => page.locator('.event-block').filter({ hasText: title })
      await eventBlock('Event to link').click()
      assert.equal(await page.locator('.timegrid__important-count').count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Add to another calendar', exact: true }).count(), 0)
      await page.getByRole('button', { name: 'Close event details', exact: true }).click()
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Display', exact: true }).click()
      const countOption = page.getByRole('checkbox', { name: 'Show important event counts', exact: true })
      assert.equal(await countOption.isChecked(), false)
      const countsSaved = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() === 'PATCH')
      await countOption.check()
      await countsSaved
      const linkingSaved = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() === 'PATCH')
      await page.getByRole('checkbox', { name: 'Link events to other calendars', exact: true }).check()
      await linkingSaved
      const gestureSaved = page.waitForResponse((r) => r.url().includes('/api/settings') && r.request().method() === 'PATCH')
      await page.getByRole('checkbox', { name: 'Hold and drag to create events', exact: true }).check()
      await gestureSaved
      await page.getByRole('link', { name: 'Settings', exact: true }).click()
      await eventBlock('Event to link').click()
      assert.equal(await page.locator('.timegrid__important-count').textContent(), '2')
      await page.getByRole('button', { name: 'Add to another calendar', exact: true }).click()
      await page.getByLabel('Destination profile and calendar', { exact: true }).selectOption(`${targetId}:1`)
      await page.getByRole('button', { name: 'Add linked event', exact: true }).click()
      await page.getByText('Event linked.', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await page.getByRole('button', { name: 'Close event details', exact: true }).click()
      await page.getByRole('button', { name: targetName, exact: true }).click()
      await eventBlock('Event to link').waitFor()
      assert.equal(await page.locator('.calendar-picker__menu').count(), 0, 'an inactive profile should switch without opening the picker')
      assert.equal(await page.locator('.timegrid__important-count').count(), 0, 'count setting should be personal within each profile')
      await page.getByRole('button', { name: targetName, exact: true }).click()
      await page.getByRole('group', { name: 'Visible calendars', exact: true }).waitFor()
      assert.equal(new URL(page.url()).searchParams.get('profile'), targetId)
      await page.keyboard.press('Escape')
      await eventBlock('Event to link').click()
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByLabel('Title', { exact: true }).fill('Edited from linked calendar')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await eventBlock('Edited from linked calendar').waitFor()
      assert.equal((await (await admin.request.get(`/api/events/${original.id}?profile=${sourceId}`)).json()).title, 'Edited from linked calendar')
      await page.getByRole('button', { name: sourceName, exact: true }).click()
      await eventBlock('Scoped weekly').click()
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByLabel('Title', { exact: true }).fill('Only this occurrence')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const choices = page.getByRole('group', { name: 'Edit repeating event', exact: true })
      await choices.waitFor()
      await choices.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Only this occurrence')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await choices.getByRole('button', { name: 'This event only', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      await eventBlock('Only this occurrence').waitFor()
      const rows = await (await admin.request.get(`/api/events?profile=${sourceId}&start=2026-10-01T00:00:00Z&end=2026-12-01T00:00:00Z`)).json()
      assert.equal(rows.filter((e) => e.title === 'Scoped weekly').length, 2)
      assert.equal(rows.filter((e) => e.title === 'Only this occurrence').length, 1)
    } finally {
      for (const id of [targetId, sourceId]) if (id) await admin.request.patch(`/api/admin/profiles/${id}`, { data: { active: false } })
      await admin.close()
    }
  }
  console.log('PASS: optional live event-link action and recurring-save choices work through the editor')

  // Compact editor and real touch duration selection, including holds over an existing event.
  for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    const fixture = { id: 88001, calendar_id: 1, calendar_name: 'Family', title: 'Under the finger',
      color: '#38bdf8', user_id: null, start_at: '2026-10-21T14:00:00+02:00',
      end_at: '2026-10-21T15:00:00+02:00', important: true, all_day: false,
      editable: true, recurring: false, origin: 'local', sync_state: 'synced' }
    const { context, page } = await open({ viewport, fixtureEvents: [fixture], holdToCreate: true, showImportantCounts: true })
    try {
      assert.equal(await page.locator('.timegrid__dayhead').nth(2).getByLabel('1 important events', { exact: true }).count(), 1)
      assert.ok(await page.locator('.timegrid__dayhead').nth(2).evaluate((head) => {
        const date = head.querySelector('.timegrid__date-number').getBoundingClientRect()
        const count = head.querySelector('.timegrid__important-count').getBoundingClientRect()
        return Math.abs((date.top + date.bottom) / 2 - (count.top + count.bottom) / 2) < 2 && count.left >= date.right
      }), 'important-event count must stay beside the date, including today')
      await page.locator('.timegrid__col').first().locator('.timegrid__slot').nth(12).click()
      assert.equal(await page.getByRole('dialog').count(), 0)
      await page.locator('.timegrid__col').first().locator('.timegrid__slot').nth(12).tap()
      assert.equal(await page.getByRole('dialog').count(), 0, 'a short touch must not create an event')
      assert.equal(await page.locator('.timegrid__important-count').count(), 1, 'zero counts must stay hidden')
      assert.equal(await page.locator('.timegrid__important-count svg').count(), 0)
      await page.getByRole('button', { name: 'Add event', exact: true }).click()
      assert.equal(await page.getByLabel('Title', { exact: true }).evaluate((el) => document.activeElement === el), false)
      assert.equal(await page.getByLabel('Location', { exact: true }).isVisible(), false)
      assert.equal(await page.getByLabel('Who is this for?', { exact: true }).isVisible(), false)
      const flags = await page.locator('.event-flags input').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))
      assert.equal(flags.length, 2)
      assert.ok(Math.abs(flags[0] - flags[1]) < 2)
      const palette = await page.locator('.event-colour__choices').evaluate((row) => {
        const rect = row.getBoundingClientRect(), children = [...row.children].map((el) => el.getBoundingClientRect())
        return { tops: children.map((r) => r.top), fits: children.every((r) => r.left >= rect.left - 1 && r.right <= rect.right + 1) }
      })
      assert.equal(new Set(palette.tops).size, 1, 'the colour palette wrapped')
      assert.ok(palette.fits, 'colour controls escaped the row')
      await page.getByRole('button', { name: 'Default event colour', exact: true }).click()
      await page.locator('.event-more summary').click()
      assert.equal(await page.getByLabel('Location', { exact: true }).isVisible(), true)
      assert.equal(await page.getByRole('button', { name: 'Weekly', exact: true }).isVisible(), true)
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      const block = page.locator('.event-block').filter({ hasText: fixture.title })
      await block.click()
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
      assert.equal(await page.getByLabel('Title', { exact: true }).evaluate((el) => document.activeElement === el), false)
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.locator('.timegrid__body').evaluate((el) => { el.scrollTop = 11 * 32 })
      const rect = await block.boundingBox()
      const x = rect.x + rect.width / 2, y = rect.y + 3
      const cdp = await context.newCDPSession(page)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await page.clock.runFor(2990)
      assert.equal(await page.locator('.event-draft').count(), 0)
      await page.clock.runFor(20)
      await page.locator('.event-draft').waitFor()
      assert.equal(await page.locator('.event-details').count(), 0)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 64 }] })
      await page.locator('.event-draft').waitFor()
      assert.ok(await page.locator('.event-draft').evaluate((el) => el.getBoundingClientRect().height) >= 64)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await page.getByRole('heading', { name: 'New event', exact: true }).waitFor()
      assert.equal(await page.locator('.event-details').count(), 0)
      assert.equal(await page.getByLabel('Starts', { exact: true }).inputValue(), '2026-10-21T14:00')
      assert.equal(await page.getByLabel('Ends', { exact: true }).inputValue(), '2026-10-21T16:15')
      assert.equal(await page.getByLabel('Title', { exact: true }).evaluate((el) => document.activeElement === el), false)
      if (viewport.width === 390 && process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/compact-event-editor.png` })
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      if (viewport.width === 390) {
        const nextDay = await page.locator('.timegrid__col').nth(3).boundingBox()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
        await page.clock.runFor(3010)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: nextDay.x + nextDay.width / 2, y: y + 64 }] })
        assert.equal(await page.locator('.event-draft').count(), 2, 'cross-day selection should cover both days')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.getByRole('heading', { name: 'New event', exact: true }).waitFor()
        assert.equal(await page.getByLabel('Ends', { exact: true }).inputValue(), '2026-10-22T16:15')
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        const body = page.locator('.timegrid__body')
        await body.evaluate((el) => { el.scrollTop = 0 })
        const bodyRect = await body.boundingBox()
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: bodyRect.y + bodyRect.height - 20 }] })
        await page.clock.runFor(3010)
        await page.locator('.event-draft').waitFor()
        await page.clock.runFor(350)
        assert.ok(await body.evaluate((el) => el.scrollTop) > 0, 'armed selection should auto-scroll near the lower edge')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        assert.equal(await page.locator('.event-draft').count(), 0)
        assert.equal(await page.getByRole('dialog').count(), 0, 'cancelled selection should not open a modal')
      }

    } finally { await context.close() }
  }
  console.log('PASS: compact editor, one-row colour palette, no keyboard autofocus, important day count and three-second touch drag over existing events')

  assert.deepEqual(errors, [], 'browser JavaScript errors')
} finally {
  await browser.close()
}

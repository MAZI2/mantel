import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const baseURL = process.env.PREVIEW_URL ?? 'http://localhost:8081'
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium-browser', args: ['--no-sandbox'] })
const settings = await (await fetch(`${baseURL}/api/settings`)).json()
const errors = []

async function open({ viewport = { width: 1280, height: 720 }, scale = 'normal', allDay = false,
  weekStartsOn = 1, time = '2026-10-21T12:00:00+02:00', path = '/' } = {}) {
  const context = await browser.newContext({ baseURL, viewport, timezoneId: 'Europe/Ljubljana',
    hasTouch: true, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.clock.install({ time: new Date(time) })
  await context.route('**/api/settings', (route) => route.fulfill({ json: {
    ...settings, first_day_of_week: weekStartsOn, display_scale: scale, time_format_24h: true,
    // An existing installation's daytime preference must no longer hide early/late hours.
    day_start_hour: 9, day_end_hour: 21, screensaver_enabled: false, sleep_enabled: false,
    burn_in_shift: false, bookmark_url: '',
  } }))
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
  await page.waitForFunction(({ scale, weekStartsOn }) => document.documentElement.dataset.scale === scale &&
    document.querySelectorAll('.timegrid__slot').length === 168 &&
    document.querySelector('.timegrid__dayname')?.textContent === (weekStartsOn === 1 ? 'Mon' : 'Sun'),
    { scale, weekStartsOn })
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

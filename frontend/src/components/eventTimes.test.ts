import { describe, expect, it } from 'vitest'
import { allDayEndFor, allDayInput, endFor, toLocalInput, utcMidnight } from './eventTimes'

describe('endFor', () => {
  it('puts the end one hour after a start nobody has overridden', () => {
    expect(endFor('2026-08-14T09:00', '2026-08-14T08:00', '2026-08-14T08:30', false)).toBe(
      '2026-08-14T10:00',
    )
  })

  it('crosses midnight without inventing a date', () => {
    expect(endFor('2026-08-14T23:45', '2026-08-14T08:00', '2026-08-14T08:30', false)).toBe(
      '2026-08-15T00:45',
    )
  })

  it('keeps a length somebody chose, moving the event instead of reshaping it', () => {
    // 08:00-10:00 is two hours. Moving the start to 14:00 should give 14:00-16:00,
    // not 14:00-15:00 -- silently cutting a meeting in half is worse than no help.
    expect(endFor('2026-08-14T14:00', '2026-08-14T08:00', '2026-08-14T10:00', true)).toBe(
      '2026-08-14T16:00',
    )
  })

  it('preserves an explicitly chosen half-hour event when its start moves', () => {
    expect(endFor('2026-08-14T14:00', '2026-08-14T08:00', '2026-08-14T08:30', true)).toBe(
      '2026-08-14T14:30',
    )
  })

  it('does not carry a backwards duration along with the start', () => {
    // The end is before the start here; moving the start must not preserve that.
    expect(endFor('2026-08-14T14:00', '2026-08-14T10:00', '2026-08-14T09:00', true)).toBe(
      '2026-08-14T15:00',
    )
  })

  it('leaves the end alone while a date is half typed', () => {
    expect(endFor('2026-08-', '2026-08-14T08:00', '2026-08-14T08:30', false)).toBe(
      '2026-08-14T08:30',
    )
    expect(endFor('', '2026-08-14T08:00', '2026-08-14T08:30', true)).toBe('2026-08-14T08:30')
  })

  it('leaves the end alone if the existing values are unreadable', () => {
    expect(endFor('2026-08-14T14:00', 'nonsense', '2026-08-14T10:00', true)).toBe(
      '2026-08-14T10:00',
    )
  })
})

describe('toLocalInput', () => {
  it('pads every part, because the input silently rejects a short one', () => {
    expect(toLocalInput(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05T09:07')
  })
})

describe('all-day date editing', () => {
  it('round-trips single and multiple days without extending the exclusive end', () => {
    for (const [start, end] of [
      ['2026-10-21T00:00:00Z', '2026-10-22T00:00:00Z'],
      ['2026-10-24T00:00:00Z', '2026-10-26T00:00:00Z'],
      ['2026-12-31T00:00:00Z', '2027-01-02T00:00:00Z'],
    ]) {
      expect(utcMidnight(allDayInput(start))).toBe(new Date(start).toISOString())
      expect(utcMidnight(allDayInput(end, true), 1)).toBe(new Date(end).toISOString())
    }
  })

  it('shows the final included date instead of the next day', () => {
    expect(allDayInput('2026-10-22T00:00:00Z', true)).toBe('2026-10-21')
    expect(allDayInput('2027-01-01T00:00:00Z', true)).toBe('2026-12-31')
  })

  it('moves an inclusive range across DST in whole calendar days', () => {
    expect(allDayEndFor('2026-10-24', '2026-10-21', '2026-10-23')).toBe('2026-10-26')
    expect(allDayEndFor('2026-03-28', '2026-03-21', '2026-03-23')).toBe('2026-03-30')
    expect(allDayEndFor('2027-01-01', '2026-12-31', '2026-12-31')).toBe('2027-01-01')
  })

  it('leaves an end date alone while the start is incomplete', () => {
    expect(allDayEndFor('', '2026-10-21', '2026-10-23')).toBe('2026-10-23')
  })
})

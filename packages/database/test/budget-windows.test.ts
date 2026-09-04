import { describe, expect, it } from 'vitest'
import { dayWindow, monthWindow } from '../src/budget/windows'

/**
 * 预算窗口边界。
 *
 * 值得逐条钉住的原因：账本没有 `period` 列，日/月上限完全靠这两个函数切出来的 `createdAt`
 * 范围求和。上界写成闭区间，跨零点那一毫秒就会被两个窗口各算一次，日限凭空多出一次调用的额度。
 */

describe('dayWindow', () => {
  it('切出含 now 的那一个 UTC 日', () => {
    const { start, end } = dayWindow(new Date('2026-09-03T12:34:56.789Z'))

    expect(start.toISOString()).toBe('2026-09-03T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-09-04T00:00:00.000Z')
  })

  it('零点整属于当天，上界那一刻属于第二天', () => {
    const midnight = new Date('2026-09-03T00:00:00.000Z')
    const { start, end } = dayWindow(midnight)

    expect(start.getTime()).toBe(midnight.getTime())
    // 半开区间：end 自己不在窗口内。
    expect(dayWindow(end).start.toISOString()).toBe('2026-09-04T00:00:00.000Z')
  })

  it('前一毫秒与后一毫秒落在相邻的两个窗口', () => {
    const before = dayWindow(new Date('2026-09-02T23:59:59.999Z'))
    const after = dayWindow(new Date('2026-09-03T00:00:00.000Z'))

    expect(before.end.getTime()).toBe(after.start.getTime())
  })

  it('跨月最后一天自然进位', () => {
    const { start, end } = dayWindow(new Date('2026-09-30T23:00:00.000Z'))

    expect(start.toISOString()).toBe('2026-09-30T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('跨年最后一天自然进位', () => {
    const { start, end } = dayWindow(new Date('2026-12-31T23:59:59.999Z'))

    expect(start.toISOString()).toBe('2026-12-31T00:00:00.000Z')
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })
})

describe('monthWindow', () => {
  it('切出含 now 的那一个 UTC 月', () => {
    const { start, end } = monthWindow(new Date('2026-09-03T12:34:56.789Z'))

    expect(start.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('12 月靠 Date.UTC 的月份溢出进位到次年 1 月', () => {
    const { start, end } = monthWindow(new Date('2026-12-15T08:00:00.000Z'))

    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('闰年 2 月的上界是 3 月 1 日', () => {
    const { start, end } = monthWindow(new Date('2028-02-29T12:00:00.000Z'))

    expect(start.toISOString()).toBe('2028-02-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2028-03-01T00:00:00.000Z')
  })

  it('相邻两个月的窗口首尾相接且不重叠', () => {
    const september = monthWindow(new Date('2026-09-20T00:00:00.000Z'))
    const october = monthWindow(new Date('2026-10-01T00:00:00.000Z'))

    expect(september.end.getTime()).toBe(october.start.getTime())
  })

  it('日窗口一定被同月的月窗口包住', () => {
    const now = new Date('2026-09-30T23:59:59.999Z')
    const day = dayWindow(now)
    const month = monthWindow(now)

    expect(day.start.getTime()).toBeGreaterThanOrEqual(month.start.getTime())
    expect(day.end.getTime()).toBeLessThanOrEqual(month.end.getTime())
  })
})

import { WEEKDAYS } from './types'

export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s)
  d.setUTCDate(d.getUTCDate() + n)
  return fmt(d)
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000)
}

/** 0=일 ... 6=토 */
export function weekday(s: string): number {
  return parseDate(s).getUTCDay()
}

export function short(s: string): string {
  const d = parseDate(s)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

export function label(s: string): string {
  return `${short(s)}(${WEEKDAYS[weekday(s)]})`
}

export function periodDates(start: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => addDays(start, i))
}

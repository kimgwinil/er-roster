import { periodDates } from './dates'
import type { Scenario, Staff } from './types'

export interface Ledger {
  /** 주별 시작 잔여 */
  start: number[]
  /** 그 주 사용 휴가 (잔여 계산 대상 기간) */
  used: number[]
  /** 그 주 종료 잔여 */
  end: number[]
  /** 잔여 계산 기간 이후 휴가 (예: 다음 달) */
  after: number[]
  /** 직접 입력(전주 대비 적용 포함)한 주인지 */
  manual: boolean[]
  /** 그 주에 생긴 나이트 보상휴가 */
  bonus: number[]
}

/** 나이트 보상휴가 발생일 (day index, 5번째 N 다음 날) */
export function accrualDays(sc: Scenario, s: Staff): number[] {
  const acc = sc.rules.nightAccrual
  if (!acc?.per) return []
  const dates = periodDates(sc.startDate, sc.days)
  const row = sc.roster[s.id] ?? []
  const out: number[] = []
  let n = 0
  dates.forEach((dt, d) => {
    if (dt >= acc.from && dt <= acc.to && row[d] === 'N' && ++n % acc.per === 0) out.push(d + 1)
  })
  return out
}

/** 그날까지 쓴 휴가가 잔여 + 그날까지 생긴 보상휴가를 처음 넘는 날 (없으면 -1) */
export function leaveOverDay(sc: Scenario, s: Staff): { day: number; used: number; allow: number } {
  const dates = periodDates(sc.startDate, sc.days)
  const row = sc.roster[s.id] ?? []
  const acc = accrualDays(sc, s)
  let used = 0
  for (let t = 0; t < sc.days && dates[t] <= sc.leaveCapUntil; t++) {
    if (row[t] === '휴가') used++
    const allow = s.leave + acc.filter((a) => a <= t).length
    if (used > allow) return { day: t, used, allow }
  }
  return { day: -1, used, allow: 0 }
}

export function weekCount(sc: Scenario): number {
  return Math.ceil(sc.days / 7)
}

export function ledger(sc: Scenario, s: Staff): Ledger {
  const dates = periodDates(sc.startDate, sc.days)
  const row = sc.roster[s.id] ?? []
  const W = weekCount(sc)
  const acc = accrualDays(sc, s)
  const out: Ledger = { start: [], used: [], end: [], after: [], manual: [], bonus: [] }
  for (let w = 0; w < W; w++) {
    let used = 0
    let after = 0
    for (let d = w * 7; d < Math.min(sc.days, w * 7 + 7); d++) {
      if (row[d] !== '휴가') continue
      if (dates[d] <= sc.leaveCapUntil) used++
      else after++
    }
    const given = s.weekLeave?.[w]
    const manual = given !== null && given !== undefined
    const start = manual ? (given as number) : w === 0 ? s.leave : out.end[w - 1]
    const bonus = acc.filter((a) => a >= w * 7 && a < w * 7 + 7 && dates[a] && dates[a] <= sc.leaveCapUntil).length
    out.start.push(start)
    out.used.push(used)
    out.bonus.push(bonus)
    out.end.push(start + bonus - used)
    out.after.push(after)
    out.manual.push(manual)
  }
  return out
}

/** 전주 대비 적용: 선택한 주의 시작 잔여를 전주 종료 잔여로 확정 */
export function applyPrevWeek(sc: Scenario, week: number): Scenario {
  const staff = sc.staff.map((s) => {
    const lg = ledger(sc, s)
    const wl = [...(s.weekLeave ?? [])]
    while (wl.length < weekCount(sc)) wl.push(null)
    wl[week] = week === 0 ? s.leave : lg.end[week - 1]
    return { ...s, weekLeave: wl }
  })
  return { ...sc, staff }
}

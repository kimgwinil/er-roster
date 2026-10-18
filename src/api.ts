import { periodDates } from './dates'
import type { Fixed, Scenario } from './types'

export interface Relaxed {
  type: string
  date?: string
  shift?: string
  staff?: string
  cond?: string
  amount: number
}

export interface SolveResult {
  ok: boolean
  status: string
  seconds: number
  message?: string
  roster?: Record<string, string[]>
  relaxed?: Relaxed[]
  /** false 면 금지 조건끼리 충돌해 일부를 완화함 */
  strict?: boolean
}

/**
 * 서버로 보낼 시나리오: 이름·메모·원문 조건을 빼고 번호(id)만 보낸다.
 * 잠근 칸과 fromDate 이전 칸은 지정(고정)으로 바꿔 보낸다.
 */
export function payload(sc: Scenario, fromDate?: string): Scenario {
  const dates = periodDates(sc.startDate, sc.days)
  const fixed: Fixed[] = [...sc.fixed]
  for (const s of sc.staff) {
    const row = sc.roster[s.id] ?? []
    const locks = sc.locks[s.id] ?? []
    dates.forEach((date, d) => {
      const c = row[d]
      if (!c || c === '-') return
      if (locks[d] || (fromDate && date < fromDate)) fixed.push({ staff: s.id, date, allowed: [c], reason: '' })
    })
  }
  return {
    ...sc,
    title: '',
    staff: sc.staff.map((s) => ({ ...s, name: '', memo: '' })),
    fixed: fixed.map((f) => ({ ...f, reason: '' })),
    conditions: (sc.conditions ?? []).filter((c) => c.kind !== 'memo').map((c) => ({ ...c, title: '', text: '' })),
    acks: {},
    notes: [],
    conditionText: undefined,
  }
}

export async function solveRemote(sc: Scenario, opts: { fromDate?: string; timeLimit: number; keepCurrent?: boolean }): Promise<SolveResult> {
  const res = await fetch('/api/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: { ...payload(sc, opts.fromDate), keepCurrent: opts.keepCurrent ? 10 : 0 }, timeLimit: opts.timeLimit }),
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as SolveResult
  } catch {
    return { ok: false, status: String(res.status), seconds: 0, message: `서버 응답 오류 (${res.status}): ${text.slice(0, 200)}` }
  }
}

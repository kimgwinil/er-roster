import { useCallback, useEffect, useRef, useState } from 'react'
import { addDays, periodDates } from './dates'
import { migrate } from './conditions'
import { defaultScenario } from './excel'
import { ledger } from './leave'
import { employed } from './rules'
import type { Scenario } from './types'

const KEY = 'er-roster-scenario-v1'

function load(): Scenario {
  try {
    const t = localStorage.getItem(KEY)
    if (t) return migrate(JSON.parse(t) as Scenario)
  } catch {
    /* 저장소를 쓸 수 없는 환경 */
  }
  return defaultScenario()
}

/** 재직 기간 밖 칸은 '-' 로, 재직 중인데 '-' 인 칸은 비움 */
export function normalize(sc: Scenario): Scenario {
  const dates = periodDates(sc.startDate, sc.days)
  const roster: Scenario['roster'] = {}
  for (const s of sc.staff) {
    const row = [...(sc.roster[s.id] ?? [])]
    while (row.length < sc.days) row.push('')
    roster[s.id] = row.slice(0, sc.days).map((c, d) => (employed(s, dates[d]) ? (c === '-' ? '' : c) : '-'))
  }
  return { ...sc, roster }
}

export function useScenario() {
  const [sc, setSc] = useState<Scenario>(load)
  const cur = useRef(sc)
  const history = useRef<Scenario[]>([])
  const [canUndo, setCanUndo] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sc))
    } catch {
      /* 무시 */
    }
  }, [sc])

  const update = useCallback((fn: (s: Scenario) => Scenario) => {
    history.current.push(cur.current)
    if (history.current.length > 50) history.current.shift()
    cur.current = fn(cur.current)
    setSc(cur.current)
    setCanUndo(true)
  }, [])

  const replace = useCallback((next: Scenario) => update(() => next), [update])

  const undo = useCallback(() => {
    const prev = history.current.pop()
    if (prev) {
      cur.current = prev
      setSc(prev)
    }
    setCanUndo(history.current.length > 0)
  }, [])

  return { sc, update, replace, undo, canUndo }
}

/** 다음 번표: 직전 근무·잔여휴가를 이어받아 새 기간 시작 */
export function nextPeriod(sc: Scenario): Scenario {
  const start = addDays(sc.startDate, sc.days)
  const staff = sc.staff
    .filter((s) => !s.endDate || s.endDate >= start)
    .map((s) => {
      const lg = ledger(sc, s)
      const row = sc.roster[s.id] ?? []
      return {
        ...s,
        prev: row.slice(-6).filter((c) => c && c !== '-'),
        leave: lg.end[lg.end.length - 1] ?? s.leave,
        weekLeave: [],
        leaveWindows: [],
        minLeave: 0,
        ofExempt: s.ofExempt.filter((r) => r.to >= start),
      }
    })
  const end = addDays(start, sc.days - 1)
  const y = Number(start.slice(0, 4))
  const m = Number(start.slice(5, 7))
  const cap = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  return normalize({
    ...sc,
    title: `응급실 간호사 번표 ${start} ~ ${end}`,
    startDate: start,
    leaveCapUntil: cap,
    staff,
    requests: sc.requests.filter((q) => q.date >= start),
    fixed: sc.fixed.filter((f) => f.date >= start),
    roster: {},
    locks: {},
    acks: {},
    notes: [`이전 번표(${sc.startDate}~)의 마지막 근무와 종료 잔여휴가를 이어받았습니다. 잔여휴가는 [휴가 잔여] 화면에서 확인·수정하세요.`],
  })
}

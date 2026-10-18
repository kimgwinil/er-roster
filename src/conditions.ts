import { label, periodDates, short, weekday } from './dates'
import { CODES, type Condition, type Issue, REST, type Roles, type Scenario, WEEKDAYS, WORK } from './types'

const GROUPS: Record<string, readonly string[]> = { 근무: WORK, 휴무: REST, '*': CODES }

/** 'N', 'E|소아', '근무', '휴무', '*', '!N' → 코드 집합 */
export function tokenCodes(tok: string): Set<string> {
  const neg = tok.startsWith('!')
  const t = neg ? tok.slice(1) : tok
  const set = new Set<string>()
  for (const part of t.split('|').map((p) => p.trim()).filter(Boolean)) for (const c of GROUPS[part] ?? [part]) set.add(c)
  return neg ? new Set(CODES.filter((c) => !set.has(c))) : set
}

let seq = 0
export const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`

/** 기본 근무 순서 규칙 (이전 버전의 고정 규칙을 옮긴 것) */
export function defaultConditions(): Condition[] {
  const s = (id: string, level: Condition['level'], pattern: string[], title: string, weight = 2): Condition =>
    ({ id, on: true, level, weight, kind: 'sequence', staff: [], role: null, from: null, to: null, weekdays: [], pattern, title, text: '' })
  return [
    s('base-n', '금지', ['N', 'D|E|소아|미드|교육'], 'N 다음 날은 N 또는 휴무만'),
    s('base-e', '금지', ['E', 'D|미드|소아|교육'], 'E 다음 날 D·미드·소아·교육 금지'),
    s('base-p', '금지', ['소아', 'D|교육'], '소아 다음 날 D·교육 금지'),
    s('base-m', '금지', ['미드', 'D'], '미드 다음 날 D 금지'),
    s('base-nrd', '금지', ['N', '휴무', 'D|미드'], 'N → 휴무 → D 금지'),
    s('base-nnr', '금지', ['N', 'N', '휴무', '근무'], '연속 N 뒤 휴무 하루만 쉬고 근무 금지'),
    s('base-nre', '지향', ['!N', 'N', '휴무', 'E|소아'], 'N → 휴무 → E/소아 지양', 2),
    s('base-n1', '지향', ['!N', 'N', '!N'], '하루짜리 N 지양', 1),
  ]
}

/** 버전 1 시나리오(금지 순서 쌍 목록)를 조건 목록으로 바꿈 */
export function migrate(sc: Scenario): Scenario {
  if ((sc.version ?? 1) >= 2 && sc.conditions) return sc
  const conds = defaultConditions()
  const known = new Set(['N>D', 'N>E', 'N>소아', 'N>미드', 'N>교육', 'E>D', 'E>미드', 'E>소아', 'E>교육', '소아>D', '소아>교육', '미드>D'])
  for (const [a, b] of sc.rules?.forbidden ?? []) {
    if (!known.has(`${a}>${b}`))
      conds.push({ id: newId(), on: true, level: '금지', weight: 2, kind: 'sequence', staff: [], role: null, from: null, to: null, weekdays: [], pattern: [a, b], title: `${a} 다음 날 ${b} 금지`, text: '' })
  }
  return { ...sc, version: 2, conditions: [...conds, ...(sc.conditions ?? [])], rules: { ...sc.rules, forbidden: [] } }
}

const ROLE_NAME: Record<keyof Roles, string> = { charge: '차지', newbie: '신규', pedsCharge: '소아차지', pedsActing: '소아액팅', pedsBackup: '소아차지 대체' }

/** 'E|소아' → 'E/소아', '!N' → 'N 아님', '*' → '아무 근무' */
export function tokenText(t: string): string {
  if (t === '*') return '아무 근무'
  if (t.startsWith('!')) return `${t.slice(1).split('|').join('/')} 아님`
  return t.split('|').join('/')
}

/** 사람이 읽는 조건 문장 */
export function describe(c: Condition, sc: Scenario): string {
  const name = (id: string) => sc.staff.find((s) => s.id === id)?.name ?? id
  const who = c.staff.length ? c.staff.map(name).join('·') : c.role ? `${ROLE_NAME[c.role]} 전체` : '전체'
  const when = [c.from || c.to ? `${c.from ? short(c.from) : '처음'}~${c.to ? short(c.to) : '끝'}` : '', c.weekdays.length ? `${c.weekdays.map((w) => WEEKDAYS[w]).join('')}요일` : ''].filter(Boolean).join(' ')
  const pre = `${who}${when ? ` (${when})` : ''}`
  switch (c.kind) {
    case 'sequence': return `${pre}: ${(c.pattern ?? []).map(tokenText).join(' → ')} 순서가 나오지 않게`
    case 'assign': return `${pre}: ${(c.codes ?? []).join('/')} ${c.mode === 'only' ? '근무만' : '근무 안 됨'}`
    case 'conditional': return `${pre}: ${(c.trigger ?? []).map(tokenText).join('/')} 근무인 날의 ${Math.abs(c.offset ?? 1)}일 ${(c.offset ?? 1) >= 0 ? '뒤' : '전'}에는 ${(c.codes ?? []).map(tokenText).join('/')} ${c.mode === 'only' ? '근무만' : '근무 안 됨'}`
    case 'count': return `${pre}: ${(c.codes ?? []).join('/')} ${c.min != null ? `최소 ${c.min}회 ` : ''}${c.max != null ? `최대 ${c.max}회` : ''}`.trim()
    case 'together': return `${pre} 와(과) ${(c.other ?? []).map(name).join('·')}: ${(c.codes ?? ['D', 'E', 'N', '소아']).join('/')} ${c.mode === 'together' ? '같은 근무에 함께' : '같은 근무에 함께 들어가지 않게'}`
    default: return `${pre}: ${c.text}`
  }
}

/** 조건 검사: 금지 → 위반, 지향 → 권장, 특별조건(메모) → 확인 */
export function checkConditions(sc: Scenario, employedAt: (sid: string, d: number) => boolean): Issue[] {
  const dates = periodDates(sc.startDate, sc.days)
  const out: Issue[] = []
  const name = (id: string) => sc.staff.find((s) => s.id === id)?.name ?? id
  for (const c of sc.conditions ?? []) {
    if (c.on === false) continue
    const lvl = c.level === '금지' ? '위반' : '권장'
    const title = c.title || describe(c, sc)
    const rule = `${c.level} 조건`
    const targets = sc.staff.filter((s) => (!c.staff.length || c.staff.includes(s.id)) && (!c.role || s.roles[c.role]))
    const inScope = (d: number) => {
      const dt = dates[d]
      return (!c.from || dt >= c.from) && (!c.to || dt <= c.to) && (!c.weekdays.length || c.weekdays.includes(weekday(dt)))
    }
    if (c.kind === 'memo') {
      if (c.text.trim())
        out.push({ id: `memo|${c.id}`, level: '확인', rule: '특별조건', msg: `${describe(c, sc)}${c.title ? ` — ${c.title}` : ''}`, cells: c.staff.length && c.from ? c.staff.map((sid) => [sid, Math.max(0, dates.indexOf(c.from!))] as [string, number]) : [] })
      continue
    }
    if (c.kind === 'sequence') {
      const pat = (c.pattern ?? []).map(tokenCodes)
      if (!pat.length) continue
      for (const s of targets) {
        const row = sc.roster[s.id] ?? []
        const L = s.prev.length
        const seq = [...s.prev, ...row.slice(0, sc.days)]
        for (let e = 0; e < sc.days; e++) {
          const st = L + e - pat.length + 1
          if (st < 0 || !inScope(e) || !employedAt(s.id, e)) continue
          if (pat.every((cs, k) => cs.has(seq[st + k] ?? ''))) {
            const cells = pat.map((_, k) => st + k - L).filter((d) => d >= 0).map((d) => [s.id, d] as [string, number])
            out.push({ id: `cond|${c.id}|${s.id}|${e}`, level: lvl, rule, msg: `${s.name} ${label(dates[e])} ${seq.slice(st, st + pat.length).join('→')} — ${title}`, cells })
          }
        }
      }
    } else if (c.kind === 'assign') {
      const codes = tokenCodes((c.codes ?? []).join('|'))
      for (const s of targets) {
        const row = sc.roster[s.id] ?? []
        for (let d = 0; d < sc.days; d++) {
          if (!inScope(d) || !employedAt(s.id, d) || !row[d]) continue
          const hit = codes.has(row[d])
          if (c.mode === 'only' ? !hit : hit)
            out.push({ id: `cond|${c.id}|${s.id}|${d}`, level: lvl, rule, msg: `${s.name} ${label(dates[d])} ${row[d]} — ${title}`, cells: [[s.id, d]] })
        }
      }
    } else if (c.kind === 'conditional') {
      const trig = tokenCodes((c.trigger ?? []).join('|'))
      const codes = tokenCodes((c.codes ?? []).join('|'))
      const off = c.offset ?? 1
      for (const s of targets) {
        const row = sc.roster[s.id] ?? []
        const L = s.prev.length
        const seq = [...s.prev, ...row.slice(0, sc.days)]
        for (let t = 0; t < sc.days; t++) {
          const k = L + t - off
          if (k < 0 || k >= seq.length || !inScope(t) || !employedAt(s.id, t) || !row[t]) continue
          if (!trig.has(seq[k] ?? '')) continue
          const hit = codes.has(row[t])
          if (c.mode === 'only' ? !hit : hit) {
            const cells: [string, number][] = [[s.id, t]]
            if (k - L >= 0) cells.push([s.id, k - L])
            out.push({ id: `cond|${c.id}|${s.id}|${t}`, level: lvl, rule, msg: `${s.name} ${label(dates[t])} ${row[t]} (${off >= 0 ? `${off}일 전` : `${-off}일 뒤`} ${seq[k]}) — ${title}`, cells })
          }
        }
      }
    } else if (c.kind === 'count') {
      const codes = tokenCodes((c.codes ?? []).join('|'))
      for (const s of targets) {
        const row = sc.roster[s.id] ?? []
        const days = [...Array(sc.days).keys()].filter((d) => inScope(d) && employedAt(s.id, d))
        const n = days.filter((d) => codes.has(row[d])).length
        const lo = c.min ?? null
        const hi = c.max ?? null
        if ((lo !== null && n < lo) || (hi !== null && n > hi))
          out.push({ id: `cond|${c.id}|${s.id}`, level: lvl, rule, msg: `${s.name} ${(c.codes ?? []).join('/')} ${n}회 — ${title}`, cells: days.filter((d) => codes.has(row[d])).map((d) => [s.id, d]) })
      }
    } else if (c.kind === 'together') {
      const shifts = (c.codes?.length ? c.codes : ['D', 'E', 'N', '소아'])
      for (let d = 0; d < sc.days; d++) {
        if (!inScope(d)) continue
        for (const a of targets) for (const bid of c.other ?? []) {
          if (a.id === bid) continue
          const ca = sc.roster[a.id]?.[d]
          const cb = sc.roster[bid]?.[d]
          const same = !!ca && ca === cb && shifts.includes(ca)
          const bad = c.mode === 'together' ? (shifts.includes(ca ?? '') || shifts.includes(cb ?? '')) && ca !== cb : same
          if (bad)
            out.push({ id: `cond|${c.id}|${a.id}|${bid}|${d}`, level: lvl, rule, msg: `${a.name}(${ca})·${name(bid)}(${cb}) ${label(dates[d])} — ${title}`, cells: [[a.id, d], [bid, d]] })
        }
      }
    }
  }
  return out
}

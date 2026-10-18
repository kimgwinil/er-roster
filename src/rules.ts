import { label, periodDates, short, weekday } from './dates'
import { checkConditions } from './conditions'
import { leaveOverDay, ledger } from './leave'
import { DESIGNATED, type Issue, LEAVE_LIKE, type LeaveRequest, type Level, type Scenario, type Staff, REST, SHIFTS, WEEKDAYS, WORK } from './types'

const isWork = (c: string | undefined) => !!c && (WORK as readonly string[]).includes(c)
const isRest = (c: string | undefined) => !!c && (REST as readonly string[]).includes(c)

export function employed(s: Staff, date: string): boolean {
  return (!s.startDate || date >= s.startDate) && (!s.endDate || date <= s.endDate)
}

/** 날짜별 지정(허용 근무) — 같은 날 여러 지정은 교집합 */
export function fixedMap(sc: Scenario): Map<string, { allowed: Set<string>; reason: string }> {
  const m = new Map<string, { allowed: Set<string>; reason: string }>()
  for (const f of sc.fixed) {
    const k = `${f.staff}|${f.date}`
    const cur = m.get(k)
    const allowed = new Set(f.allowed)
    m.set(k, cur
      ? { allowed: new Set([...cur.allowed].filter((c) => allowed.has(c))), reason: `${cur.reason}, ${f.reason}` }
      : { allowed, reason: f.reason })
  }
  return m
}

const OFF_FOR_REQUEST = new Set(['주휴', 'OF', '휴가', '생휴', '경조', '수휴', '병가'])

/** 신청오프 칸 상태: 'ok' 반영(노랑) · 'miss' 반영 못 함(빨강) · null 아직 비어 있음 */
export function requestState(q: LeaveRequest, c: string | undefined): 'ok' | 'miss' | null {
  if (!c || c === '-') return null
  if (q.alt && c === q.alt) return 'ok'
  // 주휴·OF·휴가 외에 생리휴가·경조·수휴 등 쉬는 날이면 반영된 것으로 봄 (공가·교육은 제외)
  return (q.onlyLeave ? c === '휴가' : OFF_FOR_REQUEST.has(c)) ? 'ok' : 'miss'
}

export function validate(sc: Scenario): Issue[] {
  const dates = periodDates(sc.startDate, sc.days)
  const ND = sc.days
  const issues: Issue[] = []
  const seen = new Set<string>()
  const fx = fixedMap(sc)
  const at = (sid: string, d: number) => sc.roster[sid]?.[d] ?? ''

  function add(level: Level, rule: string, key: string, msg: string, cells: [string, number][] = [], days?: number[]) {
    const id = `${rule}|${key}`
    if (seen.has(id)) return
    seen.add(id)
    issues.push({ id, level, rule, msg, cells, days, staff: cells[0]?.[0] })
  }

  const v2 = (sc.version ?? 1) >= 2
  const filled = sc.staff.some((s) => (sc.roster[s.id] ?? []).some(Boolean))
  if (!filled) {
    add('확인', '미배정', 'all', '아직 번표가 없습니다. [자동 생성]을 누르거나 칸을 직접 입력하세요.')
    return issues
  }

  // ---------------------------------------------------------- 날짜별 인원·구성
  const byId = new Map(sc.staff.map((s) => [s.id, s]))
  for (let d = 0; d < ND; d++) {
    const on: Record<string, Staff[]> = {}
    for (const s of sc.staff) {
      const c = at(s.id, d)
      ;(on[c] ??= []).push(s)
    }
    for (const sh of SHIFTS) {
      const n = on[sh]?.length ?? 0
      const need = sc.demand[sh]
      if (n < need) add('위반', '인원 부족', `${d}|${sh}`, `${label(dates[d])} ${sh} ${n}명 (필요 ${need}명)`, [], [d])
      if (n > need) add('위반', '인원 초과', `${d}|${sh}`, `${label(dates[d])} ${sh} ${n}명 (필요 ${need}명)`, [], [d])
    }
    const peds = on['소아'] ?? []
    for (const s of peds) {
      if (!(s.roles.pedsCharge || s.roles.pedsActing || s.roles.pedsBackup) || s.roles.newbie)
        add('위반', '소아 자격', `${s.id}|${d}`, `${s.name} ${label(dates[d])} 소아 근무 자격 없음`, [[s.id, d]])
      else if (s.roles.pedsBackup && !s.roles.pedsCharge)
        add('확인', '소아차지 대체', `${s.id}|${d}`, `${s.name} ${label(dates[d])} 소아차지 대체 근무 (신청오프 반려 대신)`, [[s.id, d]])
    }
    if (sc.demand['소아'] >= 2 && peds.length) {
      const pc = peds.filter((s) => s.roles.pedsCharge || s.roles.pedsBackup).length
      const pa = peds.filter((s) => s.roles.pedsActing).length
      if (pc < 1 || pa < 1)
        add('위반', '소아 구성', `${d}`, `${label(dates[d])} 소아는 소아차지 1 + 소아액팅 1 (현재 차지 ${pc}·액팅 ${pa})`,
          peds.map((s) => [s.id, d]), [d])
    }
    for (const sh of ['D', 'E', 'N']) {
      const list = on[sh] ?? []
      const ch = list.filter((s) => s.roles.charge).length
      const nw = list.filter((s) => s.roles.newbie).length
      if (ch < sc.rules.chargeMin) add('위반', '차지 부족', `${d}|${sh}`, `${label(dates[d])} ${sh} 차지 ${ch}명 (${sc.rules.chargeMin}~${sc.rules.chargeMax}명)`, [], [d])
      if (ch > sc.rules.chargeMax) add('위반', '차지 초과', `${d}|${sh}`, `${label(dates[d])} ${sh} 차지 ${ch}명 (${sc.rules.chargeMin}~${sc.rules.chargeMax}명)`, list.filter((s) => s.roles.charge).map((s) => [s.id, d]), [d])
      if (nw > sc.rules.newMax) add('위반', '신규 초과', `${d}|${sh}`, `${label(dates[d])} ${sh} 신규 ${nw}명 (${sc.rules.newMax}명 이하)`, list.filter((s) => s.roles.newbie).map((s) => [s.id, d]), [d])
    }
  }

  // ---------------------------------------------------------- 개인별
  for (const s of sc.staff) {
    const row = sc.roster[s.id] ?? []
    const nm = s.name
    for (let d = 0; d < ND; d++) {
      const c = row[d] ?? ''
      const date = dates[d]
      const emp = employed(s, date)
      const f = fx.get(`${s.id}|${date}`)
      const cell: [string, number][] = [[s.id, d]]
      if (!c) { if (emp) add('위반', '미배정', `${s.id}|${d}`, `${nm} ${label(date)} 비어 있음`, cell); continue }
      if (!emp && c !== '-') add('위반', '재직 기간 외', `${s.id}|${d}`, `${nm} ${label(date)} 재직 기간이 아닌데 ${c}`, cell)
      if (emp && c === '-') add('위반', '재직 중 빈칸', `${s.id}|${d}`, `${nm} ${label(date)} 재직 중인데 '-'`, cell)
      if (!emp) continue
      if (s.allowed && isWork(c) && c !== '미드' && !s.allowed.includes(c))
        add('위반', '가능 근무', `${s.id}|${d}`, `${nm} ${label(date)} ${c} (가능 근무: ${s.allowed.join('·')})`, cell)
      // 휴무 지정일에 생휴·경조·수휴 같은 특별 휴무를 쓴 경우도 지정을 지킨 것으로 봄
      const specialRest = (LEAVE_LIKE as readonly string[]).includes(c) && (f?.allowed.has('휴가') || f?.allowed.has('OF'))
      if (f && !f.allowed.has(c) && !specialRest)
        add('위반', '지정 불일치', `${s.id}|${d}`, `${nm} ${label(date)} ${c} — 지정: ${[...f.allowed].join('/')} (${f.reason})`, cell)
      if (c === '미드' && !f?.allowed.has('미드')) add('확인', '지정 외 미드', `${s.id}|${d}`, `${nm} ${label(date)} 지정 없이 미드`, cell)
      if ((DESIGNATED as readonly string[]).includes(c) && !f?.allowed.has(c)) add('확인', `지정 외 ${c}`, `${s.id}|${d}`, `${nm} ${label(date)} 지정 없이 ${c}`, cell)
      const wd = weekday(date)
      if (wd === s.juhu && c !== '주휴' && (!f || f.allowed.has('주휴')))
        add('위반', '주휴 요일', `${s.id}|${d}`, `${nm} ${label(date)} 주휴 요일(${WEEKDAYS[s.juhu]})인데 ${c}`, cell)
      if (wd !== s.juhu && c === '주휴') add('위반', '주휴 요일', `${s.id}|${d}`, `${nm} ${label(date)} 주휴 요일이 아님 (${WEEKDAYS[s.juhu]})`, cell)
      for (const fw of s.fixedWeekdays) {
        if (fw.weekday === wd && c !== fw.code)
          add('위반', '고정 요일', `${s.id}|${d}`, `${nm} ${label(date)} ${WEEKDAYS[wd]}요일은 ${fw.code} 고정인데 ${c}`, cell)
      }
      if (c === '소아' && s.roles.newbie) add('위반', '소아 자격', `${s.id}|${d}`, `${nm} 신규는 소아 근무 불가`, cell)
      if (s.noNightBeforeOff && c === 'N' && (row[d + 1] === '주휴' || row[d + 1] === 'OF'))
        add('위반', '휴무 전날 N', `${s.id}|${d}`, `${nm} ${label(date)} 주휴·OF 전날 N 불가`, cell)
      if (s.noNightLastDays && d >= ND - s.noNightLastDays && c === 'N')
        add('확인', '마지막 날 N', `${s.id}|${d}`, `${nm} ${label(date)} 마지막 ${s.noNightLastDays}일 N 제외 설정`, cell)
    }

    // 주별 주휴·OF
    for (let w = 0; w < ND; w += 7) {
      const days = [...Array(Math.min(7, ND - w)).keys()].map((k) => w + k)
      const whole = days.length === 7 && days.every((d) => employed(s, dates[d]))
      const exempt = days.some((d) => s.ofExempt.some((r) => dates[d] >= r.from && dates[d] <= r.to))
      const nj = days.filter((d) => row[d] === '주휴').length
      const no = days.filter((d) => row[d] === 'OF').length
      const extra = sc.fixed.filter((f) => f.extraOff && f.staff === s.id && days.some((d) => dates[d] === f.date)).length
      const wk = `${Math.floor(w / 7) + 1}주차`
      if (whole && !exempt && (nj !== 1 || no < 1 || no > 1 + extra))
        add('위반', '주휴·OF', `${s.id}|${w}`, `${nm} ${wk} 주휴 ${nj}·OF ${no} (각 1개)`, days.filter((d) => row[d] === '주휴' || row[d] === 'OF').map((d) => [s.id, d]))
      else if (nj > 1 || no > 1 + extra)
        add('위반', '주휴·OF', `${s.id}|${w}`, `${nm} ${wk} 주휴 ${nj}·OF ${no} (각 1개 이하)`, [])
      const jd = days.find((d) => row[d] === '주휴')
      const od = days.filter((d) => row[d] === 'OF')
      if (whole && !exempt && jd !== undefined && od.length && od.every((d) => Math.abs(d - jd) !== 1))
        add('권장', '주휴·OF 연속', `${s.id}|${w}`, `${nm} ${wk} 주휴와 OF가 떨어져 있음`, [[s.id, jd], ...od.map((d) => [s.id, d] as [string, number])])
    }

    // 근무 패턴 (직전 근무 포함)
    const prev = s.prev ?? []
    const L = prev.length
    const seq = [...prev, ...row.slice(0, ND)]
    const cellOf = (k: number): [string, number][] => (k >= L ? [[s.id, k - L]] : [])
    const dl = (k: number) => (k >= L ? label(dates[k - L]) : `직전 ${k - L}일`)
    let runW = 0
    let runN = 0
    for (let k = 0; k < seq.length; k++) {
      const c = seq[k]
      runW = isWork(c) ? runW + 1 : 0
      runN = c === 'N' ? runN + 1 : 0
      if (k < L) continue
      if (runW > sc.rules.maxWork) add('위반', '연속 근무', `${s.id}|${k}`, `${nm} ${dl(k)} 연속 근무 ${runW}일째 (최대 ${sc.rules.maxWork}일)`, cellOf(k))
      if (runN > sc.rules.maxNight) add('위반', '연속 N', `${s.id}|${k}`, `${nm} ${dl(k)} N ${runN}연속 (최대 ${sc.rules.maxNight})`, cellOf(k))
      const a = seq[k - 1]
      for (const [x, y] of v2 ? [] : sc.rules.forbidden) {
        if (a === x && c === y) add('위반', '금지 순서', `${s.id}|${k}`, `${nm} ${dl(k)} ${x}→${y}`, [...cellOf(k - 1), ...cellOf(k)])
      }
      if (!v2 && seq[k - 2] === 'N' && isRest(a) && (c === 'D' || c === '미드'))
        add('위반', '금지 순서', `${s.id}|${k}|nrd`, `${nm} ${dl(k)} N→휴무→${c}`, [...cellOf(k - 2), ...cellOf(k)])
      if (!v2 && seq[k - 2] === 'N' && seq[k - 3] !== 'N' && isRest(a) && (c === 'E' || c === '소아'))
        add('권장', 'N→휴무→E/소아', `${s.id}|${k}`, `${nm} ${dl(k)} N→${a}→${c} (지양)`, [...cellOf(k - 2), ...cellOf(k)])
      // 연속 N(2개 이상) 뒤 휴무가 nightBlockRest 일 미만이고 바로 근무
      if (!v2 && isWork(c) && isRest(a)) {
        let j = k - 1
        let rests = 0
        while (j >= 0 && isRest(seq[j])) { rests++; j-- }
        let nb = 0
        while (j >= 0 && seq[j] === 'N') { nb++; j-- }
        if (nb >= 2 && rests < sc.rules.nightBlockRest)
          add('위반', '연속 N 후 휴식', `${s.id}|${k}`, `${nm} ${dl(k)} N ${nb}연속 뒤 휴무 ${rests}일만에 ${c}`, cellOf(k))
      }
    }

    // 신청오프
    for (const q of sc.requests.filter((r) => r.staff === s.id)) {
      const d = dates.indexOf(q.date)
      if (d < 0) continue
      if (!employed(s, q.date)) {
        add('확인', '재직 기간 외 신청', `${s.id}|${d}`, `${nm} ${label(q.date)} 신청오프가 재직 기간 밖이라 반영하지 않음`)
        continue
      }
      const c = row[d]
      const cell: [string, number][] = [[s.id, d]]
      if (q.alt && c === q.alt) add('확인', '신청오프 근무 전환', `${s.id}|${d}`, `${nm} ${label(q.date)} 신청오프 대신 ${c} (허용된 변경)`, cell)
      else if (q.onlyLeave && c !== '휴가') add('위반', '신청오프', `${s.id}|${d}`, `${nm} ${label(q.date)} 신청오프는 휴가로만 (현재 ${c})`, cell)
      else if (!OFF_FOR_REQUEST.has(c)) add('위반', '신청오프', `${s.id}|${d}`, `${nm} ${label(q.date)} 신청오프인데 ${c}`, cell)
      if (isRest(c)) {
        const before = d >= 1 ? row[d - 1] : prev[L - 1]
        if (before === 'N')
          add(d >= 1 ? '위반' : '확인', '신청오프 전날 N', `${s.id}|${d}`,
            `${nm} ${label(q.date)} 신청오프 전날 N${d >= 1 ? '' : ' (지난 번표 근무 — 변경 불가)'}`, d >= 1 ? [[s.id, d - 1]] : cell)
      }
    }
    for (let d = 0; d < ND; d++) {
      const f = fx.get(`${s.id}|${dates[d]}`)
      if ((row[d] === '공가' || row[d] === '교육') && f?.allowed.has(row[d]) && f.allowed.size === 1) {
        const before = d >= 1 ? row[d - 1] : prev[L - 1]
        if (before === 'N') add(d >= 1 ? '위반' : '확인', '공가·교육 전날 N', `${s.id}|${d}`, `${nm} ${label(dates[d])} ${row[d]} 전날 N`, [[s.id, Math.max(0, d - 1)]])
      }
    }

    // 소아 횟수 상한
    const peds = row.filter((c) => c === '소아').length
    if (s.maxPeds !== null && s.maxPeds !== undefined && peds > s.maxPeds)
      add('위반', '소아 횟수', `${s.id}`, `${nm} 소아 ${peds}회 (최대 ${s.maxPeds}회)`, row.map((c, d) => [c, d] as const).filter(([c]) => c === '소아').map(([, d]) => [s.id, d]))

    // 휴가
    const lg = ledger(sc, s)
    const over = leaveOverDay(sc, s)
    const neg = lg.end.findIndex((e) => e < 0)
    if (over.day >= 0 || neg >= 0)
      add('위반', '휴가 잔여 초과', `${s.id}`, over.day >= 0
        ? `${nm} ${label(dates[over.day])}까지 휴가 ${over.used}개 > 잔여 ${s.leave} + 보상 ${over.allow - s.leave}`
        : `${nm} 휴가 ${lg.used.reduce((a, b) => a + b, 0)}개 사용 — ${neg + 1}주차에 잔여 ${lg.end[neg]}개`,
        // 잔여를 넘긴 날부터의 휴가 칸만 표시 (그 전 휴가는 잔여 안)
        row.map((c, d) => [c, d] as const)
          .filter(([c, d]) => c === '휴가' && dates[d] <= sc.leaveCapUntil && d >= (over.day >= 0 ? over.day : 0))
          .map(([, d]) => [s.id, d]))
    // 최소 휴가: 휴가·생리휴가·경조·수휴 등 추가로 쉬는 날을 셈
    const usedCap = row.filter((c, d) => (LEAVE_LIKE as readonly string[]).includes(c) && dates[d] <= sc.leaveCapUntil).length
    if (s.minLeave && usedCap < s.minLeave)
      add('위반', '추가 휴가', `${s.id}`, `${nm} ${short(sc.leaveCapUntil)}까지 휴가 ${usedCap}개 (최소 ${s.minLeave}개 필요)`)
    for (const lw of s.leaveWindows) {
      const n = dates.filter((dt, d) => dt >= lw.from && dt <= lw.to && (LEAVE_LIKE as readonly string[]).includes(row[d])).length
      if (n < lw.min) add('위반', '기간 내 휴가', `${s.id}|${lw.from}`, `${nm} ${short(lw.from)}~${short(lw.to)} 휴가 ${n}개 (최소 ${lw.min}개)`)
    }

    // 다음 번표로 이어지는 사항
    let tailN = 0
    for (let k = row.length - 1; k >= 0 && row[k] === 'N'; k--) tailN++
    let tailW = 0
    for (let k = row.length - 1; k >= 0 && isWork(row[k]); k--) tailW++
    if (tailN >= 2) add('확인', '다음 번표 이월', `${s.id}|n`, `${nm} N ${tailN}연속으로 끝남 → 다음 번표 첫 ${sc.rules.nightBlockRest}일 휴무 필요`, [[s.id, ND - 1]])
    else if (tailN === 1) add('확인', '다음 번표 이월', `${s.id}|n1`, `${nm} N으로 끝남 → 다음 번표 첫날 N 또는 휴무, 그다음 D 불가`, [[s.id, ND - 1]])
    if (tailW >= sc.rules.maxWork) add('확인', '다음 번표 이월', `${s.id}|w`, `${nm} 연속 근무 ${tailW}일로 끝남 → 다음 번표 첫날 휴무 필요`, [[s.id, ND - 1]])
  }

  // 지정·신청이 가리키는 직원이 없는 경우
  for (const f of sc.fixed) if (!byId.has(f.staff)) add('확인', '지정 대상 없음', `${f.staff}|${f.date}`, `지정 대상 직원(${f.staff})이 명단에 없음: ${f.date} ${f.reason}`)
  for (const q of sc.requests) if (!byId.has(q.staff)) add('확인', '신청 대상 없음', `${q.staff}|${q.date}`, `신청오프 대상 직원(${q.staff})이 명단에 없음: ${q.date}`)

  // 급작 변동: 조퇴는 칸 근무는 두고 대체 여부 확인
  for (const ev of sc.events ?? []) {
    if (ev.kind !== '조퇴') continue
    const d = dates.indexOf(ev.from)
    const s = byId.get(ev.staff)
    if (d >= 0 && s) add('확인', '조퇴', `${ev.id}`, `${s.name} ${label(ev.from)} 조퇴 (${sc.roster[s.id]?.[d] ?? ''})${ev.reason ? ` — ${ev.reason}` : ''} → 남은 시간 대체 인력 확인`, [[s.id, d]])
  }

  const byIdEmp = (sid: string, d: number) => { const s = byId.get(sid); return !!s && employed(s, dates[d]) }
  for (const i of checkConditions(sc, byIdEmp)) if (!seen.has(i.id)) { seen.add(i.id); issues.push(i) }

  const order: Record<Level, number> = { 위반: 0, 확인: 1, 권장: 2 }
  issues.sort((a, b) => order[a.level] - order[b.level])
  return issues
}

/** 하단 집계 */
export function dailyCounts(sc: Scenario) {
  return Array.from({ length: sc.days }, (_, d) => {
    const r: Record<string, number> = { D: 0, E: 0, N: 0, 소아: 0, Dc: 0, Ec: 0, Nc: 0, Dn: 0, En: 0, Nn: 0, pc: 0, pa: 0 }
    for (const s of sc.staff) {
      const c = sc.roster[s.id]?.[d]
      if (!c) continue
      if (c in r) r[c]++
      if (c === 'D' || c === 'E' || c === 'N') {
        if (s.roles.charge) r[`${c}c`]++
        if (s.roles.newbie) r[`${c}n`]++
      }
      if (c === '소아') {
        if (s.roles.pedsCharge || s.roles.pedsBackup) r.pc++
        if (s.roles.pedsActing) r.pa++
      }
    }
    return r
  })
}

import { useMemo, useState } from 'react'
import { label, periodDates, short, weekday } from '../dates'
import { ledger } from '../leave'
import { dailyCounts, employed, fixedMap, requestState } from '../rules'
import { CODES, codeName, type Issue, type Scenario, WEEKDAYS } from '../types'

interface Props {
  sc: Scenario
  issues: Issue[]
  focus: string | null
  baseDate: string | null
  onBaseDate: (d: string | null) => void
  onSet: (staff: string, day: number, code: string | null) => void
  /** 최근 다시 생성·변동으로 바뀐 칸 */
  changed?: Set<string>
}

const LEVEL_CLASS: Record<string, string> = { 위반: 'f-viol', 확인: 'f-check', 권장: 'f-adv' }

export function RosterGrid({ sc, issues, focus, baseDate, onBaseDate, onSet, changed }: Props) {
  const early = useMemo(() => new Set((sc.events ?? []).filter((e) => e.kind === '조퇴').map((e) => `${e.staff}|${e.from}`)), [sc.events])
  const dates = useMemo(() => periodDates(sc.startDate, sc.days), [sc.startDate, sc.days])
  const [edit, setEdit] = useState<{ staff: string; day: number } | null>(null)
  const fx = useMemo(() => fixedMap(sc), [sc])
  const reqs = useMemo(() => new Map(sc.requests.map((q) => [`${q.staff}|${q.date}`, q])), [sc.requests])
  const counts = useMemo(() => dailyCounts(sc), [sc])
  const cellIssues = useMemo(() => {
    const m = new Map<string, Issue[]>()
    for (const i of issues) {
      if (sc.acks[i.id] !== undefined) continue
      for (const [sid, d] of i.cells) {
        const k = `${sid}|${d}`
        m.set(k, [...(m.get(k) ?? []), i])
      }
    }
    return m
  }, [issues, sc.acks])
  const dayIssues = useMemo(() => {
    const m = new Map<number, Issue[]>()
    for (const i of issues) for (const d of i.days ?? []) m.set(d, [...(m.get(d) ?? []), i])
    return m
  }, [issues])
  const prevLen = Math.min(5, Math.max(0, ...sc.staff.map((s) => s.prev.length)))

  const editing = edit && sc.staff.find((s) => s.id === edit.staff)
  const editKey = edit ? `${edit.staff}|${dates[edit.day]}` : ''

  const footer: [string, (r: Record<string, number>) => number, (n: number) => boolean][] = [
    ['D', (r) => r.D, (n) => n === sc.demand.D],
    ['E', (r) => r.E, (n) => n === sc.demand.E],
    ['N', (r) => r.N, (n) => n === sc.demand.N],
    ['소중', (r) => r['소아'], (n) => n === sc.demand['소아']],
    ['D 차지', (r) => r.Dc, (n) => n >= sc.rules.chargeMin && n <= sc.rules.chargeMax],
    ['E 차지', (r) => r.Ec, (n) => n >= sc.rules.chargeMin && n <= sc.rules.chargeMax],
    ['N 차지', (r) => r.Nc, (n) => n >= sc.rules.chargeMin && n <= sc.rules.chargeMax],
    ['D 신규', (r) => r.Dn, (n) => n <= sc.rules.newMax],
    ['E 신규', (r) => r.En, (n) => n <= sc.rules.newMax],
    ['N 신규', (r) => r.Nn, (n) => n <= sc.rules.newMax],
    ['소아차지', (r) => r.pc, (n) => sc.demand['소아'] < 2 || n >= 1],
    ['소아액팅', (r) => r.pa, (n) => sc.demand['소아'] < 2 || n >= 1],
  ]

  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="sticky c-no">번호</th>
            <th className="sticky c-name">이름</th>
            <th className="c-role">구분</th>
            <th>주휴</th>
            {prevLen > 0 && <th colSpan={prevLen} className="prev-h">직전</th>}
            {dates.map((dt, d) => (
              <th
                key={dt}
                className={`day-h ${weekday(dt) % 6 === 0 ? 'we' : ''} ${baseDate === dt ? 'base' : ''} ${d % 7 === 0 ? 'wk' : ''}`}
                title="클릭: 이 날짜부터 다시 생성할 기준일로 선택"
                onClick={() => onBaseDate(baseDate === dt ? null : dt)}
              >
                {short(dt)}
                <br />
                {WEEKDAYS[weekday(dt)]}
              </th>
            ))}
            <th>D</th><th>E</th><th>N</th><th>소중</th><th>휴</th><th title="잔여 계산 기간 종료 시 잔여">잔여</th>
          </tr>
        </thead>
        <tbody>
          {sc.staff.map((s) => {
            const row = sc.roster[s.id] ?? []
            const locks = sc.locks[s.id] ?? []
            const cnt = (c: string) => row.filter((x) => x === c).length
            const lg = ledger(sc, s)
            const prev = s.prev.slice(-prevLen)
            return (
              <tr key={s.id} className={s.endDate && s.endDate < dates[dates.length - 1] ? 'leaving' : ''}>
                <td className="sticky c-no">{s.no}</td>
                <td className="sticky c-name" title={s.memo}>{s.name}{s.memo && <span className="memo-dot">•</span>}</td>
                <td className="c-role">{[s.roles.charge && '차지', s.roles.newbie && '신규', s.roles.pedsCharge && '소아차지', s.roles.pedsActing && '소아액팅'].filter(Boolean).join('/')}</td>
                <td>{WEEKDAYS[s.juhu]}</td>
                {prevLen > 0 && Array.from({ length: prevLen }, (_, k) => (
                  <td key={k} className="prev">{codeName(prev[k - (prevLen - prev.length)] ?? '')}</td>
                ))}
                {dates.map((dt, d) => {
                  const c = row[d] ?? ''
                  const k = `${s.id}|${d}`
                  const iss = cellIssues.get(k) ?? []
                  const lvl = iss.find((i) => i.level === '위반') ? '위반' : iss.find((i) => i.level === '확인') ? '확인' : iss.length ? '권장' : ''
                  const req = reqs.get(`${s.id}|${dt}`)
                  const rs = req ? requestState(req, c) : null
                  const miss = rs === 'miss'
                  const f = fx.get(`${s.id}|${dt}`)
                  const tip = [
                    `${s.name} ${label(dt)}`,
                    req && `신청오프${req.rank != null ? `(${req.rank})` : ''}${req.alt ? ` (${req.alt} 가능)` : ''}${req.onlyLeave ? ' (휴가로만)' : ''}${req.priority === 'low' ? ' · 후순위' : req.priority === 'first' ? ' · 1순위 반려' : ''}${miss ? ' — 반영 못 함!' : ''}`,
                    f && `지정: ${[...f.allowed].join('/')} — ${f.reason}`,
                    locks[d] && '직접 수정(고정)',
                    ...iss.map((i) => `[${i.level}] ${i.msg}`),
                  ].filter(Boolean).join('\n')
                  return (
                    <td
                      key={dt}
                      className={`cell code-${c || 'empty'} ${miss ? 'req-miss' : rs === 'ok' ? 'req-ok' : ''} ${lvl ? LEVEL_CLASS[lvl] : ''} ${focus === k ? 'focus' : ''} ${d % 7 === 0 ? 'wk' : ''} ${employed(s, dt) ? '' : 'off-emp'}`}
                      title={tip}
                      id={`cell-${k}`}
                      onClick={() => setEdit({ staff: s.id, day: d })}
                    >
                      {codeName(c)}
                      {locks[d] && <span className="lock" />}
                      {req && <span className="req" />}
                      {f && <span className="fix" />}
                      {changed?.has(k) && <span className="chg" />}
                      {early.has(`${s.id}|${dt}`) && <span className="early">조</span>}
                    </td>
                  )
                })}
                <td className="sum">{cnt('D')}</td>
                <td className="sum">{cnt('E')}</td>
                <td className="sum">{cnt('N')}</td>
                <td className="sum">{cnt('소아')}</td>
                <td className="sum">{lg.used.reduce((a, b) => a + b, 0) + lg.after.reduce((a, b) => a + b, 0)}</td>
                <td className={`sum ${lg.end[lg.end.length - 1] < 0 ? 'neg' : ''}`}>{lg.end[lg.end.length - 1]}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          {footer.map(([t, get, ok]) => (
            <tr key={t}>
              <td className="sticky c-no" />
              <td className="sticky c-name foot-h">{t}</td>
              <td colSpan={2 + prevLen} />
              {counts.map((r, d) => {
                const n = get(r)
                return <td key={d} className={`foot ${ok(n) ? '' : 'bad'} ${d % 7 === 0 ? 'wk' : ''}`} title={(dayIssues.get(d) ?? []).map((i) => i.msg).join('\n')}>{n}</td>
              })}
              <td colSpan={6} />
            </tr>
          ))}
        </tfoot>
      </table>

      {edit && editing && (
        <div className="modal-bg" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.name} · {label(dates[edit.day])}</h3>
            <p className="muted">
              현재: <b>{sc.roster[editing.id]?.[edit.day] || '(비어 있음)'}</b>
              {sc.locks[editing.id]?.[edit.day] && ' · 직접 수정(고정됨)'}
            </p>
            {reqs.get(editKey) && <p className="note">신청오프 {reqs.get(editKey)!.alt ? `(${reqs.get(editKey)!.alt} 근무로 변경 가능)` : ''}</p>}
            {fx.get(editKey) && <p className="note">지정: {[...fx.get(editKey)!.allowed].join(' / ')} — {fx.get(editKey)!.reason}</p>}
            {(cellIssues.get(`${editing.id}|${edit.day}`) ?? []).map((i) => <p key={i.id} className={`note lv-${i.level}`}>[{i.level}] {i.msg}</p>)}
            <div className="code-pick">
              {CODES.map((c) => (
                <button key={c} className={`code-btn code-${c}`} onClick={() => { onSet(editing.id, edit.day, c); setEdit(null) }}>{codeName(c)}</button>
              ))}
            </div>
            <p className="muted small">선택한 근무는 고정되어, 자동 생성을 다시 해도 바뀌지 않습니다.</p>
            <div className="row">
              <button onClick={() => { onSet(editing.id, edit.day, null); setEdit(null) }}>고정 해제 (자동 생성에 맡김)</button>
              <button onClick={() => setEdit(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

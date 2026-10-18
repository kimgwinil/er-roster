import { useState } from 'react'
import { addDays, diffDays, label } from '../dates'
import { CODES, type Scenario, WEEKDAYS } from '../types'

interface Props {
  sc: Scenario
  onChange: (fn: (sc: Scenario) => Scenario) => void
}

const KINDS = [
  ['req', '신청오프 (주휴·OF·휴가로 처리)'],
  ['leave', '연차·휴가 지정 (휴가로 고정)'],
  ['gong', '공가'],
  ['edu', '교육 (휴가 차감 없음)'],
  ['long', '장기휴가 (주휴·OF·휴가)'],
  ['work', '근무 지정 (선택한 근무 중에서)'],
  ['ofx', '주휴·OF 주간 조건 제외 기간'],
  ['minleave', '기간 내 휴가 최소 개수'],
  ['weekday', '요일 고정 (매주)'],
] as const
type Kind = (typeof KINDS)[number][0]

export function RequestsPanel({ sc, onChange }: Props) {
  const [staff, setStaff] = useState(sc.staff[0]?.id ?? '')
  const [kind, setKind] = useState<Kind>('req')
  const [from, setFrom] = useState(sc.startDate)
  const [to, setTo] = useState(sc.startDate)
  const [alt, setAlt] = useState('')
  const [onlyLeave, setOnlyLeave] = useState(false)
  const [pri, setPri] = useState<'normal' | 'low' | 'first'>('normal')
  const [rank, setRank] = useState('')
  const [codes, setCodes] = useState<string[]>(['D'])
  const [reason, setReason] = useState('')
  const [minN, setMinN] = useState(1)
  const [wd, setWd] = useState(3)

  const days = () => {
    const n = Math.max(0, diffDays(from, to))
    return Array.from({ length: n + 1 }, (_, k) => addDays(from, k))
  }

  const add = () => {
    if (!staff) return
    const why = reason || KINDS.find(([k]) => k === kind)![1]
    onChange((s) => {
      const next = { ...s }
      if (kind === 'req') {
        const keep = s.requests.filter((q) => !(q.staff === staff && days().includes(q.date)))
        next.requests = [...keep, ...days().map((date) => ({ staff, date, alt: alt || null, onlyLeave, priority: pri, rank: rank === '' ? null : Number(rank) }))]
      } else if (kind === 'leave' || kind === 'gong' || kind === 'edu' || kind === 'long' || kind === 'work') {
        const allowed = kind === 'leave' ? ['휴가'] : kind === 'gong' ? ['공가'] : kind === 'edu' ? ['교육'] : kind === 'long' ? ['주휴', 'OF', '휴가'] : codes
        next.fixed = [...s.fixed, ...days().map((date) => ({ staff, date, allowed, reason: why }))]
      } else {
        next.staff = s.staff.map((x) => {
          if (x.id !== staff) return x
          if (kind === 'ofx') return { ...x, ofExempt: [...x.ofExempt, { from, to }] }
          if (kind === 'minleave') return { ...x, leaveWindows: [...x.leaveWindows, { from, to, min: minN }] }
          return { ...x, fixedWeekdays: [...x.fixedWeekdays.filter((f) => f.weekday !== wd), { weekday: wd, code: codes[0] }] }
        })
      }
      return next
    })
    setReason('')
  }

  const byStaff = sc.staff.map((s) => ({
    s,
    reqs: sc.requests.filter((q) => q.staff === s.id).sort((a, b) => a.date.localeCompare(b.date)),
    fixed: sc.fixed.filter((f) => f.staff === s.id).sort((a, b) => a.date.localeCompare(b.date)),
  })).filter(({ s, reqs, fixed }) => reqs.length || fixed.length || s.ofExempt.length || s.leaveWindows.length || s.fixedWeekdays.length)

  return (
    <div className="panel">
      <div className="add-box">
        <div className="row wrap">
          <select value={staff} onChange={(e) => setStaff(e.target.value)}>
            {sc.staff.map((s) => <option key={s.id} value={s.id}>{s.no}. {s.name}</option>)}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
          {kind !== 'weekday' && (
            <>
              <label>시작 <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value) }} /></label>
              <label>종료 <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </>
          )}
          {kind === 'req' && (
            <>
              <label>근무 전환 허용
                <select value={alt} onChange={(e) => setAlt(e.target.value)}>
                  <option value="">없음</option>{['D', 'E', 'N', '소아'].map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label><input type="checkbox" checked={onlyLeave} onChange={(e) => setOnlyLeave(e.target.checked)} /> 휴가로만</label>
              <label title="모두 지킬 수 없을 때 바꾸는 순서: 1순위 반려 → 후순위 → 일반">반려 순서{' '}
                <select value={pri} onChange={(e) => setPri(e.target.value as 'normal' | 'low' | 'first')}>
                  <option value="normal">일반</option><option value="low">후순위</option><option value="first">1순위 반려</option>
                </select></label>
              <label title="신청 달력의 OFF 옆 괄호 숫자. 클수록 먼저 반려 (조건 설정의 기준 이상이면 1순위)">신청 번호
                <input className="w3" type="number" min={0} value={rank} onChange={(e) => setRank(e.target.value)} /></label>
            </>
          )}
          {(kind === 'work' || kind === 'weekday') && (
            <span className="row">
              {CODES.filter((c) => c !== '-').map((c) => (
                <label key={c} className="chip">
                  <input type={kind === 'weekday' ? 'radio' : 'checkbox'} name="codes" checked={codes.includes(c)}
                    onChange={(e) => setCodes(kind === 'weekday' ? [c] : e.target.checked ? [...codes, c] : codes.filter((x) => x !== c))} />{c}
                </label>
              ))}
            </span>
          )}
          {kind === 'weekday' && (
            <select value={wd} onChange={(e) => setWd(Number(e.target.value))}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}요일</option>)}</select>
          )}
          {kind === 'minleave' && <label>최소 <input className="w3" type="number" value={minN} onChange={(e) => setMinN(Number(e.target.value))} />개</label>}
          {['leave', 'gong', 'edu', 'long', 'work'].includes(kind) && <input placeholder="사유 (선택)" value={reason} onChange={(e) => setReason(e.target.value)} />}
          <button className="primary" onClick={add}>추가</button>
        </div>
        <p className="muted small">
          신청오프는 반드시 반영합니다. 모두 지킬 수 없으면 차지 5명을 먼저 허용하고, 그래도 안 되면 '1순위 반려' → '후순위' 신청 순서로 바꿉니다. 근무표에서 반영된 신청은 노랑, 반영 못 한 신청은 형광 분홍, 근무 조건에 어긋나는 칸은 형광 연두로 표시됩니다.
          연차는 [연차·휴가 지정]으로 직접 입력합니다. 입력 후 근무표에서 [이 날짜부터 다시 생성] 또는 [자동 생성]을 누르면 반영됩니다.
        </p>
      </div>

      <table className="list">
        <thead><tr><th>직원</th><th>신청오프</th><th>지정</th><th>기타 조건</th></tr></thead>
        <tbody>
          {byStaff.map(({ s, reqs, fixed }) => (
            <tr key={s.id}>
              <td>{s.no}. {s.name}</td>
              <td>
                {reqs.map((q) => (
                  <span key={q.date} className="tag">
                    {label(q.date)}{q.alt ? ` (${q.alt} 가능)` : ''}{q.onlyLeave ? ' 휴가만' : ''}{q.rank != null ? ` (${q.rank})` : ''}{q.priority === 'low' ? ' 후순위' : q.priority === 'first' ? ' 1순위 반려' : ''}
                    <button className="x" onClick={() => onChange((c) => ({ ...c, requests: c.requests.filter((r) => !(r.staff === s.id && r.date === q.date)) }))}>×</button>
                  </span>
                ))}
              </td>
              <td>
                {fixed.map((f, k) => (
                  <span key={k} className="tag" title={f.reason}>
                    {label(f.date)} {f.allowed.join('/')}
                    <button className="x" onClick={() => onChange((c) => ({ ...c, fixed: c.fixed.filter((x) => x !== f) }))}>×</button>
                  </span>
                ))}
              </td>
              <td>
                {s.fixedWeekdays.map((f) => (
                  <span key={f.weekday} className="tag">매주 {WEEKDAYS[f.weekday]} {f.code}
                    <button className="x" onClick={() => onChange((c) => ({ ...c, staff: c.staff.map((x) => x.id === s.id ? { ...x, fixedWeekdays: x.fixedWeekdays.filter((y) => y !== f) } : x) }))}>×</button>
                  </span>
                ))}
                {s.ofExempt.map((r, k) => (
                  <span key={`o${k}`} className="tag">주휴·OF 제외 {label(r.from)}~{label(r.to)}
                    <button className="x" onClick={() => onChange((c) => ({ ...c, staff: c.staff.map((x) => x.id === s.id ? { ...x, ofExempt: x.ofExempt.filter((y) => y !== r) } : x) }))}>×</button>
                  </span>
                ))}
                {s.leaveWindows.map((r, k) => (
                  <span key={`l${k}`} className="tag">{label(r.from)}~{label(r.to)} 휴가 {r.min}개 이상
                    <button className="x" onClick={() => onChange((c) => ({ ...c, staff: c.staff.map((x) => x.id === s.id ? { ...x, leaveWindows: x.leaveWindows.filter((y) => y !== r) } : x) }))}>×</button>
                  </span>
                ))}
              </td>
            </tr>
          ))}
          {!byStaff.length && <tr><td colSpan={4} className="muted">입력된 신청·지정이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

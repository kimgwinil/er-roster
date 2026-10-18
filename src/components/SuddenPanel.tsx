import { useState } from 'react'
import { label, periodDates } from '../dates'
import type { Scenario } from '../types'

export interface SuddenInput {
  staff: string
  from: string
  to: string
  kind: string
  reason: string
  replace: boolean
}

interface Props {
  sc: Scenario
  busy: boolean
  /** 대체 근무 자동 편성(서버) 사용 가능 여부 */
  canSolve: boolean
  onApply: (input: SuddenInput) => void
  onRemoveEvent: (id: string) => void
}

const KINDS: [string, string][] = [
  ['병가', '병가 — 연차 차감 없음'],
  ['경조', '경조(상조) 휴가 — 연차 차감 없음'],
  ['생휴', '생리휴가 — 연차 차감 없음'],
  ['휴가', '연차(당일 휴가) — 잔여에서 차감'],
  ['공가', '공가'],
  ['조퇴', '조퇴 — 근무는 그대로, 표시·확인만'],
]

export function SuddenPanel({ sc, busy, canSolve, onApply, onRemoveEvent }: Props) {
  const dates = periodDates(sc.startDate, sc.days)
  const [f, setF] = useState<SuddenInput>({ staff: sc.staff[0]?.id ?? '', from: dates[0], to: dates[0], kind: '병가', reason: '', replace: true })
  const name = (id: string) => sc.staff.find((s) => s.id === id)?.name ?? id
  const events = [...(sc.events ?? [])].sort((a, b) => b.at.localeCompare(a.at))
  const row = sc.roster[f.staff] ?? []
  const preview = dates.map((d, i) => [d, row[i]] as const).filter(([d]) => d >= f.from && d <= (f.kind === '조퇴' ? f.from : f.to))

  return (
    <div className="panel">
      <div className="add-box">
        <div className="row wrap">
          <b>급작 휴가·변동 입력</b>
          <select value={f.staff} onChange={(e) => setF({ ...f, staff: e.target.value })}>
            {sc.staff.map((s) => <option key={s.id} value={s.id}>{s.no}. {s.name}</option>)}
          </select>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
          <label>{f.kind === '조퇴' ? '날짜' : '시작'} <input type="date" min={dates[0]} max={dates[dates.length - 1]} value={f.from}
            onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></label>
          {f.kind !== '조퇴' && <label>종료 <input type="date" min={f.from} max={dates[dates.length - 1]} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>}
          <input className="w12" placeholder="사유 (예: 독감, 부친상, 오후 조퇴)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {f.kind !== '조퇴' && canSolve && (
            <label className="chip on">
              <input type="checkbox" checked={f.replace} onChange={(e) => setF({ ...f, replace: e.target.checked })} />
              대체 근무 자동 편성 (그날부터 다시 생성, 기존 근무 최대 유지)
            </label>
          )}
          <span className="muted small">
            현재 근무: {preview.map(([d, c]) => `${label(d)} ${c || '-'}`).join(' · ') || '—'}
          </span>
          <button className="primary" disabled={busy || !f.staff} onClick={() => onApply({ ...f, replace: f.replace && canSolve })}>적용</button>
        </div>
        <p className="muted small">
          적용하면 해당 칸이 {f.kind === '조퇴' ? '조퇴로 표시되고(근무 유지) 확인 항목이 생깁니다.' : `'${f.kind}'(으)로 바뀌고 고정됩니다.`}
          {f.kind !== '조퇴' && ' 빈자리는 [대체 근무 자동 편성]을 켜 두면 그날부터 다시 짜되 바뀌는 칸을 최소로 합니다. 바뀐 칸은 근무표에 초록 표시로 보입니다.'}
        </p>
      </div>

      <h3 className="sec">변동 이력</h3>
      <table className="list">
        <thead><tr><th>입력 시각</th><th>직원</th><th>종류</th><th>기간</th><th>사유</th><th>이전 근무</th><th>대체 편성</th><th /></tr></thead>
        <tbody>
          {events.map((ev) => (
            <tr key={ev.id}>
              <td className="small">{ev.at.replace('T', ' ').slice(0, 16)}</td>
              <td>{name(ev.staff)}</td>
              <td><span className={`cell code-${ev.kind}`}>{ev.kind}</span></td>
              <td className="small">{label(ev.from)}{ev.to !== ev.from ? ` ~ ${label(ev.to)}` : ''}</td>
              <td className="small">{ev.reason}</td>
              <td className="small">{ev.before.join(' ')}</td>
              <td className="small">{ev.replaced === undefined ? '-' : `${ev.replaced}칸 변경`}</td>
              <td><button className="small" title="이력에서만 지웁니다 (근무표는 그대로)" onClick={() => onRemoveEvent(ev.id)}>이력 삭제</button></td>
            </tr>
          ))}
          {!events.length && <tr><td colSpan={8} className="muted">아직 변동 이력이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

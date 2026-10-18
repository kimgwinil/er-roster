import { useState } from 'react'
import { ask } from '../platform'
import { emptyStaff } from '../excel'
import { type Roles, type Scenario, type Staff, WEEKDAYS } from '../types'

interface Props {
  sc: Scenario
  onChange: (fn: (sc: Scenario) => Scenario) => void
}

const ROLE_LABEL: [keyof Roles, string][] = [['charge', '차지'], ['newbie', '신규'], ['pedsCharge', '소아차지'], ['pedsActing', '소아액팅'], ['pedsBackup', '소아차지 대체']]

export function StaffPanel({ sc, onChange }: Props) {
  const [newName, setNewName] = useState('')
  const [newStart, setNewStart] = useState(sc.startDate)

  const set = (id: string, patch: Partial<Staff>) =>
    onChange((s) => ({ ...s, staff: s.staff.map((x) => (x.id === id ? { ...x, ...patch } : x)) }))

  const add = () => {
    if (!newName.trim()) return
    const no = Math.max(0, ...sc.staff.map((s) => s.no)) + 1
    const st = emptyStaff(no, newName.trim())
    st.startDate = newStart > sc.startDate ? newStart : null
    st.roles.newbie = true
    st.memo = `${newStart} 입사`
    onChange((s) => ({ ...s, staff: [...s.staff, st], roster: { ...s.roster, [st.id]: [] } }))
    setNewName('')
  }

  const remove = (st: Staff) => {
    if (!ask(`${st.name} 님을 명단에서 완전히 삭제할까요? (퇴사는 [퇴사일]을 입력하는 것을 권장)`)) return
    onChange((s) => {
      const roster = { ...s.roster }
      delete roster[st.id]
      return { ...s, staff: s.staff.filter((x) => x.id !== st.id), roster,
        requests: s.requests.filter((q) => q.staff !== st.id), fixed: s.fixed.filter((f) => f.staff !== st.id) }
    })
  }

  return (
    <div className="panel">
      <div className="row wrap add-box">
        <b>신규 입사</b>
        <input placeholder="이름" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <label>입사일 <input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} /></label>
        <button className="primary" onClick={add}>직원 추가</button>
        <span className="muted small">추가 후 역할·주휴·잔여휴가를 입력하고 [이 날짜부터 다시 생성]을 누르세요. 퇴사는 [퇴사일]에 마지막 근무일을 입력합니다.</span>
      </div>
      <div className="table-scroll">
        <table className="list staff">
          <thead>
            <tr>
              <th>번호</th><th>이름</th>{ROLE_LABEL.map(([, t]) => <th key={t}>{t}</th>)}<th>주휴</th><th>잔여휴가</th>
              <th>직전 근무 (/로 구분)</th><th>가능 근무</th><th title="주휴·OF 전날 N 불가">휴무전날 N불가</th>
              <th>최소 휴가</th><th>소아 최대</th><th>입사일</th><th>퇴사일</th><th>메모</th><th />
            </tr>
          </thead>
          <tbody>
            {sc.staff.map((s) => (
              <tr key={s.id} className={s.endDate ? 'leaving' : ''}>
                <td><input className="w3" type="number" value={s.no} onChange={(e) => set(s.id, { no: Number(e.target.value) })} /></td>
                <td><input className="w6" value={s.name} onChange={(e) => set(s.id, { name: e.target.value })} /></td>
                {ROLE_LABEL.map(([k]) => (
                  <td key={k}><input type="checkbox" checked={!!s.roles[k]} onChange={(e) => set(s.id, { roles: { ...s.roles, [k]: e.target.checked } })} /></td>
                ))}
                <td>
                  <select value={s.juhu} onChange={(e) => set(s.id, { juhu: Number(e.target.value) })}>
                    {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
                  </select>
                </td>
                <td><input className="w3" type="number" value={s.leave} onChange={(e) => set(s.id, { leave: Number(e.target.value) })} /></td>
                <td><input className="w10" value={s.prev.join('/')} onChange={(e) => set(s.id, { prev: e.target.value.split('/').map((t) => t.trim()).filter(Boolean) })} /></td>
                <td>
                  <input className="w5" placeholder="제한 없음" value={s.allowed?.join(',') ?? ''}
                    onChange={(e) => { const v = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); set(s.id, { allowed: v.length ? v : null }) }} />
                </td>
                <td><input type="checkbox" checked={s.noNightBeforeOff} onChange={(e) => set(s.id, { noNightBeforeOff: e.target.checked })} /></td>
                <td><input className="w3" type="number" value={s.minLeave} onChange={(e) => set(s.id, { minLeave: Number(e.target.value) })} /></td>
                <td><input className="w3" type="number" placeholder="-" value={s.maxPeds ?? ''} onChange={(e) => set(s.id, { maxPeds: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                <td><input type="date" value={s.startDate ?? ''} onChange={(e) => set(s.id, { startDate: e.target.value || null })} /></td>
                <td><input type="date" value={s.endDate ?? ''} onChange={(e) => set(s.id, { endDate: e.target.value || null })} /></td>
                <td><input className="w12" value={s.memo} onChange={(e) => set(s.id, { memo: e.target.value })} /></td>
                <td><button className="small danger" onClick={() => remove(s)}>삭제</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        가능 근무 예: <code>D,N</code> (D·N만 가능). 요일 고정·기간 지정·장기휴가·공가는 [신청·지정] 화면에서 입력합니다.
      </p>
    </div>
  )
}

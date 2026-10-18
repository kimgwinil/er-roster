import { addDays, label, short } from '../dates'
import { applyPrevWeek, ledger, weekCount } from '../leave'
import type { Scenario } from '../types'

interface Props {
  sc: Scenario
  onChange: (fn: (sc: Scenario) => Scenario) => void
}

export function LeavePanel({ sc, onChange }: Props) {
  const W = weekCount(sc)

  const setStart = (sid: string, w: number, v: number | null) =>
    onChange((c) => ({
      ...c,
      staff: c.staff.map((s) => {
        if (s.id !== sid) return s
        const wl = [...(s.weekLeave ?? [])]
        while (wl.length < W) wl.push(null)
        wl[w] = v
        return { ...s, weekLeave: wl }
      }),
    }))

  return (
    <div className="panel">
      <div className="row wrap add-box">
        <b>전주 대비 적용</b>
        {Array.from({ length: W - 1 }, (_, k) => k + 1).map((w) => (
          <button key={w} className="primary" onClick={() => onChange((c) => applyPrevWeek(c, w))}>
            {w + 1}주차에 {w}주차 잔여 적용
          </button>
        ))}
        <button onClick={() => onChange((c) => ({ ...c, staff: c.staff.map((s) => ({ ...s, weekLeave: [] })) }))}>모두 자동 계산으로</button>
      </div>
      <p className="muted small">
        각 주 시작 잔여 = 전주 종료 잔여(자동). [전주 대비 적용]을 누르면 그 주 시작 잔여가 전주 종료 잔여로 <b>확정</b>(파란 칸)됩니다.
        연차를 새로 받거나 조정할 때는 시작 잔여 칸에 직접 숫자를 입력하세요. 휴가 개수는 {short(sc.leaveCapUntil)}까지만 잔여에서 차감하고,
        그 이후 휴가는 [이후] 칸에 따로 셉니다. [보상]은 나이트 보상휴가(조건 설정)로 생긴 휴가이며, 그 날짜부터 쓸 수 있습니다. 자동 생성은 이 잔여를 넘지 않게 휴가를 배치합니다.
      </p>
      <div className="table-scroll">
        <table className="list leave">
          <thead>
            <tr>
              <th rowSpan={2}>번호</th><th rowSpan={2}>이름</th><th rowSpan={2}>시작 잔여</th>
              {Array.from({ length: W }, (_, w) => (
                <th key={w} colSpan={4}>{w + 1}주차 {label(addDays(sc.startDate, w * 7))}~</th>
              ))}
              <th rowSpan={2}>이후 휴가</th>
            </tr>
            <tr>{Array.from({ length: W }, (_, w) => ['시작', '보상', '사용', '종료'].map((t) => <th key={`${w}${t}`}>{t}</th>))}</tr>
          </thead>
          <tbody>
            {sc.staff.map((s) => {
              const lg = ledger(sc, s)
              return (
                <tr key={s.id}>
                  <td>{s.no}</td>
                  <td>{s.name}</td>
                  <td>
                    <input className="w3" type="number" value={s.leave}
                      onChange={(e) => onChange((c) => ({ ...c, staff: c.staff.map((x) => (x.id === s.id ? { ...x, leave: Number(e.target.value) } : x)) }))} />
                  </td>
                  {lg.start.map((st, w) => [
                    <td key={`s${w}`} className={lg.manual[w] ? 'manual' : ''}>
                      {w === 0 ? st : (
                        <input className="w3" type="number" value={st}
                          onChange={(e) => setStart(s.id, w, e.target.value === '' ? null : Number(e.target.value))} />
                      )}
                    </td>,
                    <td key={`b${w}`} className="bonus">{lg.bonus[w] ? `+${lg.bonus[w]}` : ''}</td>,
                    <td key={`u${w}`}>{lg.used[w] || ''}</td>,
                    <td key={`e${w}`} className={lg.end[w] < 0 ? 'neg' : ''}>{lg.end[w]}</td>,
                  ])}
                  <td>{lg.after.reduce((a, b) => a + b, 0) || ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

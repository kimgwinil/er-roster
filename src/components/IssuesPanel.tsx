import { useState } from 'react'
import { askText } from '../platform'
import type { Issue, Level, Scenario } from '../types'

interface Props {
  sc: Scenario
  issues: Issue[]
  onFocus: (i: Issue) => void
  onAck: (id: string, memo: string | null) => void
}

export function IssuesPanel({ sc, issues, onFocus, onAck }: Props) {
  const [show, setShow] = useState<Record<Level, boolean>>({ 위반: true, 확인: true, 권장: false })
  const [showAcked, setShowAcked] = useState(false)
  const count = (l: Level) => issues.filter((i) => i.level === l && sc.acks[i.id] === undefined).length
  const list = issues.filter((i) => show[i.level] && (showAcked || sc.acks[i.id] === undefined))

  return (
    <div className="panel">
      <div className="row wrap">
        {(['위반', '확인', '권장'] as Level[]).map((l) => (
          <label key={l} className={`chip lv-${l}`}>
            <input type="checkbox" checked={show[l]} onChange={(e) => setShow({ ...show, [l]: e.target.checked })} />
            {l} {count(l)}
          </label>
        ))}
        <label className="chip">
          <input type="checkbox" checked={showAcked} onChange={(e) => setShowAcked(e.target.checked)} />
          확인 완료 항목도 보기 ({Object.keys(sc.acks).length})
        </label>
      </div>
      <p className="muted small">
        <b>위반</b>: 조건을 어긴 칸 · <b>확인</b>: 사람이 판단해야 할 사항(허용된 변경, 다음 번표 이월 등) · <b>권장</b>: 지양 패턴.
        내용을 누르면 해당 칸으로 이동합니다. 불가피한 항목은 메모를 남기고 [확인 완료] 처리하세요.
      </p>
      {sc.notes.length > 0 && (
        <div className="notes">
          {sc.notes.map((n, k) => <div key={k}>· {n}</div>)}
        </div>
      )}
      <table className="list">
        <thead><tr><th>구분</th><th>항목</th><th>내용</th><th>확인 메모</th></tr></thead>
        <tbody>
          {list.map((i) => {
            const acked = sc.acks[i.id] !== undefined
            return (
              <tr key={i.id} className={acked ? 'acked' : ''}>
                <td><span className={`badge lv-${i.level}`}>{i.level}</span></td>
                <td>{i.rule}</td>
                <td><button className="link" onClick={() => onFocus(i)}>{i.msg}</button></td>
                <td>
                  {acked ? (
                    <span>
                      {sc.acks[i.id] || '확인 완료'} <button className="small" onClick={() => onAck(i.id, null)}>취소</button>
                    </span>
                  ) : (
                    <button className="small" onClick={() => onAck(i.id, askText('확인 메모 (예: 불가피, 수간호사 승인)', '') ?? '')}>확인 완료</button>
                  )}
                </td>
              </tr>
            )
          })}
          {!list.length && <tr><td colSpan={4} className="muted">표시할 항목이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

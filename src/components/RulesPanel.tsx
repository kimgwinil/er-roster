import { normalize } from '../store'
import { SHIFTS, type Scenario } from '../types'

interface Props {
  sc: Scenario
  onChange: (fn: (sc: Scenario) => Scenario) => void
}

export function RulesPanel({ sc, onChange }: Props) {
  const rule = (k: keyof Scenario['rules'], v: number) => onChange((c) => ({ ...c, rules: { ...c.rules, [k]: v } }))

  return (
    <div className="panel rules">
      <section>
        <h3>기간</h3>
        <label>제목 <input className="w20" value={sc.title} onChange={(e) => onChange((c) => ({ ...c, title: e.target.value }))} /></label>
        <label>시작일(일요일) <input type="date" value={sc.startDate} onChange={(e) => onChange((c) => normalize({ ...c, startDate: e.target.value }))} /></label>
        <label>일수 <input className="w3" type="number" value={sc.days} onChange={(e) => onChange((c) => normalize({ ...c, days: Number(e.target.value) }))} /></label>
        <label>잔여휴가 차감 마감일 <input type="date" value={sc.leaveCapUntil} onChange={(e) => onChange((c) => ({ ...c, leaveCapUntil: e.target.value }))} /></label>
      </section>
      <section>
        <h3>하루 근무 인원 (매일 동일, 주말·공휴일 구분 없음)</h3>
        {SHIFTS.map((s) => (
          <label key={s}>{s} <input className="w3" type="number" value={sc.demand[s]}
            onChange={(e) => onChange((c) => ({ ...c, demand: { ...c.demand, [s]: Number(e.target.value) } }))} />명</label>
        ))}
        {Object.entries(sc.shiftTimes).map(([k, v]) => (
          <label key={k}>{k} 시간 <input className="w8" value={v} onChange={(e) => onChange((c) => ({ ...c, shiftTimes: { ...c.shiftTimes, [k]: e.target.value } }))} /></label>
        ))}
      </section>
      <section>
        <h3>구성·연속 근무</h3>
        <label>D/E/N 차지 <input className="w3" type="number" value={sc.rules.chargeMin} onChange={(e) => rule('chargeMin', +e.target.value)} />
          ~ <input className="w3" type="number" value={sc.rules.chargeMax} onChange={(e) => rule('chargeMax', +e.target.value)} />명</label>
        <label title="끄면: 신청오프를 지키려고 차지 5명 등을 허용. 켜면: 차지 범위를 지키려고 신청오프를 근무로 바꾸고 빨강 표시">
          <input type="checkbox" checked={!!sc.rules.chargeFirst} onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, chargeFirst: e.target.checked } }))} />
          차지 인원을 신청오프보다 우선</label>
        <label title="신청 달력의 OFF 옆 괄호 숫자(신청 번호)가 이 값 이상이면 1순위로 반려. 그 밖에도 숫자가 클수록 먼저 반려">
          신청 번호 <input className="w3" type="number" placeholder="-" value={sc.rules.rejectRankFrom ?? ''}
            onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, rejectRankFrom: e.target.value === '' ? null : Number(e.target.value) } }))} />
          이상 1순위 반려</label>
        <label title="신청오프를 못 지킬 때 하루에 반려할 수 있는 최대 인원 (넘으면 그날 인원이 모자라게 둠)">
          반려 하루 <input className="w3" type="number" placeholder="-" value={sc.rules.maxRejectPerDay ?? ''}
            onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, maxRejectPerDay: e.target.value === '' ? null : Number(e.target.value) } }))} />명까지</label>
        <label><input type="checkbox" checked={!!sc.rules.rejectOncePerPerson}
          onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, rejectOncePerPerson: e.target.checked } }))} /> 같은 사람 반려는 1번까지</label>
        <label>D/E/N 신규 최대 <input className="w3" type="number" value={sc.rules.newMax} onChange={(e) => rule('newMax', +e.target.value)} />명</label>
        <label>연속 근무 최대 <input className="w3" type="number" value={sc.rules.maxWork} onChange={(e) => rule('maxWork', +e.target.value)} />일</label>
        <label>연속 N 최대 <input className="w3" type="number" value={sc.rules.maxNight} onChange={(e) => rule('maxNight', +e.target.value)} />개</label>
        <label>연속 N(2개 이상) 뒤 휴무 <input className="w3" type="number" value={sc.rules.nightBlockRest} onChange={(e) => rule('nightBlockRest', +e.target.value)} />일 이상</label>
      </section>
      <section>
        <h3>나이트 보상휴가</h3>
        <label><input type="checkbox" checked={!!sc.rules.nightAccrual?.per}
          onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, nightAccrual: e.target.checked ? { from: c.startDate, to: c.leaveCapUntil, per: 5 } : null } }))} /> 사용</label>
        {sc.rules.nightAccrual?.per ? (<>
          <label>기간 <input type="date" value={sc.rules.nightAccrual.from} onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, nightAccrual: { ...c.rules.nightAccrual!, from: e.target.value } } }))} />
            ~ <input type="date" value={sc.rules.nightAccrual.to} onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, nightAccrual: { ...c.rules.nightAccrual!, to: e.target.value } } }))} /></label>
          <label>N <input className="w3" type="number" value={sc.rules.nightAccrual.per} onChange={(e) => onChange((c) => ({ ...c, rules: { ...c.rules, nightAccrual: { ...c.rules.nightAccrual!, per: +e.target.value } } }))} />개마다 휴가 +1 (마지막 N 다음 날부터 사용)</label>
        </>) : null}
      </section>
      <section>
        <h3>근무 순서 금지·지향</h3>
        <p className="muted small">근무 순서(E→D 금지, N→휴무→D 금지, N→휴무→E 지양 등)는 [조건 규칙] 화면에서 금지·지향으로 정합니다.</p>
      </section>
      {!!sc.conditionText?.length && (
        <section>
          <h3>원본 조건 (엑셀에서 불러온 문장)</h3>
          <ol className="cond">{sc.conditionText.map((t, k) => <li key={k}>{t}</li>)}</ol>
        </section>
      )}
    </div>
  )
}

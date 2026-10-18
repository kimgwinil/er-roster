import { useState } from 'react'
import { ask, notify } from '../platform'
import { describe, newId } from '../conditions'
import { type Condition, type Roles, type Scenario, WEEKDAYS } from '../types'

interface Props {
  sc: Scenario
  onChange: (fn: (sc: Scenario) => Scenario) => void
}

const KINDS: [Condition['kind'], string][] = [
  ['sequence', '근무 순서 (전날 → 다음날 …)'],
  ['assign', '근무 제한·지정 (누가 언제 무엇을)'],
  ['conditional', '조건부 제한 (A 근무면 n일 뒤·전 B)'],
  ['count', '횟수 (최소·최대)'],
  ['together', '같은 근무 (함께·따로)'],
]
/** 새 조건 버튼: [종류, 모드, 이름] */
const NEW_BUTTONS: [Condition['kind'], string | undefined, string][] = [
  ['assign', 'not', '근무 제한 (안 됨)'],
  ['assign', 'only', '근무 지정 (이 근무만)'],
  ['conditional', 'not', '조건부 제한 (A면 n일 뒤·전 B 안 됨)'],
  ['sequence', undefined, '근무 순서'],
  ['count', undefined, '횟수'],
  ['together', undefined, '같은 근무 함께·따로'],
]
const ROLES: [keyof Roles, string][] = [['charge', '차지'], ['newbie', '신규'], ['pedsCharge', '소아차지'], ['pedsActing', '소아액팅']]

const blank = (kind: Condition['kind'] = 'sequence'): Condition => ({
  id: '', on: true, level: '금지', weight: 2, kind, staff: [], role: null, from: null, to: null, weekdays: [],
  pattern: kind === 'sequence' ? ['N', 'D'] : undefined,
  codes: kind === 'sequence' ? undefined : kind === 'together' ? ['D', 'E', 'N'] : ['N'],
  mode: kind === 'assign' || kind === 'conditional' ? 'not' : kind === 'together' ? 'apart' : undefined,
  trigger: kind === 'conditional' ? ['주휴', 'OF'] : undefined,
  offset: kind === 'conditional' ? -1 : undefined,
  min: null, max: kind === 'count' ? 7 : null, other: [], title: '', text: '',
})

const TEMPLATES: [string, () => Partial<Condition>][] = [
  ['순서 금지 예: N → D', () => ({ kind: 'sequence', level: '금지', pattern: ['N', 'D'], title: 'N 다음 날 D 금지' })],
  ['휴식 예: N → 휴무 → D', () => ({ kind: 'sequence', level: '금지', pattern: ['N', '휴무', 'D'], title: 'N 후 하루 쉬고 D 금지' })],
  ['지양 예: N → 휴무 → E', () => ({ kind: 'sequence', level: '지향', pattern: ['N', '휴무', 'E'], title: 'N 후 하루 쉬고 E 지양' })],
  ['특정인 근무 제한', () => ({ kind: 'assign', level: '금지', codes: ['N'], mode: 'not', title: '기간 중 N 안 됨' })],
  ['조건부 예: 주휴·OF 전날 N 안 됨', () => ({ kind: 'conditional', level: '금지', trigger: ['주휴', 'OF'], offset: -1, codes: ['N'], mode: 'not', title: '주휴·OF 전날 N 불가' })],
  ['조건부 예: 교육 전날 E 안 됨', () => ({ kind: 'conditional', level: '금지', trigger: ['교육'], offset: -1, codes: ['E', 'N'], mode: 'not', title: '교육 전날 E·N 불가' })],
  ['횟수 상한', () => ({ kind: 'count', level: '금지', codes: ['N'], max: 7, title: 'N 7개 이하' })],
  ['두 사람 따로', () => ({ kind: 'together', level: '지향', codes: ['D', 'E', 'N'], mode: 'apart', title: '같은 근무에 함께 넣지 않기' })],
]

const splitCodes = (t: string) => t.split(/[,\s/]+/).map((x) => x.trim()).filter(Boolean)
const splitPattern = (t: string) => t.split(/→|->|>|,/).map((x) => x.trim()).filter(Boolean)

export function ConditionsPanel({ sc, onChange }: Props) {
  const conds = sc.conditions ?? []
  const [form, setForm] = useState<Condition | null>(null)
  const [memo, setMemo] = useState({ staff: '', from: '', to: '', text: '' })
  const [who, setWho] = useState('')
  const withWho = (c: Condition): Condition => (who && !c.staff.length ? { ...c, staff: [who] } : c)
  const name = (id: string) => sc.staff.find((s) => s.id === id)?.name ?? id

  const save = (c: Condition) => {
    const next = { ...c, id: c.id || newId() }
    onChange((s) => {
      const list = s.conditions ?? []
      const exists = list.some((x) => x.id === next.id)
      return { ...s, version: 2, conditions: exists ? list.map((x) => (x.id === next.id ? next : x)) : [...list, next] }
    })
    setForm(null)
  }
  const patch = (id: string, p: Partial<Condition>) =>
    onChange((s) => ({ ...s, conditions: (s.conditions ?? []).map((x) => (x.id === id ? { ...x, ...p } : x)) }))
  const remove = (id: string) => onChange((s) => ({ ...s, conditions: (s.conditions ?? []).filter((x) => x.id !== id) }))

  const mine = (c: Condition) => !who || c.staff.includes(who) || c.other?.includes(who)
  const rules = conds.filter((c) => c.kind !== 'memo' && mine(c))
  const memos = conds.filter((c) => c.kind === 'memo' && mine(c))

  const addMemo = () => {
    if (!memo.text.trim()) return
    save({ ...blank(), kind: 'memo', pattern: undefined, codes: undefined, mode: undefined, max: null,
      staff: memo.staff ? [memo.staff] : [], from: memo.from || null, to: memo.to || memo.from || null, text: memo.text.trim() })
    setMemo({ staff: '', from: '', to: '', text: '' })
  }

  const importText = () => {
    const lines = sc.conditionText ?? []
    if (!lines.length || !ask(`원본 조건 문장 ${lines.length}개를 근무 특별조건으로 가져올까요?`)) return
    onChange((s) => ({ ...s, version: 2, conditions: [...(s.conditions ?? []), ...lines.map((t) => ({ ...blank(), id: newId(), kind: 'memo' as const, pattern: undefined, codes: undefined, mode: undefined, max: null, text: t }))] }))
  }

  return (
    <div className="panel">
      <section>
        <div className="row wrap">
          <h3 className="sec">금지·지향 조건</h3>
          <span className="badge lv-위반">금지 = 반드시 지킴 (어기면 위반)</span>
          <span className="badge lv-권장">지향 = 가능하면 지킴 (어기면 권장 표시)</span>
        </div>
        <div className="row wrap add-box">
          <b>특정인 근무조건</b>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">전체 보기</option>
            {sc.staff.map((s) => <option key={s.id} value={s.id}>{s.no}. {s.name}</option>)}
          </select>
          <span className="muted small">{who ? '이 직원의 조건만 보이고, 새 조건은 이 직원 대상으로 시작합니다.' : '직원을 고르면 그 사람의 조건만 모아 보고 바로 지정할 수 있습니다.'}</span>
        </div>
        <div className="row wrap add-box">
          <b>새 조건</b>
          {NEW_BUTTONS.map(([k, mode, t]) => <button key={t} onClick={() => setForm(withWho({ ...blank(k), ...(mode ? { mode } : {}) }))}>{t}</button>)}
          <span className="sep" />
          <span className="muted small">예시:</span>
          {TEMPLATES.map(([t, f]) => <button key={t} className="small" onClick={() => setForm(withWho({ ...blank(f().kind), ...f() }))}>{t}</button>)}
        </div>
        <table className="list">
          <thead><tr><th>사용</th><th>구분</th><th>종류</th><th>조건</th><th>설명</th><th /></tr></thead>
          <tbody>
            {rules.map((c) => (
              <tr key={c.id} className={c.on ? '' : 'acked'}>
                <td><input type="checkbox" checked={c.on} onChange={(e) => patch(c.id, { on: e.target.checked })} /></td>
                <td>
                  <select value={c.level} onChange={(e) => patch(c.id, { level: e.target.value as Condition['level'] })}>
                    <option>금지</option><option>지향</option>
                  </select>
                  {c.level === '지향' && (
                    <select value={c.weight} title="중요도" onChange={(e) => patch(c.id, { weight: Number(e.target.value) })}>
                      <option value={1}>약</option><option value={2}>중</option><option value={3}>강</option>
                    </select>
                  )}
                </td>
                <td className="small">{KINDS.find(([k]) => k === c.kind)?.[1].split(' (')[0]}</td>
                <td>{describe(c, sc)}</td>
                <td className="small">{c.title}</td>
                <td className="row">
                  <button className="small" onClick={() => setForm(c)}>수정</button>
                  <button className="small danger" onClick={() => ask('이 조건을 삭제할까요?') && remove(c.id)}>삭제</button>
                </td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={6} className="muted">조건이 없습니다.</td></tr>}
          </tbody>
        </table>
      </section>

      <section style={{ marginTop: 18 }}>
        <div className="row wrap">
          <h3 className="sec">근무 특별조건 (자유 입력)</h3>
          <span className="muted small">교육·연수·개인 사정 등. 근무표 칸 메모와 [확인·위반]에 '확인' 항목으로 늘 표시됩니다. 자동 생성에 반영하려면 [규칙으로 만들기]를 누르세요.</span>
        </div>
        <div className="row wrap add-box">
          <select value={memo.staff} onChange={(e) => setMemo({ ...memo, staff: e.target.value })}>
            <option value="">전체</option>
            {sc.staff.map((s) => <option key={s.id} value={s.id}>{s.no}. {s.name}</option>)}
          </select>
          <label>시작 <input type="date" value={memo.from} onChange={(e) => setMemo({ ...memo, from: e.target.value })} /></label>
          <label>종료 <input type="date" value={memo.to} onChange={(e) => setMemo({ ...memo, to: e.target.value })} /></label>
          <input className="w20" placeholder="예: 11/25~27 온보딩 교육, 2주차 나이트 불가, 해외연수 등" value={memo.text}
            onChange={(e) => setMemo({ ...memo, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addMemo()} />
          <button className="primary" onClick={addMemo}>특별조건 추가</button>
          {!!sc.conditionText?.length && <button onClick={importText}>원본 조건 문장 가져오기</button>}
        </div>
        <table className="list">
          <thead><tr><th>대상</th><th>기간</th><th>내용</th><th /></tr></thead>
          <tbody>
            {memos.map((c) => (
              <tr key={c.id}>
                <td>{c.staff.length ? c.staff.map(name).join('·') : '전체'}</td>
                <td className="small">{c.from ?? ''}{c.to && c.to !== c.from ? ` ~ ${c.to}` : ''}</td>
                <td><input className="w-full" value={c.text} onChange={(e) => patch(c.id, { text: e.target.value })} /></td>
                <td className="row">
                  <button className="small" onClick={() => setForm({ ...blank('assign'), staff: c.staff, from: c.from, to: c.to, title: c.text })}>규칙으로 만들기</button>
                  <button className="small danger" onClick={() => remove(c.id)}>삭제</button>
                </td>
              </tr>
            ))}
            {!memos.length && <tr><td colSpan={4} className="muted">입력된 특별조건이 없습니다.</td></tr>}
          </tbody>
        </table>
      </section>

      {form && <ConditionForm sc={sc} init={form} onSave={save} onClose={() => setForm(null)} />}
    </div>
  )
}

function ConditionForm({ sc, init, onSave, onClose }: { sc: Scenario; init: Condition; onSave: (c: Condition) => void; onClose: () => void }) {
  const [c, setC] = useState<Condition>(init)
  const [pat, setPat] = useState((init.pattern ?? []).join(' → '))
  const [codes, setCodes] = useState((init.codes ?? []).join(', '))
  const [trig, setTrig] = useState((init.trigger ?? []).join(', '))
  const set = (p: Partial<Condition>) => setC({ ...c, ...p })
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const submit = () => {
    const out: Condition = { ...c }
    if (c.kind === 'sequence') out.pattern = splitPattern(pat)
    else out.codes = splitCodes(codes)
    if (c.kind === 'conditional') {
      out.trigger = splitCodes(trig)
      if (!out.trigger.length || !out.codes?.length) return notify('기준 근무와 대상 근무를 입력하세요.')
    }
    if (c.kind === 'sequence' && (out.pattern?.length ?? 0) < 2) return notify('순서는 2개 이상 입력하세요. 예: N → 휴무 → D')
    onSave(out)
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{c.id ? '조건 수정' : '새 조건'} · {KINDS.find(([k]) => k === c.kind)?.[1]}</h3>
        <div className="form-grid">
          <label>구분</label>
          <div className="row">
            {(['금지', '지향'] as const).map((l) => (
              <label key={l} className={`chip ${l === '금지' ? 'lv-위반' : 'lv-권장'}`}>
                <input type="radio" checked={c.level === l} onChange={() => set({ level: l })} /> {l}
              </label>
            ))}
            {c.level === '지향' && (
              <select value={c.weight} onChange={(e) => set({ weight: Number(e.target.value) })}>
                <option value={1}>중요도 약</option><option value={2}>중요도 중</option><option value={3}>중요도 강</option>
              </select>
            )}
          </div>

          {c.kind === 'sequence' && (<>
            <label>순서</label>
            <div>
              <input className="w-full" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="N → 휴무 → D" />
              <p className="muted small">이 순서가 <b>나오지 않게</b> 합니다. 코드: D E N 소아 미드 주휴 OF 휴가 공가 교육 · 묶음: 근무, 휴무, * (아무거나) · 여럿: E|소아 · 제외: !N</p>
            </div>
          </>)}
          {c.kind === 'conditional' && (<>
            <label>조건</label>
            <div className="row wrap">
              <input className="w8" value={trig} onChange={(e) => setTrig(e.target.value)} placeholder="주휴, OF" /> 근무인 날의
              <select value={c.offset ?? 1} onChange={(e) => set({ offset: Number(e.target.value) })}>
                {[-3, -2, -1, 1, 2, 3].map((o) => <option key={o} value={o}>{Math.abs(o)}일 {o < 0 ? '전' : '뒤'}</option>)}
              </select>
              에는
              <input className="w8" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="N" />
              <select value={c.mode} onChange={(e) => set({ mode: e.target.value })}>
                <option value="not">근무 안 됨</option><option value="only">근무만</option>
              </select>
            </div>
          </>)}
          {(c.kind === 'assign' || c.kind === 'count' || c.kind === 'together') && (<>
            <label>근무</label>
            <div>
              <input className="w10" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="N 또는 D, E" />
              {c.kind === 'assign' && (
                <select value={c.mode} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="not">근무 안 됨</option><option value="only">이 근무만</option>
                </select>
              )}
              {c.kind === 'together' && (
                <select value={c.mode} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="apart">같은 근무에 함께 넣지 않기</option><option value="together">같은 근무에 함께 넣기</option>
                </select>
              )}
              {c.kind === 'count' && (
                <span className="row">
                  최소 <input className="w3" type="number" value={c.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? null : Number(e.target.value) })} />
                  최대 <input className="w3" type="number" value={c.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? null : Number(e.target.value) })} />
                  <span className="muted small">회 (직원별, 기간 안)</span>
                </span>
              )}
            </div>
          </>)}

          <label>대상</label>
          <div>
            <div className="row wrap">
              <select value={c.role ?? ''} onChange={(e) => set({ role: (e.target.value || null) as Condition['role'] })}>
                <option value="">역할 전체</option>{ROLES.map(([k, t]) => <option key={k} value={k}>{t}만</option>)}
              </select>
              <span className="muted small">직원을 고르지 않으면 (역할) 전체에 적용</span>
            </div>
            <div className="staff-pick">
              {sc.staff.map((s) => (
                <label key={s.id} className={`chip ${c.staff.includes(s.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={c.staff.includes(s.id)} onChange={() => set({ staff: toggle(c.staff, s.id) })} />{s.name}
                </label>
              ))}
            </div>
          </div>

          {c.kind === 'together' && (<>
            <label>상대 직원</label>
            <div className="staff-pick">
              {sc.staff.map((s) => (
                <label key={s.id} className={`chip ${(c.other ?? []).includes(s.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={(c.other ?? []).includes(s.id)} onChange={() => set({ other: toggle(c.other ?? [], s.id) })} />{s.name}
                </label>
              ))}
            </div>
          </>)}

          <label>기간</label>
          <div className="row wrap">
            <input type="date" value={c.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} /> ~
            <input type="date" value={c.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
            <span className="muted small">비우면 번표 전체 기간</span>
          </div>
          <label>요일</label>
          <div className="row wrap">
            {WEEKDAYS.map((w, i) => (
              <label key={w} className={`chip ${c.weekdays.includes(i) ? 'on' : ''}`}>
                <input type="checkbox" checked={c.weekdays.includes(i)} onChange={() => set({ weekdays: c.weekdays.includes(i) ? c.weekdays.filter((x) => x !== i) : [...c.weekdays, i].sort() })} />{w}
              </label>
            ))}
            <span className="muted small">순서 조건은 마지막 날 기준</span>
          </div>
          <label>설명</label>
          <input className="w-full" value={c.title} onChange={(e) => set({ title: e.target.value })} placeholder="예: 2주차 나이트 불가 (10/18 요청)" />
        </div>
        <p className="muted small">미리보기: <b>[{c.level}]</b> {describe({ ...c, pattern: splitPattern(pat), codes: splitCodes(codes), trigger: splitCodes(trig) }, sc)}</p>
        <div className="row">
          <button className="primary" onClick={submit}>저장</button>
          <button onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  )
}

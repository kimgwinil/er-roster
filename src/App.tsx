import { useEffect, useMemo, useRef, useState } from 'react'
import { type Relaxed, solveRemote } from './api'
import { ConditionsPanel } from './components/ConditionsPanel'
import { RequestsPanel } from './components/RequestsPanel'
import { IssuesPanel } from './components/IssuesPanel'
import { LeavePanel } from './components/LeavePanel'
import { RosterGrid } from './components/RosterGrid'
import { RulesPanel } from './components/RulesPanel'
import { StaffPanel } from './components/StaffPanel'
import { type SuddenInput, SuddenPanel } from './components/SuddenPanel'
import { addDays, label, periodDates, short } from './dates'
import { exportRoster, importConditions, importRosterSheet } from './excel'
import { migrate, newId } from './conditions'
import { ask, NO_SERVER, notify, PREVIEW, saveFile } from './platform'
import { validate } from './rules'
import { nextPeriod, normalize, useScenario } from './store'
import { type Issue, REST, type Scenario } from './types'

const TABS = ['근무표', '확인·위반', '급작 휴가·변동', '조건 규칙', '직원', '신청·지정', '휴가 잔여', '조건 설정'] as const
type Tab = (typeof TABS)[number]

export default function App() {
  const { sc, update, replace, undo, canUndo } = useScenario()
  const [tab, setTab] = useState<Tab>('근무표')
  const [focus, setFocus] = useState<string | null>(null)
  const [baseDate, setBaseDate] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ since: number; what: string } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [limit, setLimit] = useState(60)
  const [result, setResult] = useState<{ ok: boolean; text: string; relaxed: Relaxed[] } | null>(null)
  const [keep, setKeep] = useState(true)
  const [changed, setChanged] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)
  const issues = useMemo(() => validate(sc), [sc])
  const open = (l: string) => issues.filter((i) => i.level === l && i.rule !== '특별조건' && sc.acks[i.id] === undefined).length
  const memoCount = issues.filter((i) => i.rule === '특별조건').length
  const name = (id?: string) => sc.staff.find((s) => s.id === id)?.name ?? ''

  // 미리보기(아티팩트): 알림줄, 처음 열면(또는 새 판이 게시되면) 게시된 번표
  useEffect(() => {
    const on = (e: Event) => setResult({ ok: false, text: (e as CustomEvent<string>).detail, relaxed: [] })
    window.addEventListener('app-notice', on)
    return () => window.removeEventListener('app-notice', on)
  }, [])
  // onlyIfNew: 게시된 번표가 바뀐 경우에만 (처음 열 때·새 판을 게시했을 때) 불러옴
  const loadSample = async (onlyIfNew = false) => {
    try {
      const text = await (await fetch('sample.json')).text()
      let h = 0
      for (let k = 0; k < text.length; k++) h = (h * 31 + text.charCodeAt(k)) | 0
      const ver = `${text.length}-${h}`
      let seen: string | null = null
      try { seen = localStorage.getItem('preview-sample-ver') } catch { /* 저장소 막힘 */ }
      if (onlyIfNew && seen === ver && sc.staff.length) return
      replace(normalize(migrate(JSON.parse(text) as Scenario)))
      try { localStorage.setItem('preview-sample-ver', ver) } catch { /* 저장소 막힘 */ }
      setTab('근무표')
    } catch (e) {
      notify(`게시된 번표를 불러오지 못했습니다: ${String(e)}`)
    }
  }
  // 미리보기: 함께 게시한 병동 최종 엑셀(final.json = {name, base64})이 있으면 내려받기 버튼 표시
  // (아티팩트는 .xlsx를 직접 게시할 수 없어 JSON 데이터로 싣고 downloads 기능으로 저장)
  const [hasFinal, setHasFinal] = useState(false)
  useEffect(() => {
    if (PREVIEW) fetch('final.json', { method: 'HEAD' }).then((r) => setHasFinal(r.ok)).catch(() => setHasFinal(false))
  }, [])
  const downloadFinal = async () => {
    try {
      const res = await fetch('final.json')
      if (!res.ok) throw new Error(String(res.status))
      const f = (await res.json()) as { name: string; base64: string }
      const bin = atob(f.base64)
      const bytes = new Uint8Array(bin.length)
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k)
      await saveFile(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), f.name)
    } catch (e) {
      notify(`최종 엑셀을 내려받지 못했습니다: ${String(e)}`)
    }
  }
  useEffect(() => {
    if (PREVIEW) void loadSample(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [busy])

  const change = (fn: (s: Scenario) => Scenario) => update((s) => normalize(fn(s)))

  const setCell = (staff: string, day: number, code: string | null) =>
    update((s) => {
      const row = [...(s.roster[staff] ?? [])]
      const locks = [...(s.locks[staff] ?? Array(s.days).fill(false))]
      if (code !== null) row[day] = code
      locks[day] = code !== null
      return { ...s, roster: { ...s.roster, [staff]: row }, locks: { ...s.locks, [staff]: locks } }
    })

  /** base: 방금 바꾼 시나리오로 바로 생성할 때. 반환값: 바뀐 칸 수 (실패 시 null) */
  const runSolve = async (fromDate?: string, base: Scenario = sc, what?: string): Promise<number | null> => {
    setBusy({ since: Date.now(), what: what ?? (fromDate ? `${label(fromDate)}부터 다시 생성` : '전체 자동 생성') })
    setResult(null)
    try {
      const r = await solveRemote(base, { fromDate, timeLimit: limit, keepCurrent: keep })
      if (r.ok && r.roster) {
        const diff = new Set<string>()
        for (const [sid, row] of Object.entries(r.roster))
          row.forEach((c, d) => { if ((base.roster[sid]?.[d] ?? '') && base.roster[sid][d] !== c) diff.add(`${sid}|${d}`) })
        update((s) => normalize({ ...s, roster: { ...s.roster, ...r.roster } }))
        setChanged(diff)
        setResult({ ok: true, text: `${r.seconds}초 만에 생성했습니다 (${r.status === 'OPTIMAL' ? '최적' : '시간 내 최선'}). 바뀐 칸 ${diff.size}개 (초록 표시).${r.strict === false ? ' 금지 조건끼리 충돌해 모두 지킬 수 없어, 일부를 최소한으로 완화했습니다.' : ''}`, relaxed: r.relaxed ?? [] })
        return diff.size
      }
      setResult({ ok: false, text: r.message ?? `생성 실패 (${r.status})`, relaxed: [] })
    } catch (e) {
      setResult({ ok: false, text: `서버에 연결하지 못했습니다: ${String(e)}`, relaxed: [] })
    } finally {
      setBusy(null)
    }
    return null
  }

  /** 급작 휴가·변동 적용: 칸을 바꾸고 고정 → (선택) 그날부터 대체 근무 편성 */
  const applySudden = async (f: SuddenInput) => {
    const dates = periodDates(sc.startDate, sc.days)
    const days = dates.map((d, i) => [d, i] as const).filter(([d]) => d >= f.from && d <= (f.kind === '조퇴' ? f.from : f.to))
    if (!days.length) return notify('번표 기간 안의 날짜를 고르세요.')
    const row = [...(sc.roster[f.staff] ?? [])]
    const locks = [...(sc.locks[f.staff] ?? Array(sc.days).fill(false))]
    const before = days.map(([, i]) => row[i] ?? '')
    const fixed = [...sc.fixed]
    const kept: string[] = []
    for (const [d, i] of days) {
      locks[i] = true
      if (f.kind === '조퇴') continue
      // 이미 쉬는 날(주휴·OF·휴가 등)은 그대로 두고, 근무였던 날만 바꿈
      if ((REST as readonly string[]).includes(row[i] ?? '')) { kept.push(`${label(d)} ${row[i]}`); continue }
      row[i] = f.kind
      fixed.push({ staff: f.staff, date: d, allowed: [f.kind], reason: `${f.kind}${f.reason ? `: ${f.reason}` : ''}` })
    }
    const ev = { id: newId(), at: new Date().toISOString(), staff: f.staff, from: days[0][0], to: days[days.length - 1][0], kind: f.kind, reason: f.reason, before }
    const next = normalize({ ...sc, fixed, roster: { ...sc.roster, [f.staff]: row }, locks: { ...sc.locks, [f.staff]: locks }, events: [...(sc.events ?? []), ev] })
    update(() => next)
    setChanged(new Set(days.map(([, i]) => `${f.staff}|${i}`)))
    if (f.kind !== '조퇴' && f.replace) {
      const n = await runSolve(days[0][0], next, `${name(f.staff)} ${f.kind} — 대체 근무 편성`)
      if (n !== null) update((s) => ({ ...s, events: (s.events ?? []).map((e) => (e.id === ev.id ? { ...e, replaced: n } : e)) }))
    } else {
      setResult({ ok: true, text: `${name(f.staff)} ${f.kind} 적용 (${days.length}일).${f.kind === '조퇴' ? ' 근무는 그대로 두고 확인 항목에 표시했습니다.' : ' 빈자리는 [그날부터 다시 생성]으로 채울 수 있습니다.'}`, relaxed: [] })
    }
    if (kept.length) setResult((r) => r && { ...r, text: `${r.text} 이미 쉬는 날은 그대로 둠: ${kept.join(', ')}.` })
  }

  const onFile = async (f: File) => {
    try {
      let next: Scenario
      let msg = ''
      if (f.name.toLowerCase().endsWith('.json')) next = migrate(JSON.parse(await f.text()) as Scenario)
      else {
        const buf = await f.arrayBuffer()
        // 번표 엑셀(근무표 시트)이면 근무를 불러오고, 아니면 병동 조건 엑셀로 읽음
        const roster = await importRosterSheet(buf, sc.staff.length ? sc : null)
        if (roster) {
          next = roster.sc
          msg = roster.matched ? `번표 엑셀에서 ${roster.matched}명의 근무를 불러왔습니다 (조건·신청은 그대로${roster.added ? `, 새 직원 ${roster.added}명 추가` : ''}).`
            : `번표 엑셀에서 ${next.staff.length}명의 근무를 불러왔습니다. 조건·신청오프는 [신청·지정]·[직원]에서 넣거나 시나리오 JSON을 먼저 연 뒤 엑셀을 불러오세요.`
        } else next = await importConditions(buf)
      }
      if (!next.staff || !next.startDate) throw new Error('번표 파일 형식이 아닙니다')
      if (sc.staff.length && !ask(`현재 번표를 '${f.name}' 내용으로 바꿀까요? (되돌리기 가능)`)) return
      replace(normalize({ ...next, locks: next.locks ?? {}, acks: next.acks ?? {}, notes: next.notes ?? [] }))
      setTab('근무표')
      if (msg) setResult({ ok: true, text: msg, relaxed: [] })
    } catch (e) {
      notify(`불러오기 실패: ${String(e)}`)
    }
  }

  const focusIssue = (i: Issue) => {
    const cell = i.cells[0]
    setTab('근무표')
    if (cell) {
      const k = `${cell[0]}|${cell[1]}`
      setFocus(k)
      setTimeout(() => document.getElementById(`cell-${k}`)?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }), 50)
    }
  }

  const lockedCount = Object.values(sc.locks).reduce((a, r) => a + r.filter(Boolean).length, 0)
  const condTitle = (id?: string) => { const c = sc.conditions?.find((x) => x.id === id); return c ? ` '${c.title || c.id}'` : '' }
  const relaxText = (r: Relaxed) =>
    `${r.type}${condTitle(r.cond)}${r.date ? ` ${short(r.date)}` : ''}${r.shift ? ` ${r.shift}` : ''}${r.staff ? ` ${name(r.staff)}` : ''}`

  return (
    <div className="app">
      <header>
        <div>
          <h1>{sc.title || '응급실 번표'}</h1>
          <div className="muted small">
            {sc.startDate} ~ {addDays(sc.startDate, sc.days - 1)} · 직원 {sc.staff.length}명 · 하루{' '}
            {Object.entries(sc.demand).map(([k, v]) => `${k}${v}`).join('·')} · 고정한 칸 {lockedCount}개
          </div>
        </div>
        <div className="status">
          <span className="badge lv-위반">위반 {open('위반')}</span>
          <span className="badge lv-확인">확인 {open('확인')}</span>
          <span className="badge lv-권장">권장 {open('권장')}</span>
          {memoCount > 0 && <span className="badge memo" title="근무 특별조건 (조건 규칙 화면)">특별조건 {memoCount}</span>}
        </div>
      </header>

      <div className="toolbar">
        <input ref={fileRef} type="file" accept=".xlsx,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
        <button onClick={() => fileRef.current?.click()} title="번표 엑셀(근무표 시트) · 병동 조건 엑셀(번표명단과 조건값) · 저장한 번표 JSON">불러오기</button>
        <button onClick={() => saveFile(new Blob([JSON.stringify(sc, null, 1)], { type: 'application/json' }), `번표_${sc.startDate}.json`)}>저장(JSON)</button>
        <button onClick={async () => saveFile(await exportRoster(sc, issues), `응급실_번표_${sc.startDate}.xlsx`)}>엑셀 내보내기</button>
        <span className="sep" />
        <label className="small">계산 시간
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[30, 60, 120, 240].map((s) => <option key={s} value={s}>{s}초</option>)}
          </select>
        </label>
        <button className="primary" disabled={NO_SERVER || !!busy || !sc.staff.length} onClick={() => runSolve()}
          title={NO_SERVER ? '이 주소에서는 자동 생성(서버 계산)을 쓸 수 없습니다' : ''}>자동 생성</button>
        <button className="primary" disabled={NO_SERVER || !!busy || !baseDate} onClick={() => baseDate && runSolve(baseDate)}
          title="근무표 날짜 머리글을 눌러 기준일을 고르세요. 그 이전 근무는 그대로 두고 이후만 다시 짭니다.">
          {baseDate ? `${label(baseDate)}부터 다시 생성` : '날짜 선택 후 부분 재생성'}
        </button>
        <span className="sep" />
        <label className="small" title="다시 생성할 때 지금 번표에서 바뀌는 칸을 최소로"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> 기존 근무 최대 유지</label>
        <span className="sep" />
        <button disabled={!canUndo} onClick={undo}>되돌리기</button>
        <button onClick={() => { if (ask('직접 수정해 고정한 칸을 모두 해제할까요?')) update((s) => ({ ...s, locks: {} })) }}>고정 모두 해제</button>
        <button onClick={() => { if (ask('이 번표의 마지막 근무·잔여휴가를 이어받아 다음 번표를 시작할까요? (현재 번표는 먼저 저장해 두세요)')) replace(nextPeriod(sc)) }}>다음 번표 시작</button>
      </div>

      {PREVIEW && (
        <div className="banner preview">
          미리보기 링크입니다. 근무표 보기·직접 수정, 위반·확인 표시, 급작 휴가 입력, 조건 규칙, 엑셀 불러오기·내보내기는 여기서 됩니다.
          자동 생성(대체 근무 편성 포함)은 Vercel에 배포한 앱에서 쓸 수 있습니다. 입력한 내용은 이 브라우저에만 저장됩니다.
          {hasFinal && <button className="small primary" onClick={() => void downloadFinal()}>최종 번표 엑셀 내려받기</button>}
          <button className="small" onClick={() => { if (ask('게시된 번표로 되돌릴까요? (되돌리기 가능)')) void loadSample() }}>게시된 번표 다시 열기</button>
        </div>
      )}
      {NO_SERVER && !PREVIEW && (
        <div className="banner preview">
          GitHub 배포 주소입니다. 번표 보기·직접 수정, 위반·확인 표시, 급작 휴가 입력, 조건 규칙, 엑셀·JSON 불러오기·내보내기를 쓸 수 있습니다.
          자동 생성(서버 계산)은 이 주소에서 쓸 수 없습니다. 직원 데이터는 [불러오기]로 연 브라우저에만 저장됩니다.
        </div>
      )}
      {busy && (
        <div className="banner busy">
          {busy.what} 중… {Math.floor((now - busy.since) / 1000)}초 / 최대 {limit}초 (서버에는 이름 없이 번호만 보냅니다)
        </div>
      )}
      {result && (
        <div className={`banner ${result.ok ? 'ok' : 'err'}`}>
          {result.text}
          {result.relaxed.length > 0 && <> 조건끼리 충돌해 완화한 항목: {result.relaxed.map(relaxText).join(' · ')}</>}
          {changed.size > 0 && <button className="small" onClick={() => setChanged(new Set())}>바뀐 칸 표시 지우기</button>}
          <button className="x" onClick={() => setResult(null)}>×</button>
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}{t === '확인·위반' && open('위반') + open('확인') > 0 ? ` (${open('위반') + open('확인')})` : ''}
          </button>
        ))}
      </nav>

      {!sc.staff.length && (
        <div className="empty">
          <p>명단이 없습니다. [불러오기]로 번표 엑셀, 병동 조건 엑셀(번표명단과 조건값 · 번표신청달력) 또는 저장한 번표 JSON을 여세요.</p>
          <p className="muted small">입력한 내용은 이 브라우저에만 저장됩니다. 다른 컴퓨터에서 쓰려면 [저장(JSON)] 파일을 옮기세요.</p>
        </div>
      )}

      {tab === '근무표' && sc.staff.length > 0 && (
        <>
          <div className="legend small">
            {['D', 'E', 'N', '소아', '미드', '주휴', 'OF', '휴가', '공가', '교육', '병가', '경조', '생휴', '수휴'].map((c) => <span key={c} className={`cell code-${c}`}>{c}</span>)}
            <span className="muted">· 칸을 눌러 직접 수정 · <span className="lock-demo" /> 고정 · <span className="cell req-ok">노랑</span> 신청오프 반영 · <span className="cell req-miss">형광 분홍</span> 신청오프 미반영 · <span className="cell viol-fill">형광 연두</span> 조건 위배 · <span className="fix-demo" /> 지정 · 주황 테두리 확인 · 점선 권장 · 날짜를 누르면 부분 재생성 기준일</span>
          </div>
          <RosterGrid sc={sc} issues={issues} focus={focus} baseDate={baseDate} onBaseDate={setBaseDate} onSet={setCell} changed={changed} />
        </>
      )}
      {tab === '확인·위반' && <IssuesPanel sc={sc} issues={issues} onFocus={focusIssue}
        onAck={(id, memo) => update((s) => { const acks = { ...s.acks }; if (memo === null) delete acks[id]; else acks[id] = memo; return { ...s, acks } })} />}
      {tab === '급작 휴가·변동' && <SuddenPanel sc={sc} busy={!!busy} canSolve={!NO_SERVER} onApply={(f) => { setTab('근무표'); void applySudden(f) }}
        onRemoveEvent={(id) => update((s) => ({ ...s, events: (s.events ?? []).filter((e) => e.id !== id) }))} />}
      {tab === '조건 규칙' && <ConditionsPanel sc={sc} onChange={change} />}
      {tab === '직원' && <StaffPanel sc={sc} onChange={change} />}
      {tab === '신청·지정' && <RequestsPanel sc={sc} onChange={change} />}
      {tab === '휴가 잔여' && <LeavePanel sc={sc} onChange={change} />}
      {tab === '조건 설정' && <RulesPanel sc={sc} onChange={change} />}

      <footer className="muted small">
        데이터는 이 브라우저에만 저장됩니다. 자동 생성 때만 이름을 뺀 번호·조건을 서버로 보내며, 서버는 저장하지 않습니다.
      </footer>
    </div>
  )
}

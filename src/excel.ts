import type ExcelJS from 'exceljs'

const loadExcel = async () => (await import('exceljs')).default
import { addDays, diffDays, fmt, label, periodDates, weekday } from './dates'
import { ledger, weekCount } from './leave'
import { defaultConditions, describe } from './conditions'
import { dailyCounts, requestState } from './rules'
import { codeName, type Issue, type Scenario, type Staff, WEEKDAYS } from './types'

const ALIAS: Record<string, string> = { 주: '주휴', 소중: '소아', OFF: 'OF', 오프: 'OF' }

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return fmt(v)
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('')
    if ('text' in v) return String(v.text)
    if ('result' in v) return String(v.result ?? '')
  }
  return String(v)
}

/** "#1 가나다 ~#19 라마바 / #21~#22" → [[1,19],[21,22]] */
function ranges(text: string): [number, number][] {
  const out: [number, number][] = []
  const re = /#\s*(\d+)[^#]*?~\s*#?\s*(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push([Number(m[1]), Number(m[2])])
  return out
}
const inRanges = (no: number, rs: [number, number][]) => rs.some(([a, b]) => no >= a && no <= b)

export function emptyStaff(no: number, name: string): Staff {
  return {
    id: `s${String(no).padStart(2, '0')}_${Math.random().toString(36).slice(2, 6)}`,
    no, name,
    roles: { charge: false, newbie: false, pedsCharge: false, pedsActing: false },
    juhu: 0, leave: 0, prev: [], allowed: null, noNightBeforeOff: false, fixedWeekdays: [],
    startDate: null, endDate: null, minLeave: 0, leaveWindows: [], ofExempt: [], noNightLastDays: 0,
    weekLeave: [], memo: '',
  }
}

export function defaultScenario(): Scenario {
  return {
    version: 2, title: '응급실 간호사 번표', startDate: '2026-11-08', days: 28, leaveCapUntil: '2026-11-30',
    demand: { D: 7, E: 7, N: 6, 소아: 2 },
    shiftTimes: { D: '06:00-14:00', E: '14:00-22:00', N: '22:00-06:00' },
    rules: {
      chargeMin: 3, chargeMax: 4, newMax: 2, maxWork: 5, maxNight: 3, nightBlockRest: 2,
      forbidden: [],
    },
    staff: [], requests: [], fixed: [], roster: {}, locks: {}, acks: {}, notes: [],
    conditions: defaultConditions(),
  }
}

/** 번표 엑셀의 근무 표기 → 앱 코드 (소중·휴·중·생11·수10·경·D1 등 병동 표기 포함) */
export function rosterCode(raw: string): string {
  const t = raw.replace(/\s+/g, '')
  if (!t) return ''
  const map: Record<string, string> = { 소중: '소아', 휴: '휴가', 중: '미드', 경: '경조', 주: '주휴', OFF: 'OF', 오프: 'OF', 생휴: '생휴', 수휴: '수휴' }
  if (map[t]) return map[t]
  if (/^생\d*$/.test(t)) return '생휴' // 생리휴가 (생11 = 11월분)
  if (/^수\d*$/.test(t)) return '수휴' // 휴무지만 OF 개수에는 넣지 않음 (수10·수11)
  if (/^D\d+$/.test(t)) return '교육' // D1 = 교육일
  return t
}

/**
 * 번표 엑셀(이 앱·생성 프로그램이 만든 '근무표' 시트 형식, 손으로 고친 것 포함) 불러오기.
 * base(지금 열린 번표)가 있고 이름이 겹치면 조건·신청은 그대로 두고 근무·직전 근무만 바꿈.
 * 해당 시트가 없으면 null.
 */
export async function importRosterSheet(buf: ArrayBuffer, base: Scenario | null): Promise<{ sc: Scenario; matched: number; added: number } | null> {
  const Excel = await loadExcel()
  const wb = new Excel.Workbook()
  await wb.xlsx.load(buf)
  for (const ws of wb.worksheets) {
    let h = 0
    for (let r = 1; r <= Math.min(ws.rowCount, 15) && !h; r++)
      if (cellText(ws.getCell(r, 1).value).trim() === '번호' && cellText(ws.getCell(r, 2).value).trim() === '이름') h = r
    if (!h) continue
    // 날짜 머리글 줄 (m/d 가 가장 많은 줄)
    const dateRe = /^(\d{1,2})\/(\d{1,2})/
    let dr = h, best = 0
    for (let r = h; r <= h + 2; r++) {
      let n = 0
      for (let c = 5; c <= ws.columnCount; c++) if (dateRe.test(cellText(ws.getCell(r, c).value).trim())) n++
      if (n > best) { best = n; dr = r }
    }
    if (best < 7) continue
    const title = [1, 2].map((r) => cellText(ws.getCell(r, 1).value)).join(' ')
    let year = base ? Number(base.startDate.slice(0, 4)) : Number(title.match(/(20\d\d)/)?.[1] ?? new Date().getFullYear())
    const cols: { c: number; date: string; prev: boolean }[] = []
    let prevMonth = 0
    let mainFrom = 0 // '1주차' 같은 머리글이 시작되는 열 — 그 앞은 직전 근무
    for (let c = 5; c <= ws.columnCount && !mainFrom; c++) if (/주차|주\s*\(/.test(cellText(ws.getCell(h, c).value))) mainFrom = c
    for (let c = 5; c <= ws.columnCount; c++) {
      const m = cellText(ws.getCell(dr, c).value).trim().match(dateRe)
      if (!m) continue
      const mo = Number(m[1])
      if (prevMonth && mo < prevMonth) year++
      prevMonth = mo
      const date = `${year}-${String(mo).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`
      cols.push({ c, date, prev: mainFrom ? c < mainFrom : base ? date < base.startDate : false })
    }
    const main = cols.filter((x) => !x.prev)
    if (!main.length) continue
    // 직원 줄: 번호가 숫자인 줄
    const rows: { no: number; name: string; group: string; juhu: string; prev: string[]; codes: Map<string, string> }[] = []
    for (let r = dr + 1; r <= ws.rowCount; r++) {
      const no = Number(cellText(ws.getCell(r, 1).value).trim())
      const name = cellText(ws.getCell(r, 2).value).trim()
      if (!Number.isFinite(no) || !name || cellText(ws.getCell(r, 1).value).trim() === '') continue
      const codes = new Map(main.map((x) => [x.date, rosterCode(cellText(ws.getCell(r, x.c).value))]))
      rows.push({ no, name, group: cellText(ws.getCell(r, 3).value), juhu: cellText(ws.getCell(r, 4).value).trim(),
        prev: cols.filter((x) => x.prev).map((x) => rosterCode(cellText(ws.getCell(r, x.c).value))).filter(Boolean), codes })
    }
    if (!rows.length) continue
    const byName = new Map((base?.staff ?? []).map((s) => [s.name, s]))
    const matched = rows.filter((x) => byName.has(x.name)).length
    const merge = !!base && matched >= Math.ceil(rows.length / 2)
    let sc: Scenario
    if (merge) {
      sc = { ...base!, roster: { ...base!.roster }, staff: [...base!.staff] }
    } else {
      sc = defaultScenario()
      sc.startDate = main[0].date
      sc.days = main.length
      const last = main.filter((x) => x.date.slice(5, 7) === main[0].date.slice(5, 7)).pop()!
      sc.leaveCapUntil = last.date
      sc.title = title.split('—')[0].trim() || sc.title
    }
    const dates = periodDates(sc.startDate, sc.days)
    let added = 0
    for (const x of rows) {
      let st = merge ? byName.get(x.name) : undefined
      if (!st) {
        st = emptyStaff(x.no, x.name)
        const tags = x.group.split(/[\/\s,·]+/)
        st.roles = { charge: tags.includes('차지'), newbie: tags.includes('신규'), pedsCharge: tags.includes('소아차지'), pedsActing: tags.includes('소아액팅') }
        const wd = WEEKDAYS.indexOf(x.juhu.slice(0, 1))
        if (wd >= 0) st.juhu = wd
        sc.staff.push(st)
        if (merge) added++
      }
      if (x.prev.length) {
        const i = sc.staff.findIndex((s) => s.id === st!.id)
        sc.staff[i] = { ...sc.staff[i], prev: x.prev }
      }
      sc.roster[st.id] = dates.map((d) => x.codes.get(d) ?? '')
    }
    return { sc, matched: merge ? matched : 0, added }
  }
  return null
}

/** 병동 '번표명단과 조건값' 엑셀 불러오기 (명단·직전 근무·주휴·잔여휴가·신청오프·기본 조건) */
export async function importConditions(buf: ArrayBuffer): Promise<Scenario> {
  const Excel = await loadExcel()
  const wb = new Excel.Workbook()
  await wb.xlsx.load(buf)
  const ws = wb.worksheets.find((w) => w.name.includes('명단')) ?? wb.worksheets[0]
  const cal = wb.worksheets.find((w) => w.name.includes('달력'))
  const sc = defaultScenario()

  const lines: string[] = []
  ws.eachRow((row) => {
    const t = (row.values as ExcelJS.CellValue[]).slice(1).map(cellText).filter(Boolean).join(' ')
    if (t && !/^\d/.test(cellText(row.getCell(1).value))) lines.push(t)
  })
  sc.conditionText = lines.filter((l) => !l.startsWith('[직전'))
  const find = (re: RegExp) => lines.find((l) => re.test(l)) ?? ''

  // 기간
  const calDates: string[] = []
  cal?.getRow(1).eachCell((c) => { const t = cellText(c.value); if (/^\d{4}-\d{2}-\d{2}/.test(t)) calDates.push(t.slice(0, 10)) })
  if (calDates.length) {
    sc.startDate = calDates[0]
    sc.days = diffDays(calDates[0], calDates[calDates.length - 1]) + 1
  }
  const start = sc.startDate
  const y = Number(start.slice(0, 4))
  const m0 = Number(start.slice(5, 7))
  sc.leaveCapUntil = fmt(new Date(Date.UTC(y, m0, 0)))
  sc.title = `응급실 간호사 번표 ${start} ~ ${addDays(start, sc.days - 1)}`

  // 인원·구성
  const dm = find(/하루근무인원/).match(/D\s*(\d+)\s*명.*?E\s*(\d+)\s*명.*?N\s*(\d+)\s*명(?:.*?소아\s*(\d+)\s*명)?/)
  if (dm) sc.demand = { D: +dm[1], E: +dm[2], N: +dm[3], 소아: dm[4] ? +dm[4] : 0 }
  const cm = find(/\[차지\]\s*가\s*반드시/).match(/(\d+)\s*~\s*(\d+)\s*명/)
  if (cm) { sc.rules.chargeMin = +cm[1]; sc.rules.chargeMax = +cm[2] }
  const nm = find(/\[신규\]\s*가\s*\d+\s*명\s*이하/).match(/(\d+)\s*명\s*이하/)
  if (nm) sc.rules.newMax = +nm[1]
  const mw = find(/연속\s*\d+\s*일이\s*최대/).match(/연속\s*(\d+)/)
  if (mw) sc.rules.maxWork = +mw[1]
  const chargeR = ranges(find(/^\[차지\]\s*는/))
  const newR = ranges(find(/^\[신규\]\s*는/))
  const pcR = ranges(find(/^\[소아차지\]\s*는/))
  const paR = ranges(find(/^\[소아액팅\]\s*은/))

  // 명단
  const header = ws.getRow(1)
  let colPrev = 3, colJuhu = 4, colLeave = 5
  header.eachCell((c, i) => {
    const t = cellText(c.value)
    if (t.includes('직전')) colPrev = i
    if (t.includes('주휴')) colJuhu = i
    if (t.includes('잔여')) colLeave = i
  })
  ws.eachRow((row, r) => {
    if (r === 1) return
    const no = Number(cellText(row.getCell(1).value))
    const name = cellText(row.getCell(2).value).trim()
    if (!no || !name) return
    const s = emptyStaff(no, name)
    s.id = `s${String(no).padStart(2, '0')}`
    s.prev = cellText(row.getCell(colPrev).value).split('/').map((t) => t.trim()).filter(Boolean).map((t) => ALIAS[t] ?? t)
    const jd = cellText(row.getCell(colJuhu).value).trim()[0]
    s.juhu = Math.max(0, WEEKDAYS.indexOf(jd))
    s.leave = Number(cellText(row.getCell(colLeave).value)) || 0
    s.roles = { charge: inRanges(no, chargeR), newbie: inRanges(no, newR), pedsCharge: inRanges(no, pcR), pedsActing: inRanges(no, paR) }
    sc.staff.push(s)
  })

  // 신청오프 달력
  if (cal) {
    const byName = new Map(sc.staff.map((s) => [s.name, s]))
    const cols: { col: number; date: string }[] = []
    cal.getRow(1).eachCell((c, i) => { const t = cellText(c.value); if (/^\d{4}-/.test(t)) cols.push({ col: i, date: t.slice(0, 10) }) })
    cal.eachRow((row, r) => {
      if (r === 1) return
      for (const { col, date } of cols) {
        const n = cellText(row.getCell(col).value).trim()
        const s = byName.get(n)
        if (s) sc.requests.push({ staff: s.id, date, alt: null, onlyLeave: false })
        else if (n) sc.notes.push(`신청달력의 '${n}'(${date})이 명단에 없어 제외됨`)
      }
    })
  }
  sc.notes.push('엑셀에서 명단·직전 근무·주휴·잔여휴가·신청오프·기본 인원 조건을 불러왔습니다. 개인별 특수 조건(고정 일정·장기휴가·공가 등)은 [직원]·[신청·지정] 화면에서 입력하세요.')
  return sc
}

const COLOR: Record<string, [string, string]> = {
  D: ['FFF2CC', '000000'], E: ['DDEBF7', '000000'], N: ['1F3864', 'FFFFFF'], 소아: ['E2EFDA', '375623'],
  미드: ['FCE4D6', '833C0B'], 주휴: ['D9D9D9', '404040'], OF: ['EDEDED', '7F7F7F'], 휴가: ['F8CBAD', 'C00000'],
  공가: ['E4DFEC', '5B2C6F'], 교육: ['BDD7EE', '1F3864'], 병가: ['FDE2E4', '9F1239'], 경조: ['E7E5E4', '44403C'], 생휴: ['FBE4F0', '9D174D'], 수휴: ['E0F2FE', '075985'], '-': ['FFFFFF', 'BFBFBF'],
}

function roleText(s: Staff) {
  const r = []
  if (s.roles.charge) r.push('차지')
  if (s.roles.newbie) r.push('신규')
  if (s.roles.pedsCharge) r.push('소아차지')
  if (s.roles.pedsActing) r.push('소아액팅')
  return r.join('/')
}

/** 번표 엑셀 내보내기 (색·집계·확인사항·휴가 장부) */
export async function exportRoster(sc: Scenario, issues: Issue[]): Promise<Blob> {
  const Excel = await loadExcel()
  const wb = new Excel.Workbook()
  const dates = periodDates(sc.startDate, sc.days)
  const ws = wb.addWorksheet('근무표', { views: [{ state: 'frozen', xSplit: 4, ySplit: 3 }] })
  const font = { name: '맑은 고딕', size: 9 }
  const thin = { style: 'thin' as const, color: { argb: 'FFBFBFBF' } }
  const border = { top: thin, left: thin, bottom: thin, right: thin }
  ws.addRow([sc.title])
  ws.getRow(1).font = { ...font, size: 14, bold: true }
  const times = Object.entries(sc.shiftTimes).map(([k, v]) => `${k} ${v}`).join('   ')
  ws.addRow([`${times}   |   하루 ${Object.entries(sc.demand).map(([k, v]) => `${codeName(k)}${v}`).join('·')}   |   ${fmt(new Date())} 내보냄`])
  ws.getRow(2).font = { ...font, color: { argb: 'FF595959' } }
  ws.getCell('A2').value += '   |   노랑 = 신청오프 반영 · 형광 분홍 = 신청오프 미반영 · 형광 연두 = 근무 조건 위배'
  const reqs = new Map(sc.requests.map((q) => [`${q.staff}|${q.date}`, q]))
  const sumCols = ['D', 'E', 'N', '소아', '근무', '주휴', 'OF', '휴가', '공가', '교육', '병가', '경조', '생휴', '수휴']
  ws.addRow(['번호', '이름', '구분', '주휴', ...dates.map(label), ...sumCols.map(codeName)])
  const flagged = new Map<string, string[]>()
  for (const i of issues) for (const [sid, d] of i.cells) {
    const k = `${sid}|${d}`
    flagged.set(k, [...(flagged.get(k) ?? []), `[${i.level}] ${i.msg}`])
  }
  for (const s of sc.staff) {
    const row = sc.roster[s.id] ?? []
    const cnt = (c: string) => row.filter((x) => x === c).length
    const work = ['D', 'E', 'N', '소아', '미드'].reduce((a, c) => a + cnt(c), 0)
    const r = ws.addRow([s.no, s.name, roleText(s), WEEKDAYS[s.juhu], ...dates.map((_, d) => codeName(row[d] ?? '')),
      cnt('D'), cnt('E'), cnt('N'), cnt('소아'), work, cnt('주휴'), cnt('OF'), cnt('휴가'), cnt('공가'), cnt('교육'), cnt('병가'), cnt('경조'), cnt('생휴'), cnt('수휴')])
    dates.forEach((_, d) => {
      const cell = r.getCell(5 + d)
      const [bg, fg] = COLOR[row[d]] ?? ['FFFFFF', '000000']
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${bg}` } }
      cell.font = { ...font, bold: true, color: { argb: `FF${fg}` } }
      const q = reqs.get(`${s.id}|${dates[d]}`)
      const rs = q ? requestState(q, row[d]) : null
      if (rs) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rs === 'ok' ? 'FFFFFF00' : 'FFFF00FF' } }
        cell.font = { ...font, bold: true, color: { argb: 'FF000000' } }
      }
      const f = flagged.get(`${s.id}|${d}`)
      if (f?.some((t) => t.startsWith('[위반]')) && rs !== 'miss') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } }
        cell.font = { ...font, bold: true, color: { argb: 'FF000000' } }
      }
      if (f) {
        cell.border = { top: { style: 'medium', color: { argb: 'FFFF0000' } }, left: { style: 'medium', color: { argb: 'FFFF0000' } },
          bottom: { style: 'medium', color: { argb: 'FFFF0000' } }, right: { style: 'medium', color: { argb: 'FFFF0000' } } }
        cell.note = f.join('\n')
      }
    })
  }
  ws.addRow([])
  const dc = dailyCounts(sc)
  const sumRows: [string, string][] = [['D 인원', 'D'], ['E 인원', 'E'], ['N 인원', 'N'], ['소중 인원', '소아'], ['D 차지', 'Dc'], ['E 차지', 'Ec'],
    ['N 차지', 'Nc'], ['D 신규', 'Dn'], ['E 신규', 'En'], ['N 신규', 'Nn'], ['소아차지', 'pc'], ['소아액팅', 'pa']]
  for (const [t, k] of sumRows) ws.addRow(['', t, '', '', ...dc.map((r) => r[k])]).font = font
  ws.eachRow((row, i) => {
    if (i < 3) return
    row.eachCell((c) => {
      c.alignment = { horizontal: 'center', vertical: 'middle' }
      if (!c.border?.top || c.border.top.style !== 'medium') c.border = border
      if (!c.font?.bold || i === 3) c.font = { ...font, bold: i === 3 || c.font?.bold }
    })
  })
  dates.forEach((dt, d) => {
    const c = ws.getRow(3).getCell(5 + d)
    const we = weekday(dt) === 0 || weekday(dt) === 6
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: we ? 'FFFCE4D6' : 'FFDDEBF7' } }
  })
  ws.getColumn(1).width = 5
  ws.getColumn(2).width = 8
  ws.getColumn(3).width = 12
  ws.getColumn(4).width = 5
  for (let d = 0; d < sc.days; d++) ws.getColumn(5 + d).width = 6.5
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 }

  const is = wb.addWorksheet('확인·위반 사항')
  is.addRow(['구분', '항목', '내용', '확인 메모'])
  for (const i of issues) is.addRow([i.level, i.rule, i.msg, sc.acks[i.id] ?? ''])
  is.getRow(1).font = { ...font, bold: true }
  is.getColumn(1).width = 8
  is.getColumn(2).width = 18
  is.getColumn(3).width = 80
  is.getColumn(4).width = 40

  const cs = wb.addWorksheet('조건 규칙')
  cs.addRow(['사용', '구분', '중요도', '종류', '조건', '설명·특별조건'])
  const KIND: Record<string, string> = { sequence: '근무 순서', assign: '근무 제한·지정', conditional: '조건부 제한', count: '횟수', together: '같은 근무', memo: '특별조건' }
  for (const c of sc.conditions ?? [])
    cs.addRow([c.on ? '사용' : '끔', c.kind === 'memo' ? '참고' : c.level, c.level === '지향' ? c.weight : '', KIND[c.kind], describe(c, sc), c.title || c.text])
  cs.getRow(1).font = { ...font, bold: true }
  cs.getColumn(5).width = 60
  cs.getColumn(6).width = 50

  const ev = wb.addWorksheet('변동 이력')
  ev.addRow(['입력 시각', '직원', '종류', '시작', '종료', '사유', '이전 근무', '대체 편성(바뀐 칸)'])
  for (const e of [...(sc.events ?? [])].sort((a, b) => a.at.localeCompare(b.at)))
    ev.addRow([e.at.replace('T', ' ').slice(0, 16), sc.staff.find((s) => s.id === e.staff)?.name ?? e.staff, e.kind, e.from, e.to, e.reason, e.before.join(' '), e.replaced ?? ''])
  ev.getRow(1).font = { ...font, bold: true }
  ev.getColumn(6).width = 30
  ev.getColumn(7).width = 30

  const lv = wb.addWorksheet('휴가 잔여(주별)')
  const W = weekCount(sc)
  lv.addRow(['이름', ...Array.from({ length: W }, (_, w) => [`${w + 1}주 시작`, '사용', '종료']).flat(), '이후 사용'])
  for (const s of sc.staff) {
    const lg = ledger(sc, s)
    lv.addRow([s.name, ...lg.start.flatMap((st, w) => [st, lg.used[w], lg.end[w]]), lg.after.reduce((a, b) => a + b, 0)])
  }
  lv.getRow(1).font = { ...font, bold: true }

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

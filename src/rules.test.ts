import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validate } from './rules'
import type { Scenario } from './types'

// 실명이 든 시나리오는 저장소 밖(로컬)에 있으므로 환경변수로 경로를 받는다
const path = process.env.SCENARIO_JSON ?? ''

describe.skipIf(!path || !existsSync(path))('11월 검증 번표', () => {
  const sc = JSON.parse(readFileSync(path, 'utf-8')) as Scenario
  const issues = validate(sc)
  const v = issues.filter((i) => i.level === '위반')
  // 저장소에 실명을 남기지 않도록 이름을 번호로 바꿔 비교
  const anon = (msg: string) => sc.staff.reduce((m, s) => m.replaceAll(s.name, `#${s.no}`), msg)

  it('위반은 독립 검증기와 같은 항목만 나온다', () => {
    const got = v.map((i) => `${i.rule}: ${anon(i.msg)}`).sort()
    expect(got).toEqual([
      '신청오프: #27 11/8(일) 신청오프인데 N',
      '신청오프: #6 11/8(일) 신청오프인데 E',
      '차지 초과: 11/16(월) E 차지 5명 (3~4명)',
      '차지 초과: 11/9(월) D 차지 5명 (3~4명)',
    ])
  })

  it('특별조건 메모는 확인 항목으로 표시된다', () => {
    expect(issues.filter((i) => i.rule === '특별조건').length).toBe(sc.conditions!.filter((c) => c.kind === 'memo').length)
  })

  it('확인 항목에 지난 번표 근무로 인한 신청오프 전날 N 이 있다', () => {
    expect(issues.some((i) => i.rule === '신청오프 전날 N' && anon(i.msg).includes('#28 '))).toBe(true)
  })
})

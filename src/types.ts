export const WORK = ['D', 'E', 'N', '소아', '미드'] as const
export const REST = ['주휴', 'OF', '휴가', '공가', '교육', '병가', '경조', '생휴'] as const
/** 그날을 지정했을 때만 쓰는 휴무 코드 */
export const DESIGNATED = ['공가', '교육', '병가', '경조', '생휴'] as const
export const NONE = '-'
export const CODES = [...WORK, ...REST, NONE] as const
export const SHIFTS = ['D', 'E', 'N', '소아'] as const
export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

export type Code = (typeof CODES)[number]
export type Shift = (typeof SHIFTS)[number]

export interface Roles {
  charge: boolean
  newbie: boolean
  pedsCharge: boolean
  pedsActing: boolean
  /** 소아차지 대체: 신청오프를 반려해야 하는 날에 한해 소아차지 근무 허용 */
  pedsBackup?: boolean
}

export interface DateRange {
  from: string
  to: string
}

export interface Staff {
  id: string
  no: number
  name: string
  roles: Roles
  /** 주휴 요일 0=일 ... 6=토 */
  juhu: number
  /** 번표 시작 시점 잔여 휴가 */
  leave: number
  /** 직전 근무 (오래된 날 → 시작 전날) */
  prev: string[]
  /** 가능한 근무 (null = 제한 없음) */
  allowed: string[] | null
  noNightBeforeOff: boolean
  fixedWeekdays: { weekday: number; code: string }[]
  startDate: string | null
  endDate: string | null
  minLeave: number
  leaveWindows: (DateRange & { min: number })[]
  ofExempt: DateRange[]
  noNightLastDays: number
  /** 소아 근무 최대 횟수 (null = 제한 없음) */
  maxPeds?: number | null
  /** 주별 시작 잔여휴가 (전주 대비 적용으로 채움, null=자동) */
  weekLeave: (number | null)[]
  memo: string
}

export interface LeaveRequest {
  staff: string
  date: string
  /** 근무로 바꿀 수 있는 경우 그 근무 */
  alt: string | null
  /** 휴가로만 처리 (주휴·OF 불가) */
  onlyLeave: boolean
  /** low = 못 지킬 때 먼저 바꾸는 후순위 신청 */
  /** first: 1순위 반려 (예: 누적 신청 22회 이상), low: 후순위, normal: 일반 */
  priority?: 'first' | 'low' | 'normal'
  /** 신청 번호(달력의 OFF 옆 괄호 숫자). 클수록 먼저 반려 */
  rank?: number | null
}

/** 금지·지향 조건과 근무 특별조건 */
export interface Condition {
  id: string
  /** 꺼 두면 검사·생성에 쓰지 않음 */
  on: boolean
  /** 금지 = 반드시 지킴, 지향 = 가능하면 지킴 */
  level: '금지' | '지향'
  /** 지향 중요도 1~3 */
  weight: number
  /** sequence 근무 순서 · assign 근무 제한/지정 · conditional 조건부 제한 · count 횟수 · together 같은 근무 · memo 특별조건(자유 입력) */
  kind: 'sequence' | 'assign' | 'conditional' | 'count' | 'together' | 'memo'
  /** 대상 직원 id (비우면 전체) */
  staff: string[]
  /** 대상 역할 (선택) */
  role: keyof Roles | null
  from: string | null
  to: string | null
  /** 0=일 ... 6=토 (비우면 모든 요일) */
  weekdays: number[]
  /** sequence: ['N', '휴무', 'D|미드'] — 코드, 근무, 휴무, *, A|B, !A */
  pattern?: string[]
  /** assign·count·together·conditional(대상) 의 근무 코드 */
  codes?: string[]
  /** conditional: 기준 근무 (이 근무인 날이면) */
  trigger?: string[]
  /** conditional: 기준일로부터 며칠 뒤(+)·전(-) */
  offset?: number
  /** assign: not(안 됨) | only(만) · together: apart(따로) | together(함께) */
  mode?: string
  min?: number | null
  max?: number | null
  /** together 상대 직원 id */
  other?: string[]
  title: string
  /** 근무 특별조건 내용 (자유 입력) */
  text: string
}

/** 급작 휴가·변동 기록 */
export interface ChangeEvent {
  id: string
  /** 입력 시각 (ISO) */
  at: string
  staff: string
  from: string
  to: string
  /** 병가 · 경조 · 조퇴 · 휴가(연차) · 공가 · 근무변경 */
  kind: string
  reason: string
  /** 입력 전 근무 (from~to) */
  before: string[]
  /** 대체 근무 편성으로 바뀐 칸 수 */
  replaced?: number
}

export interface Fixed {
  staff: string
  date: string
  allowed: string[]
  reason: string
  /** 주 OF 1개와 별도로 인정하는 추가 OF */
  extraOff?: boolean
}

export interface Scenario {
  version: number
  title: string
  startDate: string
  days: number
  leaveCapUntil: string
  demand: Record<Shift, number>
  shiftTimes: Record<string, string>
  rules: {
    chargeMin: number
    chargeMax: number
    newMax: number
    maxWork: number
    maxNight: number
    nightBlockRest: number
    /** 차지 인원을 신청오프보다 우선 (켜면 차지 범위를 지키려고 신청오프를 근무로 바꿀 수 있음) */
    chargeFirst?: boolean
    /** 신청 번호가 이 값 이상이면 1순위 반려 (예: 22) */
    rejectRankFrom?: number | null
    /** 신청오프 반려는 하루 n명까지 */
    maxRejectPerDay?: number | null
    /** 같은 사람은 기간 중 1번까지만 반려 */
    rejectOncePerPerson?: boolean
    /** 나이트 보상휴가: from~to 사이 N per 개마다 다음 날부터 휴가 +1 */
    nightAccrual?: { from: string; to: string; per: number } | null
    forbidden: [string, string][]
  }
  staff: Staff[]
  requests: LeaveRequest[]
  fixed: Fixed[]
  /** 금지·지향 조건, 근무 특별조건 (version 2) */
  conditions?: Condition[]
  /** 급작 휴가·변동 이력 */
  events?: ChangeEvent[]
  roster: Record<string, string[]>
  /** 직접 수정해 고정한 칸 */
  locks: Record<string, boolean[]>
  /** 확인 완료 처리한 항목: 항목 id → 메모 */
  acks: Record<string, string>
  notes: string[]
  /** 원본 조건 문장 (엑셀에서 불러온 경우) */
  conditionText?: string[]
}

export type Level = '위반' | '확인' | '권장'

export interface Issue {
  id: string
  level: Level
  rule: string
  msg: string
  staff?: string
  /** 표시할 칸: [직원 id, 날짜 index] */
  cells: [string, number][]
  /** 날짜 단위 문제 (하단 집계) */
  days?: number[]
}

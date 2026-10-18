/**
 * 실행 환경 차이를 감추는 작은 도우미.
 * PREVIEW(Claude 아티팩트 미리보기)에서는 확인 창·내려받기 링크가 막혀 있으므로
 * 확인 창 대신 바로 진행(되돌리기 가능)하고, 파일은 downloads 기능으로 저장한다.
 */
export const PREVIEW = import.meta.env.VITE_PREVIEW === '1'
/** 자동 생성 서버(/api/solve)가 없는 배포 — 미리보기, GitHub Pages(VITE_NO_SERVER=1) */
export const NO_SERVER = PREVIEW || import.meta.env.VITE_NO_SERVER === '1'

type ClaudeHost = { use: (name: string) => Promise<unknown> }
type Downloads = { save: (req: { filename: string; data: Blob | string }) => Promise<unknown> }

/** 확인 창 (미리보기에서는 바로 진행 — [되돌리기]로 취소 가능) */
export function ask(msg: string): boolean {
  return PREVIEW ? true : window.confirm(msg)
}

/** 짧은 입력 (미리보기에서는 기본값) */
export function askText(msg: string, def = ''): string | null {
  return PREVIEW ? def : window.prompt(msg, def)
}

/** 알림: 미리보기에서는 화면 상단 알림줄로 */
export function notify(msg: string) {
  if (PREVIEW) window.dispatchEvent(new CustomEvent('app-notice', { detail: msg }))
  else window.alert(msg)
}

/** 파일 저장: 미리보기는 downloads 기능, 그 밖에는 내려받기 링크 */
export async function saveFile(blob: Blob, name: string) {
  const host = (window as unknown as { claude?: ClaudeHost }).claude
  if (PREVIEW && host) {
    const dl = (await host.use('downloads')) as Downloads | null
    if (!dl) return notify('이 화면에서는 파일 저장을 쓸 수 없습니다.')
    try {
      await dl.save({ filename: name, data: blob })
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'declined') notify(`저장하지 못했습니다 (${code ?? String(e)}).`)
    }
    return
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

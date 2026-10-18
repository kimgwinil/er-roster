import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_PREVIEW=1: Claude 아티팩트 미리보기용 빌드 (상대 경로, 예시 데이터 폴더)
const preview = process.env.VITE_PREVIEW === '1'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages 등 하위 경로 배포는 VITE_BASE=/저장소명/ 로 지정
  base: preview ? './' : process.env.VITE_BASE || '/',
  publicDir: preview ? 'preview-public' : 'public',
  build: { outDir: preview ? 'dist-preview' : 'dist' },
  // 미리보기 게시는 특수 문자(U+FFFD 등)를 그대로 둔 파일을 받지 않으므로 ASCII 로 이스케이프
  esbuild: preview ? { charset: 'ascii' } : undefined,
  server: { proxy: { '/api': 'http://localhost:3001' } },
})

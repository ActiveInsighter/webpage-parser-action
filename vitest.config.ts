import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  define: {
    __POCKETBASE_URL__: JSON.stringify('https://pb.test'),
    __ALLOW_LOCAL_TARGETS__: 'false',
    __CRAWLER_VERSION__: JSON.stringify('0.0.0'),
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://example.com/' } },
    include: ['tests/unit/**/*.test.ts'],
    restoreMocks: true,
  },
})

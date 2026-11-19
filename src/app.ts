// The page: boots the demo app through the js-meta runtime, then shows what it holds.
import { bootstrap, runtime } from './index.ts'

const t0 = performance.now()
const main = await bootstrap(new URL('./demo/main.js', import.meta.url).href)
const t1 = performance.now()

console.log(`[meta] booted in ${(t1 - t0).toFixed(1)} ms; stack from main.js: ${main.where}`)
for (const r of runtime().records.values()) {
  const deps = r.dependencies.map((d) => d.split('/').pop()).join(', ') || '-'
  console.log(`[meta] ${r.kind.padEnd(6)} ${r.status.padEnd(9)} ${r.url}  deps: ${deps}`)
}

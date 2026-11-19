// The page: boots the demo app through the js-meta runtime, then redefines one
// function live and shows that state and handed-out callbacks carry on.
import { bootstrap, runtime } from './index.ts'

const t0 = performance.now()
const main = await bootstrap(new URL('./demo/main.js', import.meta.url).href)
const t1 = performance.now()
console.log(`[meta] booted in ${(t1 - t0).toFixed(1)} ms`)

const click = main.click as () => string
console.log(`[meta] click() -> ${click()}`)

const url = new URL('./demo/counter.js', import.meta.url).href
const record = runtime().records.get(url)!
const next = record.source!.replace('`count = ${count}`', '`clicked ${count} times`')
const r = await runtime().redefine(url, next)
console.log(`[meta] redefined counter.js v${r.version}: ${r.changed} form(s) re-run`)
console.log(`[meta] click() -> ${click()}  (same callback, new label, count kept)`)

for (const rec of runtime().records.values()) {
  const deps = rec.dependencies.map((d) => d.split('/').pop()).join(', ') || '-'
  console.log(`[meta] ${rec.kind.padEnd(6)} v${rec.version} ${rec.url}  deps: ${deps}`)
}

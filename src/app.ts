// The page: boots the demo app through the js-meta runtime with one macro, then
// redefines a function live, evaluates code inside a module, and lists the graph.
import { transform } from './demo/macros.ts'
import { bootstrap, emit, runtime } from './index.ts'

const t0 = performance.now()
const mainUrl = new URL('./demo/main.js', import.meta.url).href
const main = await bootstrap(mainUrl, { transform })
const t1 = performance.now()
console.log(`[meta] booted in ${(t1 - t0).toFixed(1)} ms`)
const expanded = emit(runtime().records.get(mainUrl)!.ast!).split('\n').find((l) => l.startsWith('if ('))
console.log(`[meta] assert(...) in main.js expanded to: ${expanded}`)

const click = main.click as () => string
console.log(`[meta] click() -> ${click()}`)

// Live redefinition: one changed form re-runs, state and handed-out callbacks stay.
const url = new URL('./demo/counter.js', import.meta.url).href
const record = runtime().records.get(url)!
const next = record.source!.replace('`count = ${count}`', '`clicked ${count} times`')
const r = await runtime().redefine(url, next)
console.log(`[meta] redefined counter.js v${r.version}: ${r.changed} form(s) re-run`)
console.log(`[meta] click() -> ${click()}  (same callback, new label, count kept)`)

// REPL inside the module: its cells and imports are in scope.
console.log(`[meta] eval in counter.js: inc(); label() -> ${await runtime().eval(url, 'inc(); label()')}`)

// For the DevTools console: await meta.eval('./src/demo/counter.js', 'count')
Object.assign(globalThis, { meta: runtime() })

for (const rec of runtime().records.values()) {
  const deps = rec.dependencies.map((d) => d.split('/').pop()).join(', ') || '-'
  console.log(`[meta] ${rec.kind.padEnd(6)} v${rec.version} ${rec.url}  deps: ${deps}`)
}

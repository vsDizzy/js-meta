// read() + emit() on the page: same code as under node --test. ts-code maps
// `dependencies` to esm.sh; the parser shares the page's TypeScript (external).
import { emit } from './emit/index.ts'
import { read } from './read/index.ts'

const url = new URL('./emit/index.ts', import.meta.url).href
const source = await (await fetch(url)).text()

const t0 = performance.now()
const ast = read(source, { filename: url })
const t1 = performance.now()
const code = emit(ast)
const t2 = performance.now()

const same = emit(read(code, { filename: url })) === code
console.log(`[meta] ${url}: read ${(t1 - t0).toFixed(1)} ms, emit ${(t2 - t1).toFixed(1)} ms, fixed point: ${same}`)
console.log(code.split('\n').slice(0, 12).join('\n'))

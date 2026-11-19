// read() on the page: same code as under node --test; the import map in
// index.html points the parser at esm.sh, sharing one TypeScript with ts-code's SW.
import { originOf, read, type Node } from './read/index.ts'

const url = new URL('./app.ts', import.meta.url).href
const source = await (await fetch(url)).text()

const t0 = performance.now()
const ast = read(source, { filename: url })
const ms = performance.now() - t0

const top = ast.body.map((n: Node) => (n.type === 'Comment' ? `//${String(n.value).slice(0, 30)}` : n.type))
console.log(`[read] ${url} in ${ms.toFixed(1)} ms`, top)
console.log('[read] first statement origin', originOf(ast.body.find((n) => n.type !== 'Comment')!))

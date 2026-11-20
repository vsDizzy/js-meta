// What rules cost, on the repo's own sources: `node scripts/bench-rules.ts`.
// Prints ns per node for a bare walk; for N rules that never fire, through
// `rules` (indexed by kind and head) and through the linear set (every rule
// tried at every node, as before the index); and for a set that does fire.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { js, p, read, rule, rules, walk, type Node, type Rule, type Visitor } from '../src/index.ts'
import { linear } from '../src/quote/rule.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'fixtures' ? [] : filesIn(join(dir, e.name))) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  )

const files = filesIn(SRC)
const asts = files.map((file) => read(readFileSync(file, 'utf8'), { filename: file.replaceAll('\\', '/') }))
let nodes = 0
for (const ast of asts) walk(ast, () => void nodes++)

/** N rules that match nothing in the sources: calls and `new` keyed by head, members and operators by kind only. */
function neverFiring(n: number): Rule[] {
  return Array.from({ length: n }, (_, i) => {
    const name = `never${i}`
    switch (i % 4) {
      case 0:
        return rule(js`${js.id(name)}($a, $$rest)`, js`$a`)
      case 1:
        return rule(js`$o.${name}`, js`$o`)
      case 2:
        return rule(p.node('BinaryExpression', { operator: name }), null)
      default:
        return rule(js`new ${js.id(name)}($$args)`, js`null`)
    }
  })
}

/** Type erasure (as in src/match/acceptance.test.ts, without the marks), a set that fires all over these sources. */
const erasure = [
  rule(p.node(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSIndexSignature']), null),
  rule(p.or(p.node('ImportDeclaration', { importKind: 'type' }), p.node('ExportNamedDeclaration', { exportKind: 'type' })), null),
  rule(p.or(p.node('ImportSpecifier', { importKind: 'type' }), p.node('ExportSpecifier', { exportKind: 'type' })), null),
  rule(p.node(['VariableDeclaration', 'ClassDeclaration', 'PropertyDefinition'], { declare: true }), null),
  rule(js`$x as $T`, js`$x`),
  rule(js`$x satisfies $T`, js`$x`),
  rule(js`$x!`, js`$x`),
  rule(p.node(['TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSClassImplements']), null),
]

/** Median ns per node of a walk over all the sources, after warming up: at least 3 passes, and a second of them if they are quick. */
function measure(visitor: Visitor): number {
  const pass = () => {
    const start = performance.now()
    for (const ast of asts) walk(ast, visitor)
    return performance.now() - start
  }
  if (pass() < 500) pass()
  const samples: number[] = []
  for (let total = 0; samples.length < 3 || (total < 1000 && samples.length < 25); ) {
    const ms = pass()
    samples.push(ms)
    total += ms
  }
  samples.sort((a, b) => a - b)
  return (samples[samples.length >> 1] * 1e6) / nodes
}

const ns = (v: number) => v.toFixed(0).padStart(9)
const row = (label: string, ...values: number[]) => console.log(label.padEnd(26) + values.map(ns).join(''))

console.log(`${files.length} files, ${nodes} nodes (comments included); ns per node, median of passes\n`)
row('walk alone', measure(() => undefined))
console.log('\n'.padEnd(27) + 'indexed'.padStart(9) + 'linear'.padStart(9))
for (const n of [1, 10, 50, 200]) {
  const set = neverFiring(n)
  row(`${n} rule${n === 1 ? '' : 's'}, never fire`, measure(rules(...set)), measure(linear(...set)))
}
row(`TS erasure (${erasure.length}, fire)`, measure(rules(...erasure)), measure(linear(...erasure)))

// The erasure did its work: no TS node is left.
let left = 0
for (const ast of asts) walk(walk(ast, rules(...erasure))!, (n: Node) => void (n.type.startsWith('TS') && left++))
console.log(`\nTS nodes left after erasure: ${left}`)

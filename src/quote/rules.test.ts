import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { emit } from '../emit/index.ts'
import { defineFamily } from '../ast/family.ts'
import { define, make, toNode, type Node } from '../ast/node.ts'
import { walk, type Ctx } from '../ast/walk.ts'
import { p } from '../match/index.ts'
import { read } from '../read/index.ts'
import { js, rule, rules, type Rule } from './index.ts'
import { candidates, linear } from './rule.ts'

// Registries are global: every prefix here is this file's own.

const print = (n: unknown): string => emit(n as never).trimEnd()

/** A rule made by hand: a function with `once`, no pattern, so no key. */
function custom(once: (node: Node, ctx: Ctx) => Node | null | undefined): Rule {
  return Object.assign((node: Node, ctx: Ctx) => once(node, ctx) ?? undefined, { once })
}

describe('rules: the index', () => {
  test('indexed and linear give the same code, on the project sources', () => {
    const set = [
      // Before the keyed rules for the same nodes: order across buckets.
      custom((n) => (n.type === 'CallExpression' && (n.callee as Node).name === 'emit' ? js`emitted()` : undefined)),
      rule(p.or(js`emit($x)`, js`print($x)`), js`show($x)`),
      rule(js`read($src)`, js`parse($src)`),
      rule(js`$a + 1`, js`inc($a)`),
      rule(js`inc($a)`, (m) => js`succ(${m.a})`), // what the rule above expands into
      rule(js`make($$a)`, js`mk([$$a], 0)`, { from: '../ast/node.ts' }),
      rule(js`$f($a, $b, $c)`, (m) => js`call3(${m.f}, [${m.a}, ${m.b}, ${m.c}])`), // a variable head
      rule(js`assert.equal($a, $b)`, js`same($a, $b)`),
      rule(js.stmt`throw $e`, js.stmt`fail($e)`), // a statement pattern
      rule(js.stmt`assert.ok($x)`, null), // removal
      rule(p.node('BinaryExpression', { operator: '===', left: p.bind('l'), right: p.bind('r') }), js`eq($l, $r)`),
      rule(p.bind('w', js`walk($$args)`), (m) => js`traverse(${m.args})`),
      rule(p.guard(js`$x.length`, (m) => m.x.type === 'Identifier'), (m) => js`count(${m.x})`),
      custom((n) => (n.type === 'Identifier' && n.name === 'undefined' ? js`void 0` : undefined)),
      // After the keyed rules for the same nodes: they must not get ahead (`read(x)` stays `parse(x)`).
      custom((n) => (n.type === 'CallExpression' && (n.callee as Node).name === 'read' && (n.arguments as Node[]).length === 1 ? js`readAny()` : undefined)),
      rule(p.node('CallExpression', { arguments: [p.bind('a')] }), (m) => js`one(${m.a}, 1)`),
    ]
    const indexed = rules(...set)
    const plain = linear(...set)

    const SRC = fileURLToPath(new URL('..', import.meta.url))
    const filesIn = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === 'fixtures' ? [] : filesIn(join(dir, e.name))) : /\.(js|ts)$/.test(e.name) ? [join(dir, e.name)] : [],
      )
    const out: Record<string, string> = {}
    for (const file of filesIn(SRC)) {
      const name = relative(SRC, file).replaceAll('\\', '/')
      const ast = read(readFileSync(file, 'utf8'), { filename: file.replaceAll('\\', '/') })
      const a = emit(walk(ast, indexed)!)
      assert.equal(a, emit(walk(ast, plain)!), name)
      out[name] = a
    }
    // The rules did fire.
    const all = Object.values(out).join('\n')
    for (const s of ['emitted()', 'show(', 'parse(', 'succ(', 'call3(', 'same(', 'fail(', 'eq(', 'traverse(', 'count(', 'void 0', 'one(']) {
      assert.ok(all.includes(s), s)
    }
    // Not as a call; this file has it in strings.
    assert.doesNotMatch(all, /(?<![`'])readAny\(\)/)
    assert.ok(out['quote/match.ts'].includes('mk(['), 'make, imported from ../ast/node.ts')
    assert.ok(!out['ast/node.ts'].includes('mk(['), 'make, the local function')
  })

  test('candidates come in the order the rules were given', () => {
    const any = rule(p.bind('x'), (m) => m.x)
    const named = rule(js`f($a)`, js`g($a)`)
    const kind = rule(p.node('CallExpression'), (_, n) => n)
    const other = rule(js`h($a)`, js`k($a)`)
    const set = rules(named, kind, other, any)
    assert.deepEqual(candidates(set, js`f(1)`), [named, kind, any])
    assert.deepEqual(candidates(set, js`h(1)`), [kind, other, any])
    assert.deepEqual(candidates(set, js`o.m(1)`), [kind, any])
    assert.deepEqual(candidates(set, js`a + b`), [any])
    // `f(1)` alone: the statement unwraps to the call.
    assert.deepEqual(candidates(set, read('f(1)').body[0]), [named, kind, any])
    assert.deepEqual(candidates(rules(any, named), js`f(1)`), [any, named])
  })

  test('the first that fires wins, keyed or not', () => {
    const a = custom((n) => (n.type === 'CallExpression' && (n.callee as Node).name === 'f' ? js`first()` : undefined))
    const b = rule(js`f($x)`, js`second()`)
    assert.equal(print(walk(read('x = f(1)'), rules(a, b))), 'x = first()')
    assert.equal(print(walk(read('x = f(1)'), rules(b, a))), 'x = second()')
  })

  test('nested rules are flattened, in order', () => {
    const f = rule(js`f($x)`, js`F($x)`)
    const g = rule(js`g($x)`, js`G($x)`)
    const h = rule(js`f($x)`, js`H($x)`)
    const set = rules(h, rules(f, rules(g)))
    assert.deepEqual(candidates(set, js`f(1)`), [h, f])
    assert.deepEqual(candidates(set, js`g(1)`), [g])
    assert.equal(print(walk(read('f(1)\ng(2)'), set)), 'H(1)\nG(2)')
    assert.equal(print(walk(read('f(1)\ng(2)'), rules(rules(f, g), h))), 'F(1)\nG(2)')
  })

  test('statement patterns are filed under the statement; an expression pattern also fires on its statement', () => {
    const stmt = rule(js.stmt`log($x)`, null)
    const expr = rule(js`log($x)`, js`trace($x)`)
    const set = rules(stmt, expr)
    assert.deepEqual(candidates(set, read('log(1)').body[0]), [stmt, expr])
    assert.deepEqual(candidates(set, js`log(1)`), [expr])
    assert.equal(print(walk(read('log(1)\nx = log(2)'), set)), 'x = trace(2)')
  })

  test('JSX elements, tags and new are dispatched by their name', () => {
    const box = rule(js`<Box />`, js`<div />`)
    const sql = (read('sql`x`').body[0] as any).expression as Node
    const tag = rule(sql, js`query()`)
    const ctor = rule(js`new Foo()`, js`foo()`)
    const set = rules(box, tag, ctor)
    assert.deepEqual(candidates(set, js`<Box />`), [box])
    assert.deepEqual(candidates(set, sql), [tag])
    assert.deepEqual(candidates(set, js`new Foo()`), [ctor])
    assert.deepEqual(candidates(set, js`new Bar()`), [])
    assert.equal(print(walk(read('a = <Box />\nb = sql`x`\nc = new Foo()', { filename: 'x.jsx' }), set)), 'a = <div />\nb = query()\nc = foo()')
  })
})

// An S-expression family: the head of a list is its first element, if a symbol.
defineFamily('ridx', {
  head(n) {
    if (n.type !== 'ridx/list') return undefined
    const h = (n.children[0] as (Node | null)[])[0]
    return h?.type === 'ridx/symbol' ? { node: h, name: h.name as string } : undefined
  },
})
define('ridx/list', ['items'])
define('ridx/symbol', [])

const sym = (name: string) => toNode({ type: 'ridx/symbol', name, children: [] })
const list = (...items: Node[]) => make('ridx/list', {}, [items])
const show = (n: Node | null): string =>
  !n ? 'nil' : n.type === 'ridx/symbol' ? (n.name as string) : `(${(n.children[0] as Node[]).map(show).join(' ')})`

describe('rules: a foreign family with heads', () => {
  const when = rule(list(sym('when'), p.bind('c'), p.rest('body')), (m) => list(sym('if'), m.c, list(sym('do'), ...m.body)))
  const unless = rule(list(sym('unless'), p.bind('c'), p.rest('body')), (m) => list(sym('when'), list(sym('not'), m.c), ...m.body))
  const set = rules(when, unless)

  test('(when …) and (unless …) are looked up by their head symbol', () => {
    assert.deepEqual(candidates(set, list(sym('when'), sym('c'))), [when])
    assert.deepEqual(candidates(set, list(sym('unless'), sym('c'))), [unless])
    assert.deepEqual(candidates(set, list(sym('if'), sym('c'))), [])
    assert.deepEqual(candidates(set, list(list(sym('f')), sym('c'))), [], 'no head')
    assert.deepEqual(candidates(set, sym('when')), [])
  })

  test('they expand, one into the other', () => {
    const out = walk(list(sym('do'), list(sym('unless'), sym('ok'), list(sym('run'))), list(sym('when'), sym('a'))), set)
    assert.equal(show(out), '(do (if (not ok) (do (run))) (if a (do)))')
    assert.equal(show(walk(list(sym('do'), list(sym('unless'), sym('ok'))), linear(when, unless))), '(do (if (not ok) (do)))')
  })
})

describe('rules: { from }, the head through its binding', () => {
  const run = (src: string, r: Rule) => print(walk(read(src), r))
  const check = rule(js`assert($c)`, js`check($c)`, { from: './macros.js' })

  test('fires on the import under any local name', () => {
    assert.equal(run("import { assert as a } from './macros.js'\na(x)\ny = a(z)", check), "import { assert as a } from './macros.js'\ncheck(x)\ny = check(z)")
    assert.equal(run("import { assert } from './macros.js'\nassert(x)", check), "import { assert } from './macros.js'\ncheck(x)")
  })

  test('not on a local of that name, a free global, or another import', () => {
    assert.equal(run("import { assert } from './macros.js'\nfunction f(assert) { assert(x) }", check), "import { assert } from './macros.js'\n\nfunction f(assert) {\n  assert(x)\n}")
    assert.equal(run('assert(x)', check), 'assert(x)')
    assert.equal(run("import { assert } from './other.js'\nassert(x)", check), "import { assert } from './other.js'\nassert(x)")
    assert.equal(run("import { ok as assert } from './macros.js'\nassert(x)", check), "import { ok as assert } from './macros.js'\nassert(x)")
    assert.equal(run("import * as m from './macros.js'\nm.assert(x)", check), "import * as m from './macros.js'\nm.assert(x)")
  })

  test('name: the export, when it is not the name in the pattern', () => {
    const byName = rule(js`ok($c)`, js`check($c)`, { from: { source: './macros.js', name: 'assert' } })
    assert.equal(run("import { assert as ok } from './macros.js'\nok(x)", byName), "import { assert as ok } from './macros.js'\ncheck(x)")
    const byDefault = rule(js`assert($c)`, js`check($c)`, { from: { source: 'node:assert', name: 'default' } })
    assert.equal(run("import assert from 'node:assert'\nassert(x)", byDefault), "import assert from 'node:assert'\ncheck(x)")
    assert.equal(run("import assert from 'node:assert'\nassert(x)", rule(js`assert($c)`, js`check($c)`, { from: 'node:assert' })), "import assert from 'node:assert'\nassert(x)")
  })

  test('without from, by name, shadowed or not', () => {
    const byName = rule(js`assert($c)`, js`check($c)`)
    assert.equal(run('function f(assert) { assert(x) }', byName), 'function f(assert) {\n  check(x)\n}')
  })

  test('a head made by a template is looked up from the nearest scope it is in', () => {
    const set = rules(
      rule(js`unless($c, $x)`, js`when(!$c, $x)`, { from: './macros.js' }),
      rule(js`when($c, $x)`, js`$c && $x`, { from: './macros.js' }),
    )
    const imports = "import { when, unless } from './macros.js'\n"
    assert.equal(run(`${imports}unless(a, b())`, set), `${imports}!a && b()`)
    assert.equal(run(`${imports}function f(when) { unless(a, b()) }`, set), `${imports}\nfunction f(when) {\n  when(!a, b())\n}`)
  })

  test('mistakes: no head to look up, alternatives with different heads', () => {
    assert.throws(() => rule(js`$f($c)`, null, { from: './m.js' }), /no head to look up/)
    assert.throws(() => rule(js`a.b($c)`, null, { from: './m.js' }), /no head to look up/)
    assert.throws(() => rule(p.or(js`f($c)`, js`g($c)`), null, { from: './m.js' }), /different heads \(f, g\)/)
    const either = rule(p.or(js`f($c)`, js`g($c)`), js`h($c)`, { from: { source: './m.js', name: 'f' } })
    assert.equal(run("import { f as g } from './m.js'\ng(1)", either), "import { f as g } from './m.js'\nh(1)")
  })

  test('the scope is looked at only where the pattern matches', () => {
    let reads = 0
    // Counts reads of `ctx.scope`.
    const spy = (n: Node, ctx: Ctx) => check(n, new Proxy(ctx, { get: (t, k) => (k === 'scope' && reads++, Reflect.get(t, k)) }))
    walk(read('f(1, 2)\ng()\nx + y'), spy)
    assert.equal(reads, 0)
    walk(read('assert(1)'), spy)
    assert.ok(reads > 0)
  })
})

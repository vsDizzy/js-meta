import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit } from '../emit/index.ts'
import { p } from '../match/index.ts'
import { js, rule, rules } from '../quote/index.ts'
import { read } from '../read/index.ts'
import { define, make, toNode, type Node } from './node.ts'
import { walk, type Ctx } from './walk.ts'

// Registries are global: every prefix here is this file's own.

const print = (n: unknown): string => emit(n as never).trimEnd()
const ts = (src: string) => read(src, { filename: 'x.ts' })

/** For each Identifier whose name starts with `x`: what `pick` says about its ctx. */
function at<T>(src: string, pick: (ctx: Ctx) => T): Record<string, T> {
  const out: Record<string, T> = {}
  walk(ts(src), { Identifier: (n, ctx) => void (/^x/.test(n.name as string) && (out[n.name as string] = pick(ctx))) })
  return out
}

describe('ctx.scope', () => {
  test('the scope of the tree the walk started with, from inside a handler', () => {
    const seen: string[] = []
    const scopes = new Set<unknown>()
    walk(read("import { a } from './x.js'\nfunction f(b) { a(b); c(b) }"), {
      CallExpression(n, ctx) {
        scopes.add(ctx.scope)
        const b = ctx.scope.bindingOf(n.callee as Node)
        seen.push(b === null ? 'free' : `${b!.kind} ${JSON.stringify(b!.import)}`)
      },
    })
    assert.deepEqual(seen, ['import {"source":"./x.js","name":"a"}', 'free'])
    assert.equal(scopes.size, 1, 'computed once per walk')
  })

  test('a snapshot: nodes made during the walk are not in it', () => {
    const found: unknown[] = []
    walk(read('let a = 1\nf(a)'), {
      CallExpression(n) {
        // The capture is the original node; the second `a` is new.
        if ((n.callee as Node).name === 'f') return js`g(${(n.arguments as Node[])[0]}, a)`
      },
      Identifier(n, ctx) {
        if (n.name === 'a' && ctx.parent?.type === 'CallExpression') found.push(ctx.scope.bindingOf(n)?.kind)
      },
    })
    assert.deepEqual(found, ['let', undefined])
  })

  test('trees with nodes of other families', () => {
    define('ctxs/list', ['items'])
    define('ctxs/sym', [])
    const tree = make('ctxs/list', {}, [[toNode({ type: 'ctxs/sym', name: 'f', children: [] }), js`x + y`]])
    const free: string[][] = []
    walk(tree, { BinaryExpression: (_, ctx) => void free.push([...ctx.scope.free.keys()]) })
    assert.deepEqual(free, [['x', 'y']])
    assert.doesNotThrow(() => walk(js`[${tree}]`, (_, ctx) => void ctx.scope))
  })
})

describe('ctx.position', () => {
  test('statement, expression or neither', () => {
    const where = (src: string) => at(src, (ctx) => ctx.position)
    assert.deepEqual(where('x1\nf(x2)\nif (x3) x4\nelse { x5 }'), { x1: 'statement', x2: 'expression', x3: 'expression', x4: 'statement', x5: 'statement' })
    assert.deepEqual(where('let x1 = x2\nfunction xf(x3) { return x4 }'), { x1: null, x2: 'expression', xf: null, x3: null, x4: 'expression' })
    assert.deepEqual(where('o.x1\no[x2]\nx3.y\n({ x4: x5, [x6]: 1, x7 })'), { x1: null, x2: 'expression', x3: 'expression', x4: null, x5: 'expression', x6: 'expression', x7: 'expression' })
    assert.deepEqual(where('const { a: x1, x2 = x3 } = o\n;[x4] = o\nx5 = x6\nx7++'), { x1: null, x2: null, x3: 'expression', x4: null, x5: null, x6: 'expression', x7: null })
    assert.deepEqual(where('for (const x1 of x2) x3\nwhile (x4) {}\nx5: x6\nf(...x7)'), { x1: null, x2: 'expression', x3: 'statement', x4: 'expression', x5: null, x6: 'statement', x7: 'expression' })
    assert.deepEqual(where('let a: x1 = x2 as x3\nx4!\nexport default x5'), { x1: null, x2: 'expression', x3: null, x4: 'expression', x5: 'expression' })
    assert.deepEqual(where('const f = () => x1\nconst g = () => { x2 }\nclass C extends x3 { x4 = x5; [x6]() {} }'), { x1: 'expression', x2: 'statement', x3: 'expression', x4: null, x5: 'expression', x6: 'expression' })
  })

  test('null at the root, for comments, and for nodes of other families', () => {
    const positions: unknown[] = []
    walk(read('x = /* c */ f()'), (_, ctx) => void positions.push(ctx.position))
    // Program, the statement, `x = …` (its value is discarded), x, f(), the comment, f.
    assert.deepEqual(positions, [null, 'statement', 'statement', null, 'expression', null, 'expression'])
    define('ctxp/call', ['callee', 'args'])
    const foreign = make('ctxp/call', {}, [js`f`, [js`x`]])
    const seen: unknown[] = []
    walk(foreign, { Identifier: (_, ctx) => void seen.push(ctx.position) })
    assert.deepEqual(seen, [null, null])
  })
})

describe('ctx.tail', () => {
  test('return, arrow bodies, and what passes the value through', () => {
    const tail = (src: string) => at(src, (ctx) => ctx.tail)
    assert.deepEqual(tail('function f() { x1; return x2 }'), { x1: false, x2: true })
    assert.deepEqual(tail('const f = () => x1\nconst g = () => { x2 }'), { x1: true, x2: false })
    assert.deepEqual(tail('function f() { return x1 ? x2 : x3 }'), { x1: false, x2: true, x3: true })
    assert.deepEqual(tail('function f() { return x1 && x2 || x3 }'), { x1: false, x2: false, x3: true })
    assert.deepEqual(tail('function f() { return (x1, x2) }'), { x1: false, x2: true })
    assert.deepEqual(tail('function f() { return x1 as T }\nconst g = () => x2!\nconst h = () => x3 satisfies T'), { x1: true, x2: true, x3: true })
    assert.deepEqual(tail('async function f() { return await x1 }'), { x1: false })
    assert.deepEqual(tail('function f() { return x1(x2) }'), { x1: false, x2: false })
    assert.deepEqual(tail('x1 ? x2 : x3'), { x1: false, x2: false, x3: false }, 'not in a function')
  })

  test('the call in tail position', () => {
    const tails: string[] = []
    walk(read('function f(n) { if (n) return g(n - 1); h(); return n ? k() : m() }'), {
      CallExpression: (n, ctx) => void (ctx.tail && tails.push((n.callee as Node).name as string)),
    })
    assert.deepEqual(tails, ['g', 'k', 'm'])
  })
})

describe('ctx.env', () => {
  test('from walk, inherited, overridden by expand for the expanded node and below', () => {
    const depth: Record<string, unknown> = {}
    const deeper = rule(js`deeper($x)`, (m, _, ctx) => ctx.expand(m.x, { depth: ctx.env.depth + 1 }))
    walk(read('xa\ndeeper(xb)\ndeeper([xc, deeper(xd)])\nxe'), {
      enter: (n, ctx) => deeper(n, ctx),
      Identifier: (n, ctx) => void (depth[n.name as string] = ctx.env.depth),
    }, { env: { depth: 0 } })
    assert.deepEqual(depth, { xa: 0, xb: 1, xc: 1, xd: 2, xe: 0 })
  })

  test('undefined without one', () => {
    const envs: unknown[] = []
    walk(js`f(x)`, (_, ctx) => void envs.push(ctx.env))
    assert.deepEqual(envs, [undefined, undefined, undefined])
  })
})

describe('ctx.expand', () => {
  const lit = (value: number) => make('Literal', { value, raw: String(value) }, [])

  test('constant folding: the arguments are expanded before deciding', () => {
    let folds = 0
    const fold = rule(js`add($a, $b)`, (m, _, ctx) => {
      folds++
      const a = ctx.expand(m.a)!
      const b = ctx.expand(m.b)!
      return a.type === 'Literal' && b.type === 'Literal' ? lit((a.value as number) + (b.value as number)) : js`${a} + ${b}`
    })
    const entered = new Map<Node, number>()
    const count = (n: Node, ctx: Ctx) => {
      entered.set(n, (entered.get(n) ?? 0) + 1)
      return fold(n, ctx)
    }
    assert.equal(print(walk(read('x = add(add(1, 2), 3)'), count)), 'x = 6')
    assert.equal(folds, 2)
    assert.deepEqual([...entered.values()].filter((k) => k > 1), [], 'no node is entered twice')
    assert.equal(print(walk(read('y = add(x, add(add(1, 2), 3))'), count)), 'y = x + 6')
    assert.equal(folds, 5)
    assert.deepEqual([...entered.values()].filter((k) => k > 1), [])
  })

  test('the expanded node is done: the walk passes over it in the replacement', () => {
    const seen: string[] = []
    const out = walk(read('wrap(inc(1))'), {
      enter: rules(
        rule(js`wrap($x)`, (m, _, ctx) => js`[${ctx.expand(m.x)}]`),
        rule(js`inc($x)`, js`$x + 1`),
      ),
      leave: (n) => void seen.push(n.type),
    })
    assert.equal(print(out), '[1 + 1]')
    // Literal, Literal, BinaryExpression once each, from the expansion; then the array and up.
    assert.deepEqual(seen, ['Literal', 'Literal', 'BinaryExpression', 'ArrayExpression', 'ExpressionStatement', 'Program'])
  })

  test('as if it stood here: same parent, key and position', () => {
    const seen: unknown[] = []
    walk(read('f(here(g))'), {
      CallExpression(n, ctx) {
        if ((n.callee as Node).name === 'here') return ctx.expand((n.arguments as Node[])[0])
      },
      Identifier(n, ctx) {
        if (n.name === 'g') seen.push(ctx.parent?.type, ctx.key, ctx.index, ctx.position)
      },
    })
    assert.deepEqual(seen, ['CallExpression', 'arguments', 0, 'expression'])
  })
})

describe('ctx.send, ctx.receive', () => {
  const sent: boolean[] = []
  const macros = rules(
    // A loop learns whether its body breaks.
    rule(js`loop($body)`, (m, _, ctx) => {
      const [body, breaks] = ctx.receive('break', () => ctx.expand(m.body))
      return breaks.length ? js`labeled(${body}, ${breaks.length})` : js`plain(${body})`
    }),
    rule(js`brk()`, (_, __, ctx) => (sent.push(ctx.send('break', 1)), js`stop()`)),
  )

  test('a form learns what was sent from the forms in its expansion', () => {
    assert.equal(print(walk(read('loop(() => { brk(); if (a) brk() })'), macros)), 'labeled(() => {\n  stop()\n  if (a) stop()\n}, 2)')
    assert.equal(print(walk(read('loop(() => { a() })'), macros)), 'plain(() => {\n  a()\n})')
  })

  test('the innermost receiver takes it; without one, send returns false', () => {
    sent.length = 0
    assert.equal(print(walk(read('loop(() => loop(() => brk()))'), macros)), 'plain(() => labeled(() => stop(), 1))')
    assert.deepEqual(sent, [true])
    assert.equal(print(walk(read('brk()'), macros)), 'stop()')
    assert.deepEqual(sent, [true, false])
  })

  test('receive returns what fn returns; other tags pass by', () => {
    let got: unknown
    walk(read('f()'), {
      CallExpression(_, ctx) {
        got = ctx.receive('a', () => ctx.receive('b', () => (ctx.send('a', 1), ctx.send('b', 2), 'done')))
      },
    })
    assert.deepEqual(got, [['done', [2]], [1]])
  })
})

describe('ctx in rules and handlers', () => {
  test('guards inside rules get the walk ctx', () => {
    const atStatement = rule(p.guard(js`f($x)`, (_, __, ctx) => ctx.position === 'statement'), js`g($x)`)
    assert.equal(print(walk(read('f(1)\ny = f(2)'), atStatement)), 'g(1)\ny = f(2)')
    const free = rule(p.guard(js`$f($x)`, (m, _, ctx) => ctx.scope.bindingOf(m.f) === null), js`log($x)`)
    assert.equal(print(walk(read('function h() {}\nh(1)\nk(2)'), free)), 'function h() {}\n\nh(1)\nlog(2)')
  })

  test('leave gets the ctx enter got', () => {
    const ctxs = new Map<Node, Ctx>()
    let same = 0
    walk(read('f(a, b)'), {
      enter: (n, ctx) => void ctxs.set(n, ctx),
      leave: (n, ctx) => void (ctxs.get(n) === ctx && same++),
    })
    assert.equal(same, 6)
  })
})

describe('ctx.freshName', () => {
  test('not a name in the tree, and never the same twice in one walk', () => {
    const names: string[] = []
    walk(read('let tmp = 1\nf(tmp_2)'), { CallExpression: (_, ctx) => void names.push(ctx.freshName('tmp'), ctx.freshName('tmp'), ctx.freshName('t')) })
    assert.deepEqual(names, ['tmp_1', 'tmp_3', 't'])
  })

  test('through ctx.expand too; a new walk starts over', () => {
    const r = rules(
      rule(js`fresh()`, (_, __, ctx) => js.id(ctx.freshName('v'))),
      rule(js`pair($x)`, (m, _, ctx) => js`[${ctx.expand(m.x)}, ${js.id(ctx.freshName('v'))}]`),
    )
    const tree = read('a = [fresh(), fresh()]\nb = pair(fresh())')
    assert.equal(print(walk(tree, r)), 'a = [v, v_1]\nb = [v_2, v_3]')
    assert.equal(print(walk(tree, r)), 'a = [v, v_1]\nb = [v_2, v_3]')
  })
})

// Acceptance: one rule set per language, written as a client of the library
// would write it. ESTree comes from `read`; cljs, Lisp and Lua have no reader
// or printer here, so their families are defined below, trees are built by
// hand and a few lines print them back for the assertions.
//
// Registries are global: every prefix here is this file's own.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import ts from 'typescript'
import { build, defineFamily, define, edit, emit, js, match, matchPattern, originOf, p, read, rule, rules, toNode, walk } from '../index.ts'
import type { Ctx, Node } from '../index.ts'
import { candidates } from '../quote/rule.ts'

const print = (n: Node | null): string => emit(n as Node).trimEnd()

// --- cljs ---

defineFamily('cljs', {
  // `(when c …)` is headed by `when`, `(clojure.core/when c …)` by `clojure.core/when`.
  head(n) {
    const first = n.type === 'cljs/list' ? (n.items as Node[])[0] : undefined
    return first?.type === 'cljs/symbol' ? { node: first, name: symbolName(first) } : undefined
  },
})
define('cljs/list', ['items'])
define('cljs/vector', ['items'])
define('cljs/symbol', [])
define('cljs/number', [])

const symbolName = (s: Node) => (s.ns ? `${s.ns}/${s.name}` : (s.name as string))
const sym = (name: string, ns?: string) => toNode({ type: 'cljs/symbol', ...(ns === undefined ? {} : { ns }), name, children: [] })
const num = (value: number) => toNode({ type: 'cljs/number', value, children: [] })
const list = (...items: Node[]) => toNode({ type: 'cljs/list', items })
const vec = (...items: Node[]) => toNode({ type: 'cljs/vector', items })

/** An S-expression; an embedded ESTree node is printed as `{code}`. */
function sexp(n: Node): string {
  switch (n.type) {
    case 'cljs/list':
      return `(${(n.items as Node[]).map(sexp).join(' ')})`
    case 'cljs/vector':
      return `[${(n.items as Node[]).map(sexp).join(' ')}]`
    case 'cljs/symbol':
      return symbolName(n)
    case 'cljs/number':
      return String(n.value)
    default:
      return `{${code(n)}}`
  }
}

// (when c body…) -> (if c (do body…))
const when = rule(list(sym('when'), p.bind('c'), p.rest('body')), list(sym('if'), p.bind('c'), list(sym('do'), p.rest('body'))))

// (let [n v …] body…) -> ((fn [n…] body…) v…): the pairs of the vector, as two runs.
const letFn = rule(
  list(sym('let'), vec(p.rep(p.group(p.bind('n'), p.bind('v')))), p.rest('body')),
  list(list(sym('fn'), vec(p.rest('n')), p.rest('body')), p.rest('v')),
)

// (= x x) -> true: the same code twice, compared by value.
const selfEqual = rule(list(sym('='), p.bind('x'), p.bind('x')), sym('true'))

const cljs = rules(when, letFn, selfEqual)
const expandCljs = (form: Node) => sexp(walk(form, cljs)!)

describe('acceptance: cljs', () => {
  test('(when c body…) becomes (if c (do body…)), nested ones too', () => {
    assert.equal(expandCljs(list(sym('when'), sym('ok'), list(sym('println'), num(1)), num(2))), '(if ok (do (println 1) 2))')
    assert.equal(expandCljs(list(sym('when'), sym('a'), list(sym('when'), sym('b'), sym('x')))), '(if a (do (if b (do x))))')
    assert.equal(expandCljs(list(sym('when'), sym('a'))), '(if a (do))')
    assert.equal(expandCljs(vec(list(sym('when'), sym('a'), sym('x')))), '[(if a (do x))]')
  })

  test('the rules are looked up by the head symbol', () => {
    assert.deepEqual(candidates(cljs, list(sym('when'), sym('a'))), [when])
    assert.deepEqual(candidates(cljs, list(sym('let'), vec())), [letFn])
    assert.deepEqual(candidates(cljs, list(sym('if'), sym('a'))), [])
    assert.deepEqual(candidates(cljs, vec(sym('when'), sym('a'))), [], 'a vector has no head')
  })

  test('symbols compare by value: ns and name, not identity', () => {
    // Every `sym(...)` call above builds a new symbol: the rules fire on equal ones.
    assert.equal(expandCljs(list(sym('='), sym('a'), sym('a'))), 'true')
    assert.equal(expandCljs(list(sym('='), sym('a', 'str'), sym('a', 'str'))), 'true')
    assert.equal(expandCljs(list(sym('='), list(sym('f'), num(1)), list(sym('f'), num(1)))), 'true', 'whole forms too')
    assert.equal(expandCljs(list(sym('='), sym('a'), sym('b'))), '(= a b)')
    assert.equal(expandCljs(list(sym('='), sym('a', 'str'), sym('a', 'set'))), '(= str/a set/a)')
    assert.equal(expandCljs(list(sym('='), sym('a', 'str'), sym('a'))), '(= str/a a)')
  })

  test('clojure.core/when is not when by plain name', () => {
    const qualified = list(sym('when', 'clojure.core'), sym('a'), sym('x'))
    assert.equal(expandCljs(qualified), '(clojure.core/when a x)')
    assert.deepEqual(candidates(cljs, qualified), [])
    // A pattern that names only `name` takes both.
    const anyWhen = p.node('cljs/symbol', { name: 'when' })
    assert.ok(matchPattern(sym('when', 'clojure.core'), anyWhen))
    assert.ok(matchPattern(sym('when'), anyWhen))
  })

  test('(let [n v …] body…) becomes a call of a fn', () => {
    const form = list(sym('let'), vec(sym('a'), num(1), sym('b'), num(2)), list(sym('+'), sym('a'), sym('b')))
    assert.equal(expandCljs(form), '((fn [a b] (+ a b)) 1 2)')
    assert.equal(expandCljs(list(sym('let'), vec(), num(1))), '((fn [] 1))')
    // The body is expanded too.
    assert.equal(expandCljs(list(sym('let'), vec(sym('a'), num(1)), list(sym('when'), sym('a'), sym('a')))), '((fn [a] (if a (do a))) 1)')
  })

  test('let: an odd binding vector, or a list instead of a vector, is left alone', () => {
    assert.equal(expandCljs(list(sym('let'), vec(sym('a'), num(1), sym('b')), sym('a'))), '(let [a 1 b] a)')
    assert.equal(expandCljs(list(sym('let'), list(sym('a'), num(1)), sym('a'))), '(let (a 1) a)')
  })
})

// --- Lisp ---

defineFamily('lisp', {
  head(n) {
    const first = n.type === 'lisp/list' ? (n.items as Node[])[0] : undefined
    return first?.type === 'lisp/symbol' ? { node: first, name: first.name as string } : undefined
  },
})
define('lisp/list', ['items'])
define('lisp/symbol', [])
define('lisp/number', [])

const L = (...items: Node[]) => toNode({ type: 'lisp/list', items })
const S = (name: string) => toNode({ type: 'lisp/symbol', name, children: [] })
const N = (value: number) => toNode({ type: 'lisp/number', value, children: [] })
const lisp = (n: Node): string =>
  n.type === 'lisp/list' ? `(${(n.items as Node[]).map(lisp).join(' ')})` : String(n.type === 'lisp/number' ? n.value : n.name)

// (and) -> true, (and a) -> a, (and a rest…) -> (if a (and rest…) false).
// The order matters: `(and a)` also fits the third, with no rest.
const andEmpty = rule(L(S('and')), S('true'))
const andOne = rule(L(S('and'), p.bind('a')), p.bind('a'))
const andMore = rule(L(S('and'), p.bind('a'), p.rest('rest')), L(S('if'), p.bind('a'), L(S('and'), p.rest('rest')), S('false')))

// Nothing expands inside (quote …): the walk doesn't go in.
const quote = rule(L(S('quote'), p.any()), (_, __, ctx) => ctx.skip())

const and = rules(quote, andEmpty, andOne, andMore)
const expandLisp = (form: Node, set = and) => lisp(walk(form, set)!)

describe('acceptance: Lisp', () => {
  test('and, by recursion', () => {
    assert.equal(expandLisp(L(S('and'))), 'true')
    assert.equal(expandLisp(L(S('and'), S('x'))), 'x')
    assert.equal(expandLisp(L(S('and'), S('a'), S('b'))), '(if a b false)')
    assert.equal(expandLisp(L(S('and'), S('a'), S('b'), S('c'))), '(if a (if b c false) false)')
  })

  test('the order of the rules matters', () => {
    assert.equal(expandLisp(L(S('and'), S('x')), rules(andEmpty, andMore, andOne)), '(if x true false)')
  })

  test('expansion repeats at the node until no rule fires', () => {
    // (and (and a b)) -> (and a b) -> (if a (and b) false); then (and b) inside.
    assert.equal(expandLisp(L(S('and'), L(S('and'), S('a'), S('b')))), '(if a b false)')
    assert.equal(expandLisp(L(S('f'), L(S('and'), L(S('and')), L(S('and'), S('y'))))), '(f (if true y false))')
  })

  test('numbers are atoms compared by value', () => {
    assert.equal(expandLisp(L(S('and'), N(1), N(2))), '(if 1 2 false)')
    assert.ok(matchPattern(L(S('and'), N(1)), L(S('and'), N(1))), 'two numbers built apart')
    assert.equal(matchPattern(L(S('and'), N(2)), L(S('and'), N(1))), null)
    const twice = L(p.bind('x'), p.bind('x'))
    assert.ok(matchPattern(L(N(1), N(1)), twice))
    assert.equal(matchPattern(L(N(1), N(2)), twice), null)
    assert.equal(matchPattern(L(N(1), S('1')), twice), null, 'a number is not a symbol')
  })

  test('nothing expands inside (quote …)', () => {
    assert.equal(expandLisp(L(S('quote'), L(S('and'), S('a')))), '(quote (and a))')
    assert.equal(expandLisp(L(S('and'), L(S('quote'), L(S('and'))), L(S('and'), S('x')))), '(if (quote (and)) x false)')
    // An expansion that turns into a quote is not entered either.
    assert.equal(expandLisp(L(S('and'), L(S('quote'), L(S('and'))))), '(quote (and))')
  })
})

// --- JS: optional chaining lowered to plain JS ---

// A temporary is asked for with `ctx.send(TEMPS, name)` where it is used, and
// declared by the nearest function or module around it, which expands its code
// inside `ctx.receive(TEMPS, …)` and so learns the names.
const TEMPS = Symbol('temporaries')

/** A fresh name for a temporary, declared at the top of the enclosing function or module. */
function temp(ctx: Ctx): Node {
  const name = ctx.freshName('tmp')
  if (!ctx.send(TEMPS, name)) throw new Error(`no function or module around ${name} to declare it`)
  return js.id(name)
}

/** The module and each function declare, at their top, the temporaries their code asked for. */
const declareTemps = rule(
  // `ctx.expand` below walks this very node again: then it is not one to declare in.
  p.guard(p.node(['Program', 'Function']), (_, node, ctx) => ctx.env?.declaring !== node),
  (_, node, ctx) => {
    const [out, names] = ctx.receive(TEMPS, () => ctx.expand(node, { declaring: node }))
    return names.length ? declare(out!, names) : out
  },
)

function declare(scope: Node, names: string[]): Node {
  const lets = names.map((name) => js.stmt`let ${name}`)
  return edit(scope, (d: any) => {
    if (d.type === 'Program') d.body = [...lets, ...d.body]
    else if (d.body.type === 'BlockStatement') d.body.body = [...lets, ...d.body.body]
    else d.body = js.stmt`{ ${lets}; return ${scope.body} }` // `() => x` gets a block
  })
}

/** Has an optional link: `a?.b`, `a?.b.c`, `f?.()`; `(a?.b).c` is a chain of its own. */
function optional(e: Node): boolean {
  for (let n: Node | null = e; n?.type === 'MemberExpression' || n?.type === 'CallExpression'; n = (n.object ?? n.callee) as Node) {
    if (n.optional) return true
  }
  return false
}

/** `e` as a chain of its own, if it has optional links: `a?.b` taken out of `a?.b?.c`. */
const chain = (e: Node) => (optional(e) ? toNode({ type: 'ChainExpression', expression: e }) : e)
const inChain = (e: Node) => p.node('ChainExpression', { expression: e })

const plain = (e: Node) => e.type === 'Identifier' || e.type === 'ThisExpression'

/** `o == null ? void 0 : then(o)`, `o` evaluated once: a plain name as is, anything else in a temporary. */
function ifPresent(o: Node, ctx: Ctx, then: (o: Node) => Node): Node {
  if (plain(o)) return js`${o} == null ? void 0 : ${then(o)}`
  const t = temp(ctx)
  return js`(${t} = ${chain(o)}) == null ? void 0 : ${then(t)}`
}

/** `get(o)?.(...args)` with `this` = o: `o` and the method each evaluated once. */
function callMethod(o: Node, get: (o: Node) => Node, args: Node[], ctx: Ctx): Node {
  const self = plain(o) ? o : temp(ctx)
  const fn = temp(ctx)
  const object = self === o ? o : js`${self} = ${chain(o)}`
  return js`(${fn} = ${get(object)}) == null ? void 0 : ${fn}.call(${self}, ${args})`
}

/** A link on top of chain `y`: `y` lowered first (`c ? void 0 : v`), then the link goes on its value `v`. */
function onChain(y: Node, ctx: Ctx, link: (v: Node) => Node): Node {
  const lowered = match(ctx.expand(chain(y))!, js`$c ? void 0 : $v`)!
  return js`${lowered.c} ? void 0 : ${link(lowered.v)}`
}

const optionalChaining = rules(
  declareTemps,
  // An optional link on top: a?.b, a?.[k], f()?.b, a?.b?.c (the chain under it is lowered on its own).
  rule(js`$o?.$p`, (m, _, ctx) => ifPresent(m.o, ctx, (o) => js`${o}.${m.p}`)),
  rule(js`$o?.[$k]`, (m, _, ctx) => ifPresent(m.o, ctx, (o) => js`${o}[${m.k}]`)),
  // An optional call of a method keeps `this`: o.m?.(x), o[k]?.(x); in o?.m?.(x), `o` is tested first.
  rule(js`$o.$m?.($$args)`, (m, _, ctx) => callMethod(m.o, (o) => js`${o}.${m.m}`, m.args, ctx)),
  rule(js`$o[$k]?.($$args)`, (m, _, ctx) => callMethod(m.o, (o) => js`${o}[${m.k}]`, m.args, ctx)),
  rule(js`$o?.$m?.($$args)`, (m, _, ctx) => ifPresent(m.o, ctx, (o) => js`${o}.${m.m}?.(${m.args})`)),
  rule(js`$o?.[$k]?.($$args)`, (m, _, ctx) => ifPresent(m.o, ctx, (o) => js`${o}[${m.k}]?.(${m.args})`)),
  // Any other optional call: f?.(x), f()?.(x).
  rule(p.guard(js`$f?.($$args)`, (m) => m.f.type !== 'MemberExpression'), (m, _, ctx) => ifPresent(m.f, ctx, (f) => js`${f}(${m.args})`)),
  // A plain link on top of a chain: a?.b.c, a?.b[k], a?.b.c(); a?.b() keeps `this`, since the call is on a.b.
  rule(inChain(js`$y.$p`), (m, _, ctx) => onChain(m.y, ctx, (v) => js`${v}.${m.p}`)),
  rule(inChain(js`$y[$k]`), (m, _, ctx) => onChain(m.y, ctx, (v) => js`${v}[${m.k}]`)),
  rule(inChain(js`$y($$args)`), (m, _, ctx) => onChain(m.y, ctx, (v) => js`${v}(${m.args})`)),
)

const lowerChains = (src: string) => print(walk(read(src), optionalChaining))

/** `return expr` in a function of a, k, f, g, o; native, and lowered. */
function both(expr: string) {
  const src = `function run(a, k, f, g, o) { return ${expr} }`
  const code = lowerChains(src)
  const compile = (body: string) => new globalThis.Function(`${body}\nreturn run`)() as (...args: unknown[]) => unknown
  return { code, native: compile(src), lowered: compile(code) }
}

/** What a call gives: its value, or the kind of error it throws. */
function outcome(fn: (...args: unknown[]) => unknown, args: unknown[]) {
  try {
    return { value: fn(...args) }
  } catch (e) {
    return { error: (e as Error).constructor.name }
  }
}

describe('acceptance: JS optional chaining', () => {
  test('the forms, lowered', () => {
    assert.equal(lowerChains('x = a?.b'), 'x = a == null ? void 0 : a.b')
    assert.equal(lowerChains('x = a?.b.c'), 'x = a == null ? void 0 : a.b.c')
    assert.equal(lowerChains('x = a?.[k]'), 'x = a == null ? void 0 : a[k]')
    assert.equal(lowerChains('x = a?.b()'), 'x = a == null ? void 0 : a.b()')
    assert.equal(lowerChains('x = this?.b'), 'x = this == null ? void 0 : this.b')
    assert.equal(lowerChains('x = f?.(1)'), 'x = f == null ? void 0 : f(1)')
  })

  test('a base that is not a plain name is evaluated once, through a temporary', () => {
    assert.equal(lowerChains('x = f()?.b'), 'let tmp\nx = (tmp = f()) == null ? void 0 : tmp.b')
    assert.equal(lowerChains('x = g().h?.i()'), 'let tmp\nx = (tmp = g().h) == null ? void 0 : tmp.i()')
    assert.equal(lowerChains('x = o.m?.(1)'), 'let tmp\nx = (tmp = o.m) == null ? void 0 : tmp.call(o, 1)')
    assert.equal(lowerChains('x = f().m?.(1)'), 'let tmp\nlet tmp_1\nx = (tmp_1 = (tmp = f()).m) == null ? void 0 : tmp_1.call(tmp, 1)')
    assert.equal(lowerChains('x = a?.m?.(1)'), 'let tmp\nx = a == null ? void 0 : (tmp = a.m) == null ? void 0 : tmp.call(a, 1)')
  })

  test('nested chains', () => {
    assert.equal(lowerChains('x = a?.b?.c'), 'let tmp\nx = (tmp = a == null ? void 0 : a.b) == null ? void 0 : tmp.c')
    assert.equal(lowerChains('x = a?.b.c?.d.e'), 'let tmp\nx = (tmp = a == null ? void 0 : a.b.c) == null ? void 0 : tmp.d.e')
    assert.equal(lowerChains('x = (a?.b).c'), 'x = (a == null ? void 0 : a.b).c', 'parentheses end a chain')
    assert.equal(lowerChains('x = f(a?.b)?.c'), 'let tmp\nx = (tmp = f(a == null ? void 0 : a.b)) == null ? void 0 : tmp.c')
  })

  test('temporaries: fresh names, declared once at the top of the function or module', () => {
    assert.equal(lowerChains('x = f()?.b\ny = f()?.c'), 'let tmp\nlet tmp_1\nx = (tmp = f()) == null ? void 0 : tmp.b\ny = (tmp_1 = f()) == null ? void 0 : tmp_1.c')
    assert.equal(lowerChains('let tmp = 1\nx = f()?.b'), 'let tmp_1\nlet tmp = 1\nx = (tmp_1 = f()) == null ? void 0 : tmp_1.b')
    assert.equal(
      lowerChains('function h() {\n  if (a) return f()?.b\n}'),
      'function h() {\n  let tmp\n  if (a) return (tmp = f()) == null ? void 0 : tmp.b\n}',
    )
    assert.equal(lowerChains('const h = () => f()?.b'), 'const h = () => {\n  let tmp\n  return (tmp = f()) == null ? void 0 : tmp.b\n}')
    assert.equal(
      lowerChains('x = f()?.b\nfunction h() {\n  return () => g()?.c\n}'),
      'let tmp\nx = (tmp = f()) == null ? void 0 : tmp.b\n\nfunction h() {\n  return () => {\n    let tmp_1\n    return (tmp_1 = g()) == null ? void 0 : tmp_1.c\n  }\n}',
      'each function its own',
    )
  })

  test('same results as the native code: null, undefined and real objects', () => {
    const self = { b() { return this } }
    const values = [null, undefined, {}, { b: null }, { b: 0 }, { b: { c: 1 } }, { b: { c: null } }, { b: { c: { d: { e: 2 } } } }, self]
    const chains = ['a?.b', 'a?.b.c', 'a?.[k]', 'a?.b()', 'f()?.b', 'f()?.b.c', 'g().h?.b()', 'a?.b?.c', 'f()?.b?.c', 'a?.b.c?.d.e']
    chains.push('o.m?.(a)', "o['m']?.(a)", 'a?.b?.()', 'f()?.b?.()', 'a?.[k]?.()', 'f?.()', 'f()?.()')
    for (const expr of chains) {
      const { code, native, lowered } = both(expr)
      assert.doesNotMatch(code, /\?\./, expr)
      for (const a of values) {
        const o = { m: a === null ? null : (x: unknown) => x }
        const args = [a, 'b', () => a, () => ({ h: a }), o]
        assert.deepEqual(outcome(lowered, args), outcome(native, args), `${expr} with a = ${JSON.stringify(a)}`)
      }
    }
  })

  test('this is kept for method calls', () => {
    const self = { b() { return this } }
    assert.equal(both('a?.b()').lowered(self), self)
    assert.equal(both('g().h?.b()').lowered(null, null, null, () => ({ h: self })), self)
    const o = { m() { return this } }
    assert.equal(both('o.m?.()').lowered(null, null, null, null, o), o)
    assert.equal(both('f().m?.()').lowered(null, null, () => o), o)
  })

  test('the base is evaluated once (counted)', () => {
    for (const expr of ['f()?.b', 'f()?.b.c', 'f()?.b?.c', 'f().m?.()', 'g().h?.b()']) {
      const { native, lowered } = both(expr)
      for (const run of [native, lowered]) {
        let calls = 0
        const value = { b: { c: 1 }, m() {}, h: { b() {} } }
        run(null, 'b', () => (calls++, value), () => (calls++, value))
        assert.equal(calls, 1, expr)
      }
    }
  })
})

// --- TS: type erasure ---

const eraseTypes = rules(
  // Declarations of types only (an index signature in a class too), and imports and exports of types: gone.
  rule(p.node(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSIndexSignature']), null),
  rule(p.or(p.node('ImportDeclaration', { importKind: 'type' }), p.node('ExportNamedDeclaration', { exportKind: 'type' })), null),
  rule(p.or(p.node('ImportSpecifier', { importKind: 'type' }), p.node('ExportSpecifier', { exportKind: 'type' })), null),
  rule(p.node(['VariableDeclaration', 'ClassDeclaration', 'PropertyDefinition'], { declare: true }), null),
  // An expression with a type: the expression.
  rule(js`$x as $T`, js`$x`),
  rule(js`$x satisfies $T`, js`$x`),
  rule(js`$x!`, js`$x`),
  // Annotations (variables, parameters, return types, fields), type parameters and
  // arguments, `implements`: emptied wherever they are.
  rule(p.node(['TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSClassImplements']), null),
  // Marks only TS reads: `private x`, `readonly x`, `x?` (a field or a parameter), `x!: T`.
  rule(
    p.or(
      p.node(['PropertyDefinition', 'MethodDefinition'], { accessibility: p.any() }),
      p.node(['PropertyDefinition', 'Identifier'], { optional: true }),
      p.node('PropertyDefinition', { readonly: true }),
      p.node('PropertyDefinition', { definite: true }),
    ),
    (_, node) =>
      edit(node, (d) => {
        delete d.accessibility
        for (const mark of ['optional', 'readonly', 'definite']) if (d[mark]) d[mark] = false
      }),
  ),
)

const erase = (src: string) => print(walk(read(src, { filename: 'x.ts' }), eraseTypes))

/** What is still TS in a tree: TS node types, and the marks above (`a?.b` is JS's `optional`). */
function tsLeft(tree: Node): string[] {
  const found: string[] = []
  walk(tree, (n) => {
    if (n.type.startsWith('TS')) found.push(n.type)
    for (const mark of ['accessibility', 'readonly', 'definite', 'declare']) if (n[mark]) found.push(`${n.type}.${mark}`)
    if (n.optional && /^(Identifier|PropertyDefinition)$/.test(n.type)) found.push(`${n.type}.optional`)
    if (n.importKind === 'type' || n.exportKind === 'type') found.push(`${n.type} of a type`)
  })
  return found
}

/** What the TypeScript compiler says about `code` as a .js file: TS-only syntax there is an error. */
const jsErrors = (code: string) =>
  ts.transpileModule(code, { fileName: 'x.js', reportDiagnostics: true }).diagnostics!.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))

describe('acceptance: TS type erasure', () => {
  test('declarations of types, imports and exports of types', () => {
    const src = [
      "import type { A } from './a.ts'",
      "import { type B, c } from './b.ts'",
      'interface I { x: number }',
      'type T<U> = U[]',
      'export type { A }',
      'export interface J {}',
      'export type V = string',
      'export { type B, c }',
      'declare const d: number',
      'function f(a: string): void',
      'function f(a: any) {}',
    ]
    assert.equal(erase(src.join('\n')), "import { c } from './b.ts'\nexport { c }\n\nfunction f(a) {}")
  })

  test('expressions with types', () => {
    assert.equal(erase('x = y as T'), 'x = y')
    assert.equal(erase('x = y!'), 'x = y')
    assert.equal(erase('x = y satisfies T'), 'x = y')
    assert.equal(erase('x = (y as unknown as T).z!.w'), 'x = y.z.w')
    assert.equal(erase('y!'), 'y', 'an expression statement')
    assert.equal(erase('const c = { a: 1 } as const'), 'const c = { a: 1 }')
  })

  test('annotations on variables, parameters and return types; optional parameters', () => {
    assert.equal(erase('let x: number = 1'), 'let x = 1')
    assert.equal(erase('const { p, q }: O = o'), 'const { p, q } = o')
    assert.equal(erase('function f(a: string, b?: number, ...rest: T[]): R {\n  return a\n}'), 'function f(a, b, ...rest) {\n  return a\n}')
    assert.equal(erase('const g = (a?: T): U => a'), 'const g = (a) => a')
    assert.equal(erase('const h = async <T,>(x: T): Promise<T> => x'), 'const h = async (x) => x')
  })

  test('type arguments on calls and new', () => {
    assert.equal(erase('f<T>(x)'), 'f(x)')
    assert.equal(erase('m = new Map<string, number[]>()'), 'm = new Map()')
    assert.equal(erase('o.get<A, B>(1)'), 'o.get(1)')
  })

  test('a class with typed fields and implements', () => {
    const src = [
      'class Box<T> extends Base<T> implements I, J<T> {',
      '  [key: string]: unknown',
      '  private value?: T',
      '  readonly size: number = 0',
      '  declare tag: string',
      '  item!: T',
      '  static of<U>(x: U): Box<U> { return new Box<U>() }',
      '  public get(): T | undefined { return this.value }',
      '}',
    ]
    const js = [
      'class Box extends Base {',
      '  value',
      '  size = 0',
      '  item',
      '',
      '  static of(x) {',
      '    return new Box()',
      '  }',
      '',
      '  get() {',
      '    return this.value',
      '  }',
      '}',
    ]
    assert.equal(erase(src.join('\n')), js.join('\n'))
  })

  test('the output is plain JS: it re-reads as .js, with nothing TS left', () => {
    const src = [
      "import type { Opts } from './opts.ts'",
      "import { load, type Loader } from './load.ts'",
      'interface Cache { get(key: string): unknown }',
      'export class Store<V> implements Cache {',
      '  private items = new Map<string, V>()',
      '  readonly name: string',
      '  constructor(name: string) { this.name = name }',
      '  get(key: string): V | undefined { return this.items.get(key)! }',
      '}',
      'export function open(opts?: Opts): Store<unknown> {',
      '  const store = new Store<unknown>(opts?.name ?? (load as Loader)())',
      '  return store satisfies Cache',
      '}',
    ].join('\n')
    const out = erase(src)
    const again = read(out, { filename: 'x.js' })
    assert.equal(print(again), out)
    // `read` takes TS syntax in a .js file too: so check the tree, and ask the TypeScript compiler.
    assert.deepEqual(tsLeft(again), [])
    assert.ok(jsErrors(src).length > 0)
    assert.deepEqual(jsErrors(out), [])
  })
})

// --- Lua: a luaparse-shaped AST ---

defineFamily('lua', {
  // `f(x)` alone is a CallStatement around the call.
  unwrap: (n) => (n.type === 'lua/CallStatement' ? (n.expression as Node) : undefined),
  isStatement: (type) => /(Statement|Declaration|Chunk)$/.test(type),
})
define('lua/Chunk', ['body'])
define('lua/LocalStatement', ['variables', 'init'])
define('lua/AssignmentStatement', ['variables', 'init'])
define('lua/CallStatement', ['expression'])
define('lua/ReturnStatement', ['arguments'])
define('lua/DoStatement', ['body'])
define('lua/FunctionDeclaration', ['identifier', 'parameters', 'body']) // isLocal; no identifier: a function expression
define('lua/CallExpression', ['base', 'arguments'])
define('lua/MemberExpression', ['base', 'identifier']) // indexer: '.' or ':'
define('lua/BinaryExpression', ['left', 'right'])
define('lua/Identifier', [])
define('lua/StringLiteral', [])
define('lua/NumericLiteral', [])

const lua = {
  chunk: (...body: Node[]) => toNode({ type: 'lua/Chunk', body }),
  local: (variables: Node[], init: Node[] = []) => toNode({ type: 'lua/LocalStatement', variables, init }),
  assign: (variables: Node[], init: Node[]) => toNode({ type: 'lua/AssignmentStatement', variables, init }),
  run: (expression: Node) => toNode({ type: 'lua/CallStatement', expression }),
  ret: (...args: Node[]) => toNode({ type: 'lua/ReturnStatement', arguments: args }),
  block: (...body: Node[]) => toNode({ type: 'lua/DoStatement', body }),
  fn: (identifier: Node | null, parameters: Node[], body: Node[], isLocal = false) =>
    toNode({ type: 'lua/FunctionDeclaration', identifier, isLocal, parameters, body }),
  call: (base: Node, ...args: Node[]) => toNode({ type: 'lua/CallExpression', base, arguments: args }),
  member: (base: Node, indexer: string, identifier: Node) => toNode({ type: 'lua/MemberExpression', indexer, base, identifier }),
  op: (operator: string, left: Node, right: Node) => toNode({ type: 'lua/BinaryExpression', operator, left, right }),
  id: (name: string) => toNode({ type: 'lua/Identifier', name, children: [] }),
  str: (value: string) => toNode({ type: 'lua/StringLiteral', value, raw: JSON.stringify(value), children: [] }),
  num: (value: number) => toNode({ type: 'lua/NumericLiteral', value, raw: String(value), children: [] }),
}

/** Lua source, one statement per line at the top, inline below. */
function luaCode(n: Node): string {
  const all = (list: unknown, sep = ', ') => (list as Node[]).map(luaCode).join(sep)
  const body = (list: unknown) => ((list as Node[]).length ? ` ${all(list, ' ')} ` : ' ')
  switch (n.type) {
    case 'lua/Chunk':
      return all(n.body, '\n')
    case 'lua/LocalStatement':
      return `local ${all(n.variables)}${(n.init as Node[]).length ? ` = ${all(n.init)}` : ''}`
    case 'lua/AssignmentStatement':
      return `${all(n.variables)} = ${all(n.init)}`
    case 'lua/CallStatement':
      return luaCode(n.expression as Node)
    case 'lua/ReturnStatement':
      return `return ${all(n.arguments)}`
    case 'lua/DoStatement':
      return `do${body(n.body)}end`
    case 'lua/FunctionDeclaration': {
      const name = n.identifier ? ` ${luaCode(n.identifier as Node)}` : ''
      return `${n.isLocal ? 'local ' : ''}function${name}(${all(n.parameters)})${body(n.body)}end`
    }
    case 'lua/CallExpression':
      return `${luaCode(n.base as Node)}(${all(n.arguments)})`
    case 'lua/MemberExpression':
      return `${luaCode(n.base as Node)}${n.indexer}${luaCode(n.identifier as Node)}`
    case 'lua/BinaryExpression':
      return `${luaCode(n.left as Node)} ${n.operator} ${luaCode(n.right as Node)}`
    case 'lua/Identifier':
      return n.name as string
    default:
      return n.raw as string
  }
}

// local function f(…) … end -> local f; f = function(…) … end. One statement
// becomes two, so the rule matches the list of statements around it (in any
// node with a `body` of statements): the runs before and after stay as they are.
const fnName = p.bind('f')
const withLocalFunction = p.node(['lua/Chunk', 'lua/DoStatement', 'lua/FunctionDeclaration'], {
  body: [p.rest('before'), lua.fn(fnName, [p.rest('params')], [p.rest('body')], true), p.rest('after')],
})
const withLocalThenAssign = [
  p.rest('before'),
  lua.local([fnName]),
  lua.assign([fnName], [lua.fn(null, [p.rest('params')], [p.rest('body')])]),
  p.rest('after'),
]
const localFunction = rule(withLocalFunction, (m, block) => edit(block, (d) => void (d.body = build(withLocalThenAssign, m))))

// a:b(args…) -> a.b(a, args…), when `a` is a plain name (anything else would be evaluated twice).
const methodCall = rule(
  lua.call(lua.member(p.guard(p.bind('a'), (m) => m.a.type === 'lua/Identifier'), ':', p.bind('b')), p.rest('args')),
  lua.call(lua.member(p.bind('a'), '.', p.bind('b')), p.bind('a'), p.rest('args')),
)

const luaRules = rules(localFunction, methodCall)
const expandLua = (chunk: Node) => luaCode(walk(chunk, luaRules)!)

describe('acceptance: Lua', () => {
  const { chunk, local, run, ret, block, fn, call, member, op, id, str, num } = lua

  test('local function f becomes local f, then f = function', () => {
    const src = chunk(fn(id('f'), [id('n')], [ret(op('*', id('n'), num(2)))], true), run(call(id('print'), call(id('f'), num(21)))))
    assert.equal(luaCode(src), 'local function f(n) return n * 2 end\nprint(f(21))')
    assert.equal(expandLua(src), 'local f\nf = function(n) return n * 2 end\nprint(f(21))')
  })

  test('every one in a list, and in nested blocks and bodies', () => {
    const src = chunk(
      local([id('x')], [num(1)]),
      fn(id('a'), [], [], true),
      fn(id('b'), [], [fn(id('inner'), [id('y')], [ret(id('y'))], true), ret(id('inner'))], true),
      block(fn(id('c'), [], [], true)),
      fn(id('global'), [], []),
    )
    assert.equal(
      expandLua(src),
      [
        'local x = 1',
        'local a',
        'a = function() end',
        'local b',
        'b = function() local inner inner = function(y) return y end return inner end',
        'do local c c = function() end end',
        'function global() end',
      ].join('\n'),
    )
  })

  test('a:b(args…) becomes a.b(a, args…) when a is a plain name', () => {
    const greet = call(member(id('obj'), ':', id('greet')), str('hi'), id('x'))
    assert.equal(expandLua(chunk(local([id('s')], [greet]))), 'local s = obj.greet(obj, "hi", x)')
    assert.equal(expandLua(chunk(local([id('s')], [call(member(id('obj'), ':', id('size')))]))), 'local s = obj.size(obj)')
    const notPlain = call(member(call(id('get')), ':', id('m')), num(1))
    assert.equal(expandLua(chunk(local([id('s')], [notPlain]))), 'local s = get():m(1)')
    const chained = call(member(call(member(id('a'), ':', id('b')), num(1)), ':', id('c')), num(2))
    assert.equal(expandLua(chunk(local([id('s')], [chained]))), 'local s = a.b(a, 1):c(2)', 'the outer base is a call: left as is')
  })

  test('the call pattern also fires on a call statement, which stays a statement', () => {
    const src = chunk(run(call(member(id('obj'), ':', id('save')))))
    assert.deepEqual(candidates(luaRules, (src.body as Node[])[0]), [methodCall], 'through unwrap')
    const out = walk(src, luaRules)!
    assert.equal(luaCode(out), 'obj.save(obj)')
    const [statement] = out.body as Node[]
    assert.equal(statement.type, 'lua/CallStatement')
    assert.equal((statement.expression as Node).type, 'lua/CallExpression')
  })

  test('both rules in one walk', () => {
    const src = chunk(fn(id('log'), [id('m')], [run(call(member(id('io'), ':', id('write')), id('m')))], true), run(call(id('log'), str('ok'))))
    assert.equal(expandLua(src), 'local log\nlog = function(m) io.write(io, m) end\nlog("ok")')
  })
})

// --- A mixed tree: cljs forms in a JS call, JS expressions in the forms ---

/** Code with nodes of both families: JS by `emit`, with each cljs form in it as its S-expression. */
function code(n: Node): string {
  if (n.type.startsWith('cljs/')) return sexp(n)
  return print(walk(n, (c) => (c.type.startsWith('cljs/') ? js.id(sexp(c)) : undefined)))
}

// One pattern spans both families: a `when` right inside clj(…) whose test is JS
// becomes a JS `&&`; the forms in its body stay cljs.
const jsTest = p.guard(p.bind('c'), (m) => !m.c.type.startsWith('cljs/'))
const cljWhen = js`clj(${list(sym('when'), jsTest, p.rest('body'))})`
const whenInJs = rule(cljWhen, (m) => js`${m.c} && clj(${list(sym('do'), ...m.body)})`)
const inc = rule(js`inc($x)`, js`$x + 1`)

const mixed = rules(whenInJs, when, inc)

describe('acceptance: a mixed tree', () => {
  const inner = list(sym('when'), js`n > 0`, list(sym('log'), js`inc(n)`))
  const ready = js`ready`
  const tree = js`clj(${list(sym('when'), ready, inner)})`

  test('one rule set, rules of both families, one walk', () => {
    assert.equal(code(tree), 'clj((when {ready} (when {n > 0} (log {inc(n)}))))')
    assert.equal(code(walk(tree, mixed)!), 'ready && clj((do (if {n > 0} (do (log {n + 1})))))')
    assert.deepEqual(candidates(mixed, tree), [whenInJs])
    assert.deepEqual(candidates(mixed, inner), [when])
  })

  test('a pattern across the boundary captures the nodes themselves', () => {
    const m = match(tree, cljWhen)!
    assert.equal(m.c, ready, 'JS, inside cljs, inside JS')
    assert.deepEqual(m.body, [inner])
    assert.equal(m.body[0], inner)
    assert.equal(match(js`clj(${list(sym('when'), sym('ok'))})`, cljWhen), null, 'a cljs test')
    assert.equal(code(walk(js`clj(${list(sym('when'), sym('ok'), inner)})`, mixed)!), 'clj((if ok (do (if {n > 0} (do (log {n + 1}))))))')
  })
})

// --- Positions ---

describe('acceptance: positions', () => {
  /** The source text a node came from. */
  const from = (n: Node) => {
    const o = originOf(n)
    return o && o.file.text.slice(o.start, o.end)
  }

  test('an expansion maps to the form it replaces; a capture keeps its own place', () => {
    const ast = read('total = add(price, tax * 2)', { filename: 'http://x/cart.js' })
    const call = (ast.body[0] as any).expression.right as Node
    const out = walk(ast, rule(js`add($a, $b)`, js`$a + $b`))!
    const sum = (out.body as any)[0].expression.right as Node
    assert.equal(print(sum), 'price + tax * 2')
    assert.equal(from(sum), 'add(price, tax * 2)', 'the root of the expansion')
    assert.equal(sum.right, (call.arguments as Node[])[1], 'a capture is the node itself')
    assert.equal(from(sum.right as Node), 'tax * 2')
    assert.equal(from(sum.left as Node), 'price')
  })

  test('the same through the rule sets above', () => {
    const lowered = walk(read('x = f()?.b', { filename: 'x.js' }), optionalChaining)!
    const cond = (lowered.body as any)[1].expression.right as Node
    assert.equal(print(cond), '(tmp = f()) == null ? void 0 : tmp.b')
    assert.equal(from(cond), 'f()?.b')
    assert.equal(from((cond.test as any).left.right), 'f()', 'the captured base')
    // Made from nothing, `let tmp` has no place: a source map puts it at its parent's.
    assert.equal(originOf((lowered.body as Node[])[0]), undefined)

    const erased = walk(read('y = (a + b) as T', { filename: 'x.ts' }), eraseTypes)!
    assert.equal(from((erased.body as any)[0].expression.right), 'a + b')
  })
})

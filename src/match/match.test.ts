import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { defineFamily } from '../ast/family.ts'
import { attrsOf, b, define, make, toNode, type Node } from '../ast/node.ts'
import { originOf, setOrigin } from '../ast/origin.ts'
import { walk } from '../ast/walk.ts'
import { read } from '../read/index.ts'
import { build, matchPattern, p } from './index.ts'

// Registries are global: every prefix here is this file's own.

// A Clojure-like family: forms are nodes with one list slot, atoms are nodes too.
defineFamily('mclj', {})
define('mclj/list', ['items'])
define('mclj/vector', ['items'])
define('mclj/symbol', [])
define('mclj/number', [])
define('mclj/string', [])

const sym = (name: string, ns?: string) => toNode({ type: 'mclj/symbol', ...(ns ? { ns } : {}), name, children: [] })
const num = (value: number) => toNode({ type: 'mclj/number', value, children: [] })
const str = (value: string) => toNode({ type: 'mclj/string', value, children: [] })
const list = (...items: (Node | null)[]) => make('mclj/list', {}, [items])
const vec = (...items: (Node | null)[]) => make('mclj/vector', {}, [items])

// A Lua-like family: a call statement only wraps a call expression.
defineFamily('mlua', {
  unwrap: (n) => (n.type === 'mlua/CallStatement' ? (n.children[0] as Node) : undefined),
  isStatement: (type) => type.endsWith('Statement'),
})
define('mlua/CallStatement', ['call'])
define('mlua/CallExpression', ['callee', 'args'])
define('mlua/Name', [])
define('mlua/Number', [])

const name = (n: string) => toNode({ type: 'mlua/Name', name: n, children: [] })
const call = (callee: Node, ...args: Node[]) => make('mlua/CallExpression', {}, [callee, args])
const stmt = (c: Node) => make('mlua/CallStatement', {}, [c])

const comment = (value: string, kind = 'Block') => make('Comment', { kind, value }, [])
/** `node` with leading comments, as a pattern or a target. */
const lead = (node: Node, ...comments: Node[]) => make(node.type, { ...attrsOf(node), comments }, node.children)
const items = (n: Node) => n.children[0] as Node[]
const names = (ns: Node[]) => ns.map((n) => n.name)

describe('match: pattern kinds', () => {
  test('a plain node is a literal: exact', () => {
    const inc = list(sym('inc'), num(1))
    assert.deepEqual(matchPattern(inc, list(sym('inc'), num(1))), {})
    assert.equal(matchPattern(inc, list(sym('inc'), num(2))), null)
    assert.equal(matchPattern(inc, list(sym('inc'))), null)
    assert.equal(matchPattern(list(sym('inc'), num(1), num(2)), list(sym('inc'), num(1))), null)
  })

  test('bind, any; bind with a pattern', () => {
    const target = list(sym('inc'), num(1))
    const m = matchPattern(target, list(p.any(), p.bind('x')))!
    assert.equal(m.x, items(target)[1], 'the node itself')
    assert.deepEqual(Object.keys(m), ['x'])
    assert.ok(matchPattern(target, list(sym('inc'), p.bind('n', p.node('mclj/number')))))
    assert.equal(matchPattern(target, list(sym('inc'), p.bind('n', p.node('mclj/string')))), null)
    assert.deepEqual(matchPattern(target, list(p.bind('_'), p.any())), {}, '_ captures nothing')
  })

  test('rest: a run, shortest first, the slice of the list', () => {
    const target = list(sym('do'), num(1), num(2), num(3))
    const m = matchPattern(target, list(sym('do'), p.rest('init'), p.bind('last')))!
    assert.deepEqual(m.init, items(target).slice(1, 3))
    assert.equal(m.init[0], items(target)[1])
    assert.equal(m.last.value, 3)
    assert.deepEqual(matchPattern(list(sym('do')), list(sym('do'), p.rest('body'))), { body: [] })
    assert.deepEqual(matchPattern(target, list(sym('do'), p.rest())), {}, 'unnamed: no capture')
    // With `of`: each element matches it.
    assert.equal(matchPattern(target, list(sym('do'), p.rest('ns', p.node('mclj/number'))))!.ns.length, 3)
    assert.equal(matchPattern(list(sym('do'), num(1), str('a')), list(sym('do'), p.rest('ns', p.node('mclj/number')))), null)
  })

  test('rep of a group: pairs in a let vector, captures become arrays', () => {
    const letForm = list(sym('let'), p.bind('bindings', vec(p.rep(p.group(p.bind('n'), p.bind('v'))))), p.rest('body'))
    const target = list(sym('let'), vec(sym('a'), num(1), sym('b'), num(2)), list(sym('+'), sym('a'), sym('b')))
    const m = matchPattern(target, letForm)!
    assert.deepEqual(names(m.n), ['a', 'b'])
    assert.deepEqual(m.v.map((n: Node) => n.value), [1, 2])
    assert.equal(m.body.length, 1)
    assert.equal(matchPattern(list(sym('let'), vec(sym('a'), num(1), sym('b')), sym('a')), letForm), null, 'an odd vector')
    const empty = matchPattern(list(sym('let'), vec()), letForm)!
    assert.deepEqual([empty.n, empty.v, empty.body], [[], [], []], 'no repetitions: empty arrays')
    // Named: the run, as a slice.
    const pairs = matchPattern(vec(sym('a'), num(1)), vec(p.rep(p.group(p.any(), p.any()), { name: 'all' })))!
    assert.equal(pairs.all.length, 2)
  })

  test('rep: min and max; opt', () => {
    const two = vec(p.rep(p.node('mclj/number'), { min: 2, max: 3, name: 'ns' }))
    assert.equal(matchPattern(vec(num(1)), two), null)
    assert.equal(matchPattern(vec(num(1), num(2)), two)!.ns.length, 2)
    assert.equal(matchPattern(vec(num(1), num(2), num(3), num(4)), two), null)
    assert.throws(() => p.rep(p.any(), { min: 2, max: 1 }), /min 2, max 1/)

    // (defn name "doc"? [params] body...)
    const defn = list(sym('defn'), p.bind('name'), p.opt(p.bind('doc', p.node('mclj/string'))), p.bind('params', p.node('mclj/vector')), p.rest('body'))
    const withDoc = matchPattern(list(sym('defn'), sym('f'), str('Does f.'), vec(), num(1)), defn)!
    assert.equal(withDoc.doc.length, 1)
    assert.equal(withDoc.doc[0].value, 'Does f.')
    const without = matchPattern(list(sym('defn'), sym('f'), vec(sym('x')), sym('x')), defn)!
    assert.deepEqual(without.doc, [])
    assert.equal(names(items(without.params))[0], 'x')
    // Outside a list, opt is a slot that may be empty.
    const ifs = p.node('IfStatement', { alternate: p.opt(p.bind('alt')) })
    assert.equal(matchPattern(read('if (a) b()').body[0], ifs)!.alt.length, 0)
    assert.equal(matchPattern(read('if (a) b()\nelse c()').body[0], ifs)!.alt.length, 1)
  })

  test('group outside a rep: its items, in place', () => {
    assert.ok(matchPattern(vec(num(1), num(2), num(3)), vec(num(1), p.group(p.any(), p.any()))))
    assert.equal(matchPattern(vec(num(1), num(2)), vec(num(1), p.group(p.any(), p.any()))), null)
  })

  test('or: on kinds; ordered, no going back to another alternative', () => {
    const atom = p.or(p.node('mclj/number'), p.node('mclj/string'))
    assert.ok(matchPattern(num(1), atom))
    assert.ok(matchPattern(str('a'), atom))
    assert.equal(matchPattern(sym('a'), atom), null)
    assert.ok(matchPattern(str('a'), p.node(['mclj/number', 'mclj/string'])), 'a list of kinds')
    // Captures come from the alternative taken.
    assert.deepEqual(Object.keys(matchPattern(num(1), p.or(p.bind('s', p.node('mclj/string')), p.bind('n')))!), ['n'])
    // `a` is taken by the first alternative; when `x` then disagrees, the second isn't tried.
    const first = list(p.or(p.bind('x', sym('a')), p.bind('y')), p.bind('x'))
    assert.equal(matchPattern(list(sym('a'), sym('b')), first), null)
    assert.ok(matchPattern(list(sym('a'), sym('a')), first))
  })

  test('not; guard with the ctx', () => {
    assert.ok(matchPattern(list(sym('inc'), num(1)), list(sym('inc'), p.not(p.node('mclj/string')))))
    assert.equal(matchPattern(list(sym('inc'), str('a')), list(sym('inc'), p.not(p.node('mclj/string')))), null)
    assert.deepEqual(matchPattern(num(1), p.not(p.bind('x', p.node('mclj/string')))), {}, 'not captures nothing')

    const big = p.guard(p.bind('n', p.node('mclj/number')), (m, node, ctx) => node === m.n && m.n.value > ctx.min)
    const ctx = { min: 2 }
    assert.equal(matchPattern(num(3), big, ctx)!.n.value, 3)
    assert.equal(matchPattern(num(1), big, ctx), null)
  })

  test('pat/node: kind and the named fields only; a literal: everything', () => {
    const target = sym('join', 'str')
    assert.ok(matchPattern(target, p.node('mclj/symbol', { name: 'join' })), 'ns not mentioned')
    assert.equal(matchPattern(target, sym('join')), null, 'a literal: ns counts')
    assert.ok(matchPattern(target, sym('join', 'str')))
    assert.equal(matchPattern(target, p.node('mclj/symbol', { name: 'split' })), null)
    assert.ok(matchPattern(target, p.node(null, { name: 'join' })), 'any kind')
    assert.equal(matchPattern(sym('join'), p.node('mclj/symbol', { ns: 'str' })), null)
    assert.ok(matchPattern(sym('join'), p.node('mclj/symbol', { ns: null })), 'null: absent')

    // Slots: a pattern, a list (with a tail), null for empty.
    const callee = (c: Node) => p.node('CallExpression', { callee: c, arguments: [p.bind('first'), p.rest('more')] })
    const m = matchPattern(read('f(1, 2, 3)').body[0], callee(p.bind('f')))!
    assert.deepEqual([m.f.name, m.first.value, m.more.length], ['f', 1, 2])
    assert.equal(matchPattern(read('f()').body[0], callee(p.any())), null)
    assert.ok(matchPattern(read('if (a) b()').body[0], p.node('IfStatement', { alternate: null })))
    assert.equal(matchPattern(read('if (a) b()\nelse c()').body[0], p.node('IfStatement', { alternate: null })), null)
    // A group of kinds.
    assert.ok(matchPattern(read('(x) => x').body[0], p.node('Function')))
    assert.equal(matchPattern(read('class A {}').body[0], p.node('Function')), null)
  })

  test('attributes: captured as values; or and not on values', () => {
    const op = p.node('BinaryExpression', { operator: p.bind('op'), left: p.bind('l') })
    const m = matchPattern(read('a + 1').body[0], op)!
    assert.deepEqual([m.op, m.l.name], ['+', 'a'], 'the statement around it is unwrapped')
    const additive = p.node('BinaryExpression', { operator: p.or('+', '-') })
    assert.ok(matchPattern(read('a - 1').body[0], additive))
    assert.equal(matchPattern(read('a * 1').body[0], additive), null)
    assert.ok(matchPattern(read('a * 1').body[0], p.node('BinaryExpression', { operator: p.not('+') })))
    const same = p.node('BinaryExpression', { left: p.node(null, { operator: p.bind('op') }), operator: p.bind('op') })
    assert.ok(matchPattern(read('a + b + c').body[0], same), 'a repeated name compares values')
    assert.equal(matchPattern(read('a * b + c').body[0], same), null)
  })

  test('symbols compare by value, not by reference', () => {
    assert.ok(matchPattern(sym('a', 'ns'), sym('a', 'ns')), 'two separately built symbols')
    const twice = list(p.bind('x'), p.bind('x'))
    assert.ok(matchPattern(list(sym('a', 'ns'), sym('a', 'ns')), twice))
    assert.equal(matchPattern(list(sym('a', 'ns'), sym('a', 'other')), twice), null)
    assert.equal(matchPattern(list(sym('a'), sym('b')), twice), null)
    assert.ok(matchPattern(list(vec(sym('a'), num(1)), vec(sym('a'), num(1))), twice), 'whole forms too')
  })

  test('a list is not a vector', () => {
    assert.equal(matchPattern(list(sym('a')), vec(p.rest())), null)
    assert.equal(matchPattern(vec(sym('a')), list(p.rest())), null)
    assert.ok(matchPattern(vec(sym('a')), p.node(['mclj/list', 'mclj/vector'])))
  })

  test('an expression pattern matches the statement that wraps it', () => {
    const target = stmt(call(name('log'), num(1)))
    assert.equal(matchPattern(target, call(p.bind('f'), p.rest('args')))!.f.name, 'log')
    assert.ok(matchPattern(target, p.node('mlua/CallExpression', { callee: p.node(null, { name: 'log' }) })))
    assert.equal(matchPattern(target, p.bind('s'))!.s, target, 'bind takes the statement itself')
    assert.equal(matchPattern(target, p.bind('s', call(p.any(), p.rest())))!.s, target)
    assert.equal(matchPattern(target, p.node(null, { callee: p.any() })), null, 'any kind: the statement, which has no callee')
  })

  test('a mixed tree: an S-expression in an ESTree call, and the reverse', () => {
    const inner = list(sym('inc'), num(1))
    const target = b.CallExpression({ callee: b.Identifier({ name: 'f' }), arguments: [inner], optional: false })
    const m = matchPattern(target, p.node('CallExpression', { callee: p.bind('f'), arguments: [list(sym('inc'), p.bind('n'))] }))!
    assert.deepEqual([m.f.name, m.n.value], ['f', 1])
    const literal = matchPattern(target, b.CallExpression({ callee: p.bind('f'), arguments: [p.bind('form', list(p.rest()))], optional: false }))!
    assert.equal(literal.form, inner)

    const sum = (read('a + 1').body[0] as any).expression as Node
    const form = list(sym('js*'), sum)
    const r = matchPattern(form, list(sym('js*'), p.node('BinaryExpression', { operator: p.bind('op'), right: p.bind('r') })))!
    assert.deepEqual([r.op, r.r.value], ['+', 1])
    assert.equal(matchPattern(form, list(sym('js*'), p.node('CallExpression'))), null)
  })
})

describe('match: comments', () => {
  test('a pat/ node may carry comments: they are required in front of the target', () => {
    const pure = comment(' @pure ')
    const pattern = vec(lead(p.bind('x'), comment('@pure')))
    assert.ok(matchPattern(vec(pure, num(1)), pattern), 'a sibling in front')
    assert.ok(matchPattern(vec(lead(num(1), pure)), pattern), 'a leading comment')
    assert.equal(matchPattern(vec(num(1)), pattern), null)
    assert.equal(matchPattern(vec(comment('other'), num(1)), pattern), null)
    assert.ok(matchPattern(lead(sym('a'), pure), lead(p.node('mclj/symbol'), comment('@pure'))))
    assert.equal(matchPattern(sym('a'), lead(p.node('mclj/symbol'), comment('@pure'))), null)
  })

  test('comment variables, as siblings and in comments', () => {
    const m = matchPattern(vec(comment('a'), comment('* doc '), num(1)), vec(p.comment('cs', { seq: true }), p.bind('x')))!
    assert.deepEqual(m.cs.map((c: Node) => c.value), ['a', '* doc '])
    assert.equal(matchPattern(vec(comment('a'), comment('* doc '), num(1)), vec(p.comment('d', { doc: true }), p.any()))!.d.value, '* doc ')
    assert.equal(matchPattern(lead(num(1), comment('hi')), toNode({ type: 'pat/any', comments: [p.comment('c')], children: [] }))!.c.value, 'hi')
    // In a repetition, one entry per repetition.
    const each = matchPattern(vec(comment('a'), num(1), comment('b'), num(2)), vec(p.rep(p.group(p.comment('c'), p.bind('n')))))!
    assert.deepEqual(each.c.map((c: Node) => c.value), ['a', 'b'])
  })

  test('not: no such comment here', () => {
    const noPure = p.not(lead(p.any(), comment('@__PURE__')))
    assert.ok(matchPattern(read('x = f()').body[0], p.node('AssignmentExpression', { right: noPure })))
    assert.equal(matchPattern(read('x = /* @__PURE__ */ f()').body[0], p.node('AssignmentExpression', { right: noPure })), null)
  })

  test('a run takes the comments of its elements', () => {
    const target = vec(num(1), comment('c'), num(2))
    const m = matchPattern(target, vec(p.rest('all')))!
    assert.equal(m.all.length, 3)
    const split = matchPattern(target, vec(p.rest('init'), p.bind('last')))!
    assert.equal(split.init.length, 1, 'the comment in front of the last is its own')
  })
})

describe('build', () => {
  const when = list(sym('when'), p.bind('c'), p.rest('body'))
  const ifDo = list(sym('if'), p.bind('c'), list(sym('do'), p.rest('body')))

  test('binds are replaced, runs spliced; captures go in as they are', () => {
    const src = read('x', { filename: 'http://x/m.js' })
    const c = (src.body[0] as any).expression as Node
    assert.ok(originOf(c))
    const target = list(sym('when'), c, num(1), num(2))
    const m = matchPattern(target, when)!
    const out = build(ifDo, m) as Node
    assert.equal(items(out)[1], c, 'the same node')
    assert.equal(originOf(items(out)[1]), originOf(c), 'with its origin')
    assert.deepEqual(items(items(out)[2]).map((n) => n.value ?? n.name), ['do', 1, 2])
    assert.equal(items(items(out)[2])[1], items(target)[2])
  })

  test('untouched subtrees are shared; a list template', () => {
    const fixed = list(sym('quote'), sym('x'))
    const template = list(sym('if'), p.bind('c'), fixed)
    const out = build(template, { c: num(1) }) as Node
    assert.equal(items(out)[0], items(template)[0])
    assert.equal(items(out)[2], fixed)
    assert.equal(build(fixed, {}), fixed)
    const many = build([p.rest('xs'), num(9)], { xs: [num(1), num(2)] }) as Node[]
    assert.deepEqual(many.map((n) => n.value), [1, 2, 9])
    const origin = { file: { url: 'u', text: '(a)' }, start: 0, end: 3 }
    const t = list(p.bind('c'))
    setOrigin(t, origin)
    assert.equal(originOf(build(t, { c: num(1) }) as Node), origin, 'a copied template node keeps its origin')
  })

  test('comments: a pat/comment puts the captured ones', () => {
    const m = matchPattern(vec(comment('a'), num(1)), vec(p.comment('c'), p.bind('x')))!
    const out = build(vec(p.bind('x'), p.comment('c'), num(2)), m) as Node
    assert.deepEqual(items(out).map((n) => n.type), ['mclj/number', 'Comment', 'mclj/number'])
    assert.equal(build(p.bind('x'), m), m.x, 'a bind is its capture')
    const leading = build(lead(p.bind('x'), p.comment('c')), m) as Node
    assert.deepEqual([leading.value, (leading.comments as Node[]).map((c) => c.value)], [1, ['a']], 'with comments, a copy')
    assert.ok(!('comments' in m.x))
    const onNode = build(lead(sym('y'), p.comment('c')), m) as Node
    assert.deepEqual((onNode.comments as Node[]).map((c) => c.value), ['a'])
  })

  test('mistakes are errors that name the capture', () => {
    assert.throws(() => build(list(p.bind('nope')), {}), /"nope" is not captured/)
    assert.throws(() => build(list(p.bind('xs')), { xs: [num(1)] }), /"xs" is a list: splice it with p.rest/)
    assert.throws(() => build(list(p.bind('op')), { op: '+' }), /"op" is a string, not a node/)
    assert.throws(() => build(make('mclj/wrap', {}, [p.rest('xs')]), { xs: [] }), /run "xs" stands where a single node goes/)
    assert.throws(() => build(list(p.any()), {}), /a pat\/any can't be built/)
  })

  test('a rule at the low level: walk + matchPattern + build', () => {
    const tree = list(sym('do'), list(sym('when'), sym('a'), num(1)), vec(list(sym('when'), sym('b'))))
    const out = walk(tree, (node) => {
      const m = matchPattern(node, when)
      if (m) return build(ifDo, m) as Node
    })!
    const flat = (n: Node): unknown => (n.type === 'mclj/symbol' ? n.name : n.type === 'mclj/number' ? n.value : items(n).map(flat))
    assert.deepEqual(flat(out), ['do', ['if', 'a', ['do', 1]], [['if', 'b', ['do']]]])
  })
})

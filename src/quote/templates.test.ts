// Rule templates with core pattern nodes: `pat/` nodes alone (any family), or
// mixed with the `$` variables of the `js` sugar.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit } from '../emit/index.ts'
import { defineFamily } from '../ast/family.ts'
import { attrsOf, define, make, toNode, type Node } from '../ast/node.ts'
import { walk } from '../ast/walk.ts'
import { build } from '../match/build.ts'
import { p } from '../match/pat.ts'
import { read } from '../read/index.ts'
import { js, rule, rules, substitute } from './index.ts'

// Registries are global: every prefix here is this file's own.

defineFamily('tpl', {
  head(n) {
    const first = n.type === 'tpl/list' ? (n.items as Node[])[0] : undefined
    return first?.type === 'tpl/sym' ? { node: first, name: first.name as string } : undefined
  },
})
define('tpl/list', ['items'])
define('tpl/sym', [])

const list = (...items: Node[]) => toNode({ type: 'tpl/list', items })
const sym = (name: string) => toNode({ type: 'tpl/sym', name, children: [] })

/** An S-expression; an embedded ESTree node is printed as `{code}`. */
const sexp = (n: Node): string =>
  n.type === 'tpl/list' ? `(${(n.items as Node[]).map(sexp).join(' ')})` : n.type === 'tpl/sym' ? (n.name as string) : `{${code(n)}}`

/** JS by `emit`, with each form in it as its S-expression. */
function code(n: Node): string {
  if (n.type.startsWith('tpl/')) return sexp(n)
  return emit(walk(n, (c) => (c.type.startsWith('tpl/') ? js.id(sexp(c)) : undefined))!).trimEnd()
}

describe('templates with pat/ nodes', () => {
  test('a template of core nodes, for a family without the js sugar', () => {
    const when = rule(list(sym('when'), p.bind('c'), p.rest('body')), list(sym('if'), p.bind('c'), list(sym('do'), p.rest('body'))))
    const ok = sym('ok')
    const out = walk(list(sym('when'), ok, sym('a'), list(sym('when'), sym('b'), sym('c'))), when)!
    assert.equal(sexp(out), '(if ok (do a (if b (do c))))')
    assert.equal((out.items as Node[])[1], ok, 'a capture is the node itself')
    assert.equal(sexp(walk(list(sym('when'), sym('ok')), when)!), '(if ok (do))', 'an empty run')
  })

  test('$ variables and pat/ nodes in one template', () => {
    const pattern = js`clj(${list(sym('when'), p.bind('c'), p.rest('body'))})`
    // `$c` is filled by substitute, the pat/ nodes in the hand-built form by build.
    const whenInJs = rule(pattern, js`$c && clj(${list(sym('do'), p.bind('c'), p.rest('body'))})`)
    const ready = js`ready`
    const out = walk(js`clj(${list(sym('when'), ready, sym('x'), sym('y'))})`, whenInJs)!
    assert.equal(code(out), 'ready && clj((do {ready} x y))')
    assert.equal(out.left, ready)
    const form = ((out.right as Node).arguments as Node[])[0]
    assert.equal((form.items as Node[])[1], ready, 'the same capture in both forms')
  })

  test('a $ variable inside a hand-built form, a pat/ node inside JS', () => {
    const r = rules(
      rule(js`twice($x)`, list(sym('do'), js`$x`, js`$x`)),
      rule(js`swap($a, $b)`, js`[${p.bind('b')}, $a]`),
    )
    assert.equal(code(walk(read('y = twice(f(1))'), r)!), 'y = (do {f(1)} {f(1)})')
    assert.equal(code(walk(read('y = swap(1, g())'), r)!), 'y = [g(), 1]')
  })

  test('a pat/comment in leading comments puts the captured comments', () => {
    const done = js`done()`
    const template = make(done.type, { ...attrsOf(done), comments: [p.comment('c')] }, done.children)
    const r = rule(js`/* $c */ run()`, template)
    assert.equal(code(walk(read('x = /* hello */ run()'), r)!), 'x = /* hello */ done()')
  })

  test('a capture goes in as it is: build does not look into what substitute put in', () => {
    // A tree that holds a pattern (code about patterns): `held` is code here.
    const held = p.bind('zzz')
    const one = js`1`
    const target = js`f(${held}, ${one})`
    const out = walk(target, rule(js`f($x, $y)`, js`g($x, ${p.bind('y')})`))!
    const [x, y] = out.arguments as Node[]
    assert.equal(x, held)
    assert.equal(y, one)
    const plain = walk(target, rule(js`f($x, $y)`, js`g($x)`))!
    assert.equal((plain.arguments as Node[])[0], held, 'nor with no pat/ node in the template')
  })

  test('nor does substitute look into what build put in', () => {
    // `$scope` in the code is a name, not a variable of the template.
    const r = rule(js`wrap($a, $b)`, js`[$a, ${p.bind('b')}]`)
    assert.equal(code(walk(read('y = wrap(x, $scope.y)'), r)!), 'y = [x, $scope.y]')
  })

  test('a pat/ node build cannot fill is its TypeError', () => {
    assert.throws(() => walk(read('f(1)'), rule(js`f($x)`, js`g(${p.any()})`)), /build: a pat\/any can't be built/)
    assert.throws(() => walk(read('f(1)'), rule(js`f($x)`, js`g(${p.bind('nope')})`)), /build: "nope" is not captured/)
    assert.throws(() => walk(read('f(1, 2)'), rule(js`f($$xs)`, p.rest('xs'))), /build: run "xs" stands where a single node goes/)
  })
})

describe('build and substitute: one node in, one node out', () => {
  test('a node template gives a node, a list a list (no casts)', () => {
    const a = sym('a')
    const one: Node = build(list(p.bind('x')), { x: a })
    const many: Node[] = build([p.rest('xs'), sym('z')], { xs: [a, a] })
    assert.equal(sexp(one), '(a)')
    assert.deepEqual(many.map(sexp), ['a', 'a', 'z'])
    const sum: Node = substitute(js`$a + 1`, { a: js`n` })
    const body: Node[] = substitute(js.stmts`f($a); g($a)`, { a: js`n` })
    assert.equal(code(sum), 'n + 1')
    assert.deepEqual(body.map(code), ['f(n)', 'g(n)'])
  })

  test('a run at the root of a single template has no list to go in', () => {
    assert.throws(() => build(p.rest('xs'), { xs: [sym('a')] }), /build: run "xs" stands where a single node goes/)
  })
})

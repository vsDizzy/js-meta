import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit } from '../emit/index.ts'
import { walk } from '../ast/walk.ts'
import type { Node } from '../ast/node.ts'
import { read } from '../read/index.ts'
import { p } from '../match/index.ts'
import { js, match, rule, substitute } from './index.ts'

const print = (n: unknown): string => (Array.isArray(n) ? n.map(print).join('\n') : emit(n as never).trimEnd())
const ts = (src: string) => read(src, { filename: 'x.ts' }).body[0] as Node

describe('match: a variable with a type', () => {
  test('$x: $T captures the name with its annotation, and the type', () => {
    const m = match(ts('const a: number = 1'), js`const $x: $T = $v`)!
    assert.equal(print(m.x), 'a: number')
    assert.equal(m.T.type, 'TSNumberKeyword')
    assert.equal(print(m.v), '1')
    assert.equal(match(ts('const a = 1'), js`const $x: $T = $v`), null, 'no annotation, no match')
  })

  test('the annotation must match; $x alone takes any or none', () => {
    assert.ok(match(ts('const a: number = 1'), js`const $x: number = $v`))
    assert.equal(match(ts('const a: string = 1'), js`const $x: number = $v`), null)
    assert.equal(print(match(ts('const a: number = 1'), js`const $x = $v`)!.x), 'a: number')
    assert.ok(match(ts('const a = 1'), js`const $x = $v`))
    const fn = match(ts('function f(a: string, b) {}'), js`function $f($p: $T, $$rest) {}`)!
    assert.deepEqual([print(fn.p), print(fn.T), fn.rest.length], ['a: string', 'string', 1])
  })

  test('$_: $T and $$xs: $T', () => {
    assert.equal(print(match(ts('let a: A'), js`let $_: $T`)!.T), 'A')
    const all = match(ts('function f(a: T, b: T) {}'), js`function $f($$ps: T) {}`)!
    assert.equal(all.ps.length, 2, 'each element of the run has the type')
    assert.equal(match(ts('function f(a: T, b: U) {}'), js`function $f($$ps: T) {}`), null)
  })
})

describe('match: a variable in type position', () => {
  test('$T is any type', () => {
    assert.equal(match(ts('foo as string'), js`$x as $T`)!.T.type, 'TSStringKeyword')
    assert.equal(print(match(ts('foo as Bar<number>'), js`$x as $T`)!.T), 'Bar<number>')
    assert.equal(match(ts('foo as Bar'), js`$x as $T`)!.T.type, 'TSTypeReference')
    assert.equal(print(match(ts('a satisfies { b: 1 }'), js`$x satisfies $T`)!.T), '{ b: 1 }')
    assert.ok(match(ts('type N = string[]'), js`type $N = $T`))
  })

  test('a repeated type must be equal', () => {
    assert.ok(match(ts('let a: A | A'), js`let $x: $T | $T`))
    assert.equal(match(ts('let a: A | B'), js`let $x: $T | $T`), null)
  })

  test('$$Ts in a list of types', () => {
    const u = match(ts('let u: A | B | C[]'), js`let $x: A | $$Ts`)!
    assert.deepEqual(u.Ts.map(print), ['B', 'C[]'])
    const args = match(ts('let m: Map<string, number>'), js`let $x: Map<$K, $$Vs>`)!
    assert.deepEqual([args.K.type, args.Vs.map(print)], ['TSStringKeyword', ['number']])
  })

  test('with type arguments, a $ name is still the name', () => {
    const m = match(ts('let a: Box<number>'), js`let $x: $B<number>`)!
    assert.equal(m.B.type, 'Identifier')
    assert.equal(match(ts('let a: Box<string>'), js`let $x: $B<number>`), null)
  })
})

describe('match: js patterns inside core patterns', () => {
  test('the $ forms are compiled wherever they are', () => {
    const call = p.or(js`f($a)`, js`g($a, $_)`)
    assert.equal(print(match(js`g(1, 2)`, call)!.a), '1')
    assert.equal(match(js`h(1)`, call), null)
    const log = rule(p.node('CallExpression', { callee: js`console.$m` }), js`void 0`)
    assert.equal(print(walk(read('console.log(1)\nx()'), log)), 'void 0\nx()')
  })
})

describe('templates: a hole in type position', () => {
  const string = (match(ts('x as string'), js`$x as $T`) as any).T as Node

  test('a node goes in as it is; a name becomes a reference to it', () => {
    assert.equal(print(js`x as ${string}`), 'x as string')
    assert.equal(print(js`let a: ${js.id('Foo')}`), 'let a: Foo')
    assert.equal(print(js`let a: Map<${string}, ${js.id('V')}>`), 'let a: Map<string, V>')
  })

  test('an array splices into a list of types', () => {
    assert.equal(print(js`let a: A | ${[string, js.id('B')]}`), 'let a: A | string | B')
    assert.equal(print(js`let a: A | ${[]}`), 'let a: A')
  })

  test('mistakes name the hole', () => {
    assert.throws(() => js`x as ${'Foo'}`, /\$\{\} #1 in js`x as \$\{…\}` is a string, not a type node/)
    assert.throws(() => js`x as ${1}`, /is a number, not a type node/)
    assert.throws(() => js`x as ${[string]}`, /is an array, but it stands where a single node goes/)
  })

  test('a replacement puts the captured type', () => {
    const toSatisfies = rule(js`$x as $T`, js`$x satisfies $T`)
    assert.equal(print(walk(ts('foo as Bar<number>'), toSatisfies)), 'foo satisfies Bar<number>')
    assert.equal(print(walk(ts('foo as string'), toSatisfies)), 'foo satisfies string')
    const union = match(ts('let u: A | B | C'), js`let $x: A | $$Ts`)!
    assert.equal(print(substitute(js`type U = Z | $$Ts`, union)), 'type U = Z | B | C')
    assert.throws(() => substitute(js`x as $T`, { T: 'string' }), /\$T in the replacement is a string, not a type node/)
  })
})

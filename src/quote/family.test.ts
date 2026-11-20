import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit } from '../emit/index.ts'
import { defineFamily, familyOf } from '../ast/family.ts'
import { define, toNode, type Node } from '../ast/node.ts'
import { walk } from '../ast/walk.ts'
import { read } from '../read/index.ts'
import { js, match, rule } from './index.ts'

// Registries are global: every prefix here is this file's own.

const print = (n: unknown): string => emit(n as never).trimEnd()
/** A pattern variable inside a foreign node: an ESTree identifier `$a`. */
const v = (name: string) => toNode({ type: 'Identifier', name, children: [[], null] })
const atom = (type: string, attrs: Record<string, unknown>) => toNode({ type, ...attrs, children: [] })

describe('families', () => {
  test('define takes prefixed types; the prefix picks the family', () => {
    define('famt/CallExpression', ['callee', 'arguments'])
    define('famt/Name', [])
    assert.throws(() => define('famt/CallExpression', []), /already defined/)
    const call = toNode({ type: 'famt/CallExpression', callee: atom('famt/Name', { name: 'f' }), arguments: [] })
    assert.equal(call.constructor.name, 'famt/CallExpression')
    assert.equal((call.callee as Node).name, 'f')

    const t = familyOf('famt/CallExpression')
    assert.equal(t.canon('famt/CallExpression'), 'famt/CallExpression', 'a prefix no one defined gets the defaults')
    assert.equal(t.isStatement('famt/IfStatement'), false)
    assert.equal(t.unwrap(call), undefined)
    const es = familyOf('CallExpression')
    assert.equal(es.canon('FunctionDeclaration'), 'FunctionExpression')
    assert.equal(es.isStatement('IfStatement'), true)
    assert.equal(es.unwrap(read('f()').body[0])?.type, 'CallExpression')

    defineFamily('famt2', {})
    assert.throws(() => defineFamily('famt2', {}), /already defined/)
    assert.throws(() => defineFamily('', {}), /already defined/, 'ESTree is the family with no prefix')
  })

  test('every attribute of a foreign atom counts, unless its family says otherwise', () => {
    define('famv/num', [])
    assert.ok(match(atom('famv/num', { value: 1 }), atom('famv/num', { value: 1 })))
    assert.equal(match(atom('famv/num', { value: 2 }), atom('famv/num', { value: 1 })), null)
    assert.equal(match(atom('famv/num', { value: 1, raw: '0x1' }), atom('famv/num', { value: 1, raw: '1' })), null)

    defineFamily('famr', { ignored: ['raw'] })
    define('famr/num', [])
    assert.ok(match(atom('famr/num', { value: 1, raw: '0x1' }), atom('famr/num', { value: 1, raw: '1' })))
    assert.equal(match(atom('famr/num', { value: 2, raw: '2' }), atom('famr/num', { value: 1, raw: '1' })), null)

    // A symbol is equal by name; its namespace alias doesn't matter.
    defineFamily('fams', { equal: { 'fams/sym': (a, b) => a.name === b.name } })
    define('fams/sym', [])
    assert.ok(match(atom('fams/sym', { ns: 'str', name: 'join' }), atom('fams/sym', { ns: 's', name: 'join' })))
    assert.equal(match(atom('fams/sym', { ns: 's', name: 'split' }), atom('fams/sym', { ns: 's', name: 'join' })), null)
  })

  test('declare counts', () => {
    const ts = (src: string) => read(src, { filename: 'x.ts' }).body[0] as Node
    assert.ok(match(ts('declare let x: T'), ts('declare let $x: T')))
    assert.ok(match(ts('let x: T'), ts('let $x: T')))
    assert.equal(match(ts('let x: T'), ts('declare let $x: T')), null)
    assert.equal(match(ts('declare let x: T'), ts('let $x: T')), null)
  })

  test('a foreign statement that wraps an expression: an expression pattern matches it', () => {
    defineFamily('famw', {
      unwrap: (n) => (n.type === 'famw/CallStatement' ? (n.children[0] as Node) : undefined),
      isStatement: (type) => type.endsWith('Statement'),
    })
    define('famw/Block', ['body'])
    define('famw/CallStatement', ['call'])
    define('famw/CallExpression', ['callee', 'args'])
    define('famw/Name', [])
    define('famw/num', [])
    const name = (n: string) => atom('famw/Name', { name: n })
    const num = (n: number) => atom('famw/num', { value: n })
    const call = (callee: Node, args: Node[]) => toNode({ type: 'famw/CallExpression', children: [callee, args] })
    const stmt = (c: Node) => toNode({ type: 'famw/CallStatement', children: [c] })

    const target = stmt(call(name('log'), [num(1), num(2)]))
    const m = match(target, call(v('$f'), [v('$$args')]))!
    assert.equal(m.f.name, 'log')
    assert.deepEqual(m.args.map((n: Node) => n.value), [1, 2])
    assert.ok(match(target, stmt(call(v('$f'), [v('$$_')]))), 'a statement pattern matches the statement')
    assert.equal(match(target, toNode({ type: 'famw/ReturnStatement', children: [] })), null)

    const block = toNode({ type: 'famw/Block', children: [[target, stmt(call(name('run'), []))]] })
    const out = walk(block, rule(call(name('log'), [v('$$_')]), null))!
    assert.deepEqual((out.children[0] as Node[]).map((s) => ((s.children[0] as Node).children[0] as Node).name), ['run'])
  })

  test('canon: types of one family, or of two, that match each other', () => {
    defineFamily('famc', { canon: (type) => (type === 'famc/defn-' ? 'famc/defn' : type) })
    defineFamily('famd', { canon: (type) => (type === 'famd/defn' ? 'famc/defn' : type) })
    define('famc/defn', ['name', 'body'])
    define('famc/defn-', ['name', 'body'])
    define('famc/def', ['name', 'body'])
    define('famd/defn', ['name', 'body'])
    define('famc/sym', [])
    const defn = (type: string, name: Node) => toNode({ type, children: [name, []] })
    const sym = atom('famc/sym', { name: 'f' })
    assert.equal(match(defn('famc/defn-', sym), defn('famc/defn', v('$f')))?.f, sym)
    assert.ok(match(defn('famc/defn', sym), defn('famc/defn-', v('$f'))))
    assert.ok(match(defn('famd/defn', sym), defn('famc/defn', v('$f'))), 'across families')
    assert.equal(match(defn('famc/def', sym), defn('famc/defn', v('$f'))), null)
  })

  test('a mixed tree: ESTree and foreign nodes in one pattern', () => {
    define('famm/call', ['callee', 'args'])
    define('famm/num', [])
    const num = (n: number) => atom('famm/num', { value: n })
    const inner = toNode({ type: 'famm/call', children: [js`h`, [num(2), js`x + 1`]] })
    const target = js`g(1, ${inner})`

    const all = match(target, js`g($$a, $b)`)!
    assert.deepEqual(all.a.map(print), ['1'])
    assert.equal(all.b, inner)

    const deep = match(target, js`g($_, ${toNode({ type: 'famm/call', children: [v('$f'), [v('$$xs'), js`$y + 1`]] })})`)!
    assert.equal(print(deep.f), 'h')
    assert.equal(deep.xs.length, 1)
    assert.equal(deep.xs[0], (inner.children[1] as Node[])[0])
    assert.equal(print(deep.y), 'x')
    assert.equal(match(target, js`g($_, ${toNode({ type: 'famm/call', children: [v('$f'), [num(3), v('$$_')]] })})`), null)

    // Rules reach ESTree forms inside foreign nodes.
    const out = walk(inner, rule(js`$a + 1`, js`inc($a)`))!
    assert.equal(print((out.children[1] as Node[])[1]), 'inc(x)')
  })
})

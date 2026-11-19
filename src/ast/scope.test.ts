import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { transform } from '../demo/macros.ts'
import { read } from '../read/index.ts'
import { freshName, scope, walk, type Node } from './index.ts'

const analyze = (src: string, filename = 'a.js') => {
  const ast = read(src, { filename })
  return { ast, info: scope(ast) }
}

/** Every Identifier named `name`, in source order. */
function ids(ast: Node, name: string): Node[] {
  const out: Node[] = []
  walk(ast, (n: any) => void ((n.type === 'Identifier' || n.type === 'JSXIdentifier') && n.name === name && out.push(n)))
  return out
}

/** For each `name` identifier: which declaration it resolves to (its index among `name`s), or null. */
function resolve(src: string, name: string, filename?: string) {
  const { ast, info } = analyze(src, filename)
  const all = ids(ast, name)
  return all.map((id) => {
    const b = info.bindingOf(id)
    if (b === undefined) return 'not a ref'
    if (b === null) return 'free'
    return all.indexOf(b.declarations[0])
  })
}

describe('scope', () => {
  test('block scoping and shadowing', () => {
    // a#0 declares; a#1 in the block is a new let; a#2 reads the inner one; a#3 the outer.
    assert.deepEqual(resolve('let a = 1\n{ let a = 2; f(a) }\nf(a)', 'a'), [0, 1, 1, 0])
  })

  test('var and function hoist to the function; use before declaration resolves', () => {
    assert.deepEqual(resolve('f(a)\nvar a = 1', 'a'), [1, 1])
    assert.deepEqual(resolve('g()\nfunction g() {}', 'g'), [1, 1])
    assert.deepEqual(resolve('function f() { { var a } a }\na', 'a'), [0, 0, 'free'])
  })

  test('params, defaults, destructuring, closures', () => {
    assert.deepEqual(resolve('function f(a, { b: [c] = a }) { return () => a + c }', 'a'), [0, 0, 0])
    assert.deepEqual(resolve('function f(a, { b: [c] = a }) { return () => a + c }', 'c'), [0, 0])
    assert.deepEqual(resolve('function f(a, { b: [c] = a }) { return () => a + c }', 'b'), ['not a ref'])
  })

  test('catch, for-let, switch, named function and class expressions', () => {
    assert.deepEqual(resolve('try {} catch (e) { e }\ne', 'e'), [0, 0, 'free'])
    assert.deepEqual(resolve('for (let i = 0; i < 3; i++) i\ni', 'i'), [0, 0, 0, 0, 'free'])
    assert.deepEqual(resolve('const f = function g() { g }\ng', 'g'), [0, 0, 'free'])
    assert.deepEqual(resolve('const K = class C { m() { C } }\nC', 'C'), [0, 0, 'free'])
    assert.deepEqual(resolve('switch (x) { case 1: let y = 1; y }\ny', 'y'), [0, 0, 'free'])
  })

  test('names that are not references', () => {
    const src = 'const o = { a: 1, [k]: 2 }\no.a\nclass C { a = 1; a() {} }\na: for (;;) break a'
    assert.deepEqual(resolve(src, 'a'), ['not a ref', 'not a ref', 'not a ref', 'not a ref', 'not a ref', 'not a ref'])
    assert.deepEqual(resolve(src, 'k'), ['free'])
  })

  test('shorthand properties read the variable', () => {
    assert.deepEqual(resolve('let a = 1\nf({ a })', 'a'), [0, 'not a ref', 0])
  })

  test('writes', () => {
    const { info } = analyze('let a, b\na = 1\nb++\n;[a] = x\nfor (a of y) {}\nf(a)')
    const a = info.root.bindings.get('a')!
    assert.deepEqual(a.references.map((r) => r.write), [true, true, true, false])
    assert.deepEqual(info.root.bindings.get('b')!.references.map((r) => r.write), [true])
  })

  test('imports: binding with source and name', () => {
    const { info } = analyze("import d, { a, b as c, 'x-y' as xy } from './m.js'\nimport * as ns from './n.js'\nd(a, c, xy, ns)")
    const imp = (name: string) => info.root.bindings.get(name)!.import
    assert.deepEqual(imp('d'), { source: './m.js', name: 'default' })
    assert.deepEqual(imp('a'), { source: './m.js', name: 'a' })
    assert.deepEqual(imp('c'), { source: './m.js', name: 'b' })
    assert.deepEqual(imp('xy'), { source: './m.js', name: 'x-y' })
    assert.deepEqual(imp('ns'), { source: './n.js', name: '*' })
    for (const n of ['d', 'a', 'c', 'xy', 'ns']) assert.equal(info.root.bindings.get(n)!.references.length, 1, n)
  })

  test('imports are shadowed like anything else', () => {
    // `import { a }` holds two `a`s: the imported name (not a ref) and the local binding.
    assert.deepEqual(resolve("import { a } from './m.js'\nfunction f(a) { a }\na", 'a'), ['not a ref', 1, 2, 2, 1])
  })

  test('export specifiers read locals; re-exports do not', () => {
    assert.deepEqual(resolve('const a = 1\nexport { a as b }', 'a'), [0, 0])
    assert.deepEqual(resolve("export { a } from './m.js'", 'a'), ['not a ref', 'not a ref'])
  })

  test('JSX: components are references, tags are not', () => {
    const src = "import Foo from './foo.js'\nconst ui = <div><Foo.Bar /><Foo>x</Foo></div>"
    const { info } = analyze(src, 'a.jsx')
    const foo = info.root.bindings.get('Foo')!
    assert.equal(foo.references.length, 3) // <Foo.Bar />, <Foo>, </Foo>
    assert.equal(info.free.has('div'), false)
    assert.deepEqual(resolve(src, 'Foo', 'a.jsx'), [0, 0, 0, 0])
  })

  test('TypeScript types are not values', () => {
    const src = 'import { T } from "./t.js"\ntype A = T\ninterface I { x: T }\nlet v: T = f(1 as T)\nenum E { X = v }'
    const { info } = analyze(src, 'a.ts')
    assert.equal(info.root.bindings.get('T')!.references.length, 0)
    assert.equal(info.root.bindings.get('v')!.references.length, 1) // enum initializer
    assert.equal(info.root.bindings.get('E')!.kind, 'enum')
  })

  test('scopes form a tree; scopeOf finds the scope a node creates', () => {
    const { ast, info } = analyze('function f(a) { if (a) { let b } }')
    const f = (ast as any).body[0]
    const fs = info.scopeOf(f)!
    assert.equal(fs.kind, 'function')
    assert.equal(fs.parent, info.root)
    assert.ok(fs.bindings.has('a'))
    assert.equal(info.scopeOf(f.body), fs, 'function body shares the function scope')
    assert.equal(fs.children[0].kind, 'block')
    assert.ok(fs.children[0].bindings.has('b'))
  })

  test('free names and fresh names', () => {
    const { info } = analyze('const meta = 1\nconsole.log(meta, meta_1, window)')
    assert.deepEqual([...info.free.keys()], ['console', 'meta_1', 'window'])
    assert.equal(freshName('meta', info.names), 'meta_2')
    assert.equal(freshName('other', info.names), 'other')
  })

  describe('on the project sources', () => {
    const SRC = fileURLToPath(new URL('..', import.meta.url))
    const filesIn = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? filesIn(join(dir, e.name)) : /\.(js|jsx|ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
      )
    for (const file of filesIn(SRC)) {
      test(relative(SRC, file), () => {
        const source = read(readFileSync(file, 'utf8'), { filename: file.replaceAll('\\', '/') })
        // The demo is checked as it runs: with its macros expanded.
        const ast = /[\\/]demo[\\/]/.test(file) ? transform(source)! : source
        const info = scope(ast)
        // Every reference lands on a binding with its name; the only free names are globals.
        for (const r of info.references) if (r.binding) assert.equal(r.binding.name, (r.node as any).name)
        const globals = [...info.free.keys()].filter((n) => !KNOWN_GLOBALS.has(n))
        if (!/fixtures/.test(file)) assert.deepEqual(globals, [], 'unexpected free names')
      })
    }
  })
})

const KNOWN_GLOBALS = new Set([
  'undefined', 'Infinity', 'NaN', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError', 'SyntaxError', 'RegExp', 'Proxy', 'Reflect',
  'console', 'fetch', 'URL', 'performance', 'globalThis', 'Infinity', 'parseInt', 'eval', 'ReferenceError', 'TextEncoder', 'btoa',
])

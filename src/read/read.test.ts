import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { originOf, read, ReadError, type Node } from './index.ts'

const first = (src: string, opts?: Parameters<typeof read>[1]) => read(src, opts).body[0] as Node

/** Every object reachable from `node`. */
function* walkAll(value: unknown): Generator<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const v of value) yield* walkAll(v)
    return
  }
  yield value as Record<string, unknown>
  for (const v of Object.values(value)) yield* walkAll(v)
}

describe('read', () => {
  test('ESTree program as plain data', () => {
    const ast = read('const x = 1')
    assert.equal(ast.type, 'Program')
    assert.equal(ast.sourceType, 'module')
    const decl = ast.body[0] as any
    assert.equal(decl.type, 'VariableDeclaration')
    assert.equal(decl.kind, 'const')
    assert.equal(decl.declarations[0].id.name, 'x')
    assert.equal(decl.declarations[0].init.value, 1)
  })

  test('no positions or parents on nodes', () => {
    const ast = read('function f(a) { return a + 1 } // c')
    for (const obj of walkAll(ast)) {
      for (const key of ['range', 'loc', 'parent', 'start', 'end', 'comments', 'tokens']) {
        assert.ok(!(key in obj), `${obj.type} has "${key}"`)
      }
    }
  })

  test('origin side table', () => {
    const src = 'let a\nconst b = 2'
    const ast = read(src, { filename: 'http://x/m.js' })
    const decl = ast.body[1] as any
    const origin = originOf(decl)!
    assert.equal(src.slice(origin.start, origin.end), 'const b = 2')
    assert.equal(origin.file.url, 'http://x/m.js')
    assert.equal(src.slice(originOf(decl.declarations[0].id)!.start, originOf(decl.declarations[0].id)!.end), 'b')
    assert.deepEqual(originOf(ast), { file: origin.file, start: 0, end: src.length })
    assert.equal(originOf({ type: 'Identifier' }), undefined)
  })

  test('types are kept', () => {
    const decl = first('let a: number = 1', { filename: 'a.ts' }) as any
    assert.equal(decl.declarations[0].id.typeAnnotation.typeAnnotation.type, 'TSNumberKeyword')
    assert.equal(first('enum E { A }', { filename: 'a.ts' }).type, 'TSEnumDeclaration')
  })

  test('JSX in .js and .jsx', () => {
    for (const filename of ['a.js', 'a.jsx', 'http://x/a.jsx?t=1']) {
      const stmt = first('<a b={1}>x</a>', { filename }) as any
      assert.equal(stmt.expression.type, 'JSXElement', filename)
    }
  })

  test('structurally equal regardless of layout', () => {
    assert.deepEqual(read('a+b'), read('a   +\n  b'))
  })

  test('sourceType script rejects module syntax', () => {
    assert.equal(read('var a', { sourceType: 'script' }).sourceType, 'script')
    assert.throws(() => read('let a\nexport {}', { sourceType: 'script', filename: 's.js' }), {
      name: 'ReadError',
      message: /ExportNamedDeclaration.*\(s\.js:2:1\)/,
    })
  })

  test('syntax error with file, line and column', () => {
    assert.throws(
      () => read('let a\nlet = ;', { filename: 'http://x/bad.js' }),
      (err: unknown) => {
        assert.ok(err instanceof ReadError)
        assert.equal(err.filename, 'http://x/bad.js')
        assert.equal(err.line, 2)
        assert.match(err.message, /\(http:\/\/x\/bad\.js:2:\d+\)$/)
        return true
      },
    )
  })

  test('custom parser backend', () => {
    const ast = read('ignored', {
      parser: {
        name: 'fake',
        parse: () => ({
          program: { type: 'Program', range: [0, 7], sourceType: 'module', body: [] },
          comments: [{ kind: 'Line', value: ' hi', start: 0, end: 5 }],
        }),
      },
    })
    assert.deepEqual(ast.body, [{ type: 'Comment', kind: 'Line', value: ' hi' }])
  })
})

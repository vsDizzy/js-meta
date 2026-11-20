import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SourceMap as NodeSourceMap } from 'node:module'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { b, edit, walk } from '../ast/index.ts'
import { read } from '../read/index.ts'
import { emitWithMap } from './index.ts'

/** Decoded by Node's own source map implementation, not ours. */
function consumer(src: string, filename = 'http://x/a.js') {
  const { code, map } = emitWithMap(read(src, { filename }))
  const sm = new NodeSourceMap(map as never)
  const lines = code.split('\n')
  /** Where the generated `needle` (n-th occurrence) comes from. */
  const origin = (needle: string, nth = 0) => {
    let line = 0
    let col = -1
    let seen = -1
    for (; line < lines.length; line++) {
      col = -1
      while ((col = lines[line].indexOf(needle, col + 1)) >= 0) if (++seen === nth) break
      if (col >= 0) break
    }
    assert.ok(col >= 0, `"${needle}" not in output`)
    const e = sm.findEntry(line, col) as { originalSource: string; originalLine: number; originalColumn: number; name?: string }
    const srcLines = (map.sourcesContent[map.sources.indexOf(e.originalSource)] ?? '').split('\n')
    return { ...e, text: srcLines[e.originalLine]?.slice(e.originalColumn) ?? '' }
  }
  return { code, map, origin }
}

describe('emitWithMap', () => {
  test('code is the same as emit, map is v3 with sources inline', () => {
    const { code, map } = consumer('let  x=1;f( x )')
    assert.equal(code, 'let x = 1\nf(x)\n')
    assert.equal(map.version, 3)
    assert.deepEqual(map.sources, ['http://x/a.js'])
    assert.deepEqual(map.sourcesContent, ['let  x=1;f( x )'])
  })

  test('nodes map to where they were written', () => {
    const { origin } = consumer('const a =\n    compute(  1,\n  2 )\n\n\nif(a)   { log( a ) }')
    assert.match(origin('compute').text, /^compute\(/)
    assert.match(origin('2').text, /^2 \)/)
    assert.match(origin('log').text, /^log\(/)
    assert.equal(origin('a', 2).originalLine, 5) // the `a` in log(a)
  })

  test('identifiers carry their source name', () => {
    const { origin } = consumer('let longName = 1')
    assert.equal(origin('longName').name, 'longName')
  })

  test('after edit: renamed identifier keeps the original name and place', () => {
    const src = 'let x = 1\nuse(x)'
    const ast = edit(read(src, { filename: 'http://x/a.js' }), (d: any) => {
      d.body[1].expression.arguments[0].name = 'renamed'
    })
    const { code, map } = emitWithMap(ast)
    assert.equal(code, 'let x = 1\nuse(renamed)\n')
    const sm = new NodeSourceMap(map as never)
    const e = sm.findEntry(1, 4) as { originalLine: number; originalColumn: number; name: string }
    assert.deepEqual([e.originalLine, e.originalColumn, e.name], [1, 4, 'x'])
  })

  test('nodes built by a macro map to the call site', () => {
    const src = 'let v =\n  twice(a)'
    const ast = walk(read(src, { filename: 'http://x/a.js' }), {
      CallExpression: (n: any) => (n.callee.name === 'twice' ? b.ArrayExpression({ elements: [n.arguments[0], n.arguments[0]] }) : undefined),
    })!
    const { code, map } = emitWithMap(ast)
    assert.equal(code, 'let v = [a, a]\n')
    const sm = new NodeSourceMap(map as never)
    const bracket = sm.findEntry(0, 8) as { originalLine: number; originalColumn: number }
    // The expansion took the origin of the call it replaced: `[` maps to `twice(a)`.
    assert.deepEqual([bracket.originalLine, bracket.originalColumn], [1, 2])
    const a = sm.findEntry(0, 9) as { originalLine: number; originalColumn: number }
    assert.deepEqual([a.originalLine, a.originalColumn], [1, 8])
  })

  test('leading comments map to themselves; their node keeps its place and name', () => {
    const { code, origin } = consumer('x =\n  /* c */ y\nx = (/* d */ z).w')
    assert.equal(code, 'x = /* c */ y\nx = (/* d */ z).w\n')
    assert.match(origin('/* c */').text, /^\/\* c \*\/ y/)
    assert.equal(origin('y').name, 'y')
    assert.equal(origin('y').originalColumn, 10)
    assert.equal(origin('z').name, 'z', 'in parens, the name is still at the identifier')
    assert.match(origin('z').text, /^z\)/)
  })

  test('nodes from another file add a source', () => {
    const lib = read('helper()', { filename: 'http://x/lib.js' })
    const ast = edit(read('main()', { filename: 'http://x/main.js' }), (d: any) => {
      d.body.push(lib.body[0])
    })
    const { code, map } = emitWithMap(ast)
    assert.equal(code, 'main()\nhelper()\n')
    assert.deepEqual(map.sources, ['http://x/main.js', 'http://x/lib.js'])
    const e = new NodeSourceMap(map as never).findEntry(1, 0) as { originalSource: string }
    assert.equal(e.originalSource, 'http://x/lib.js')
  })

  test('every named segment points at that name, in source and output (emit/index.ts)', () => {
    const file = fileURLToPath(new URL('./index.ts', import.meta.url))
    const src = readFileSync(file, 'utf8')
    const { code, map } = emitWithMap(read(src, { filename: 'http://x/index.ts' }))
    const sm = new NodeSourceMap(map as never)
    const out = code.split('\n')
    const inp = src.split('\n')
    let checked = 0
    out.forEach((line, i) => {
      for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const e = sm.findEntry(i, m.index) as { generatedLine: number; generatedColumn: number; originalLine: number; originalColumn: number; name?: string }
        if (!e.name || e.generatedLine !== i || e.generatedColumn !== m.index) continue
        assert.equal(m[0], e.name, `output ${i}:${m.index}`)
        assert.ok(inp[e.originalLine].startsWith(e.name, e.originalColumn), `source ${e.originalLine}:${e.originalColumn}`)
        checked++
      }
    })
    assert.ok(checked > 1000, `checked ${checked}`)
  })
})

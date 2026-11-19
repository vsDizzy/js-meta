import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { emit } from '../emit/index.ts'
import { read } from '../read/index.ts'
import { lower } from './lower.ts'

const out = (src: string, filename = 'http://x/a.js') => emit(lower(read(src, { filename })).ast)

/** The body of the wrapper, unindented, without the 'use strict' line. */
const bodyOf = (src: string, filename?: string) =>
  out(src, filename)
    .split('\n')
    .slice(2, -2)
    .map((l) => l.slice(2))
    .join('\n')

/** A minimal registry, just enough to run lowered modules (the real runtime comes next). */
async function run(modules: Record<string, string>, entry: string) {
  const records = new Map<string, Record<string, unknown>>()
  const load = async (url: string): Promise<Record<string, unknown>> => {
    const known = records.get(url)
    if (known) return known
    const ns: Record<string, unknown> = Object.create(null)
    records.set(url, ns)
    const define = (name: string, get: () => unknown) => Object.defineProperty(ns, name, { get, enumerable: true })
    const meta = {
      url,
      import: (spec: string) => load(new URL(spec, url).href),
      export: (getters: Record<string, () => unknown>) => {
        for (const [name, get] of Object.entries(getters)) define(name, get)
      },
      exportAll: (other: Record<string, unknown>) => {
        for (const name of Object.keys(other)) if (name !== 'default' && !(name in ns)) define(name, () => other[name])
      },
    }
    const fn = (0, eval)(emit(lower(read(modules[url], { filename: url })).ast))
    await fn(meta)
    return ns
  }
  return load(entry)
}

describe('lower: output', () => {
  test('imports, exports, import.meta, import()', () => {
    const src = "import d, { a } from './b.js'\nexport const c = a + d\nexport default c * 2\nimport.meta.url\nimport('./x.js')"
    assert.equal(
      out(src),
      [
        '(async function (meta) {',
        "  'use strict'",
        '  meta.export({ c: () => c, default: () => _default })',
        "  const b = await meta.import('./b.js')",
        '  const c = b.a + b.default',
        '  const _default = c * 2',
        '  meta.url',
        "  meta.import('./x.js')",
        '})',
        '',
      ].join('\n'),
    )
  })

  test('calls lose `this`, shorthand gets a value, JSX gets a member', () => {
    // `;` before `(`: the printer keeps it ASI-safe after `const m = ...`.
    assert.equal(bodyOf("import { f } from './m.js'\nf(1)\nf`t`"), "const m = await meta.import('./m.js')\n;(0, m.f)(1)\n;(0, m.f)`t`")
    assert.equal(bodyOf("import { a } from './m.js'\nx({ a })"), "const m = await meta.import('./m.js')\nx({ a: m.a })")
    assert.equal(bodyOf("import A from './m.js'\nconst v = <A x={1} />", 'http://x/a.jsx'), "const m = await meta.import('./m.js')\nconst v = <m.default x={1} />")
  })

  test('namespaces, shadowing, side-effect imports in order', () => {
    const src = "import './polyfill.js'\nimport * as u from './u.js'\nfunction f(u) { return u }\nu.g(u)"
    assert.equal(
      bodyOf(src),
      "await meta.import('./polyfill.js')\nconst u_1 = await meta.import('./u.js')\n\nfunction f(u) {\n  return u\n}\n\nu_1.g(u_1)",
    )
  })

  test('re-exports and local export lists', () => {
    const src = "import { a } from './a.js'\nconst k = 1\nexport { k as key, a }\nexport { x as y } from './x.js'\nexport * from './all.js'\nexport * as ns from './n.js'"
    const lowered = lower(read(src, { filename: 'http://x/m.js' }))
    assert.deepEqual(lowered.exports, ['key', 'a', 'y', 'ns'])
    assert.deepEqual(lowered.imports, ['./a.js', './x.js', './all.js', './n.js'])
    assert.equal(lowered.exportsAll, true)
    // The namespace of './a.js' is `a_1`: the module already has an `a`.
    assert.match(emit(lowered.ast), /meta\.export\(\{ key: \(\) => k, a: \(\) => a_1\.a, y: \(\) => x\.x, ns: \(\) => n \}\)/)
    assert.match(emit(lowered.ast), /meta\.exportAll\(all\)/)
  })

  test('default function and class keep or get a name', () => {
    assert.match(out('export default function () {}'), /function _default\(\) \{\}/)
    assert.match(out('export default class K {}'), /meta\.export\(\{ default: \(\) => K \}\)/)
  })

  test('fresh names never clash with the module', () => {
    const src = "import { a } from './b.js'\nconst meta = 1, b = 2\nexport { meta, b }\na"
    assert.equal(
      bodyOf(src),
      "meta_1.export({ meta: () => meta, b: () => b })\nconst b_1 = await meta_1.import('./b.js')\nconst meta = 1, b = 2\nb_1.a",
    )
  })

  test('type-only imports and exports disappear', () => {
    const src = "import type { T } from './t.js'\nimport { type U, v } from './u.js'\nexport type { T }\nexport interface I {}\nv"
    assert.equal(bodyOf(src, 'http://x/a.ts'), "const u = await meta.import('./u.js')\nu.v")
  })
})

describe('lower: semantics (run with a stub registry)', () => {
  test('live bindings: importers see later changes', async () => {
    const main = await run(
      {
        'http://x/counter.js': 'export let count = 0\nexport function inc() { count++ }',
        'http://x/main.js': "import { count, inc } from './counter.js'\nexport const before = count\ninc(); inc()\nexport const after = count",
      },
      'http://x/main.js',
    )
    assert.deepEqual({ ...main }, { before: 0, after: 2 })
  })

  test('imported functions are called without `this`; strict mode', async () => {
    const main = await run(
      {
        'http://x/m.js': 'export function self() { return this }',
        'http://x/main.js': "import { self } from './m.js'\nexport const t = self()\nexport const strict = (function () { return this })() === undefined",
      },
      'http://x/main.js',
    )
    assert.equal(main.t, undefined)
    assert.equal(main.strict, true)
  })

  test('cycles: functions are callable across the cycle', async () => {
    const main = await run(
      {
        'http://x/a.js': "import { b } from './b.js'\nexport function a() { return 'a' }\nexport const ab = b()",
        'http://x/b.js': "import { a } from './a.js'\nexport function b() { return 'b' + a() }",
      },
      'http://x/a.js',
    )
    assert.equal(main.ab, 'ba')
  })

  test('TDZ: reading a binding before it is initialized throws', async () => {
    await assert.rejects(
      run(
        {
          'http://x/a.js': "import { early } from './b.js'\nexport const value = 1",
          'http://x/b.js': "import { value } from './a.js'\nexport const early = value",
        },
        'http://x/a.js',
      ),
      ReferenceError,
    )
  })

  test('default, namespace, re-exports, import.meta.url, dynamic import', async () => {
    const main = await run(
      {
        'http://x/lib/util.js': "export default (x) => x * 2\nexport const name = 'util'\nexport const here = import.meta.url",
        'http://x/lib/index.js': "export * from './util.js'\nexport { default as double } from './util.js'",
        'http://x/main.js':
          "import * as lib from './lib/index.js'\nexport const r = lib.double(21)\nexport const n = lib.name\nexport const here = lib.here\nexport const later = (await import('./lib/util.js')).name",
      },
      'http://x/main.js',
    )
    assert.deepEqual({ ...main }, { r: 42, n: 'util', here: 'http://x/lib/util.js', later: 'util' })
  })
})

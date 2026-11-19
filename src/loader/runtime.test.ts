import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Runtime, type RuntimeOptions } from './runtime.ts'

/** A runtime over in-memory files at http://app/, with a log of fetches. */
function app(files: Record<string, string>, options: RuntimeOptions = {}) {
  const fetched: string[] = []
  const rt = new Runtime({
    base: 'http://app/',
    fetch: async (url) => {
      fetched.push(url)
      const path = new URL(url).pathname.slice(1)
      const text = files[path]
      return { ok: text !== undefined, status: text === undefined ? 404 : 200, text: async () => text! }
    },
    nativeImport: async (spec) => ({ native: spec }),
    ...options,
  })
  return { rt, fetched }
}

describe('runtime', () => {
  test('loads the graph once per module and evaluates dependencies first', async () => {
    const { rt, fetched } = app({
      'main.js': "import './log.js'\nimport { a } from './a.js'\nimport { b } from './b.js'\nglobalThis.order.push('main')\nexport const ab = a + b",
      'a.js': "import { c } from './c.js'\nglobalThis.order.push('a')\nexport const a = 'a' + c",
      'b.js': "import { c } from './c.js'\nglobalThis.order.push('b')\nexport const b = 'b' + c",
      'c.js': "globalThis.order.push('c')\nexport const c = 'c'",
      'log.js': "globalThis.order = ['log']",
    })
    const ns = await rt.import('./main.js')
    assert.equal(ns.ab, 'acbc')
    assert.deepEqual((globalThis as any).order, ['log', 'c', 'a', 'b', 'main'])
    assert.equal(fetched.length, 5, 'c.js fetched once')
    assert.equal(Object.prototype.toString.call(ns), '[object Module]')
  })

  test('the live graph: dependencies and importers', async () => {
    const { rt } = app({ 'main.js': "import './a.js'\nimport './b.js'", 'a.js': "import './b.js'", 'b.js': '' })
    await rt.import('./main.js')
    const r = (p: string) => rt.records.get(`http://app/${p}`)!
    assert.deepEqual(r('main.js').dependencies, ['http://app/a.js', 'http://app/b.js'])
    assert.deepEqual([...r('b.js').importers].sort(), ['http://app/a.js', 'http://app/main.js'])
    assert.ok(r('a.js').code!.includes('//# sourceMappingURL=data:application/json;base64,'))
    assert.equal(r('a.js').status, 'evaluated')
  })

  test('cycles: a back edge gets the namespace as it is', async () => {
    const { rt } = app({
      'a.js': "import { b } from './b.js'\nexport function a() { return 'a' }\nexport const ab = b()",
      'b.js': "import { a } from './a.js'\nexport function b() { return 'b' + a() }",
    })
    assert.equal((await rt.import('./a.js')).ab, 'ba')
  })

  test('modules we do not read are native imports wrapped as records', async () => {
    const { rt, fetched } = app({
      'main.js': "import { native } from 'some-package'\nimport ts from './helper.ts'\nexport const n = native\nexport const t = ts",
    })
    const ns = await rt.import('./main.js')
    assert.equal(ns.n, 'some-package')
    assert.deepEqual(fetched, ['http://app/main.js'])
    assert.equal(rt.records.get('some-package')!.kind, 'native')
    assert.equal(rt.records.get('http://app/helper.ts')!.kind, 'native')
  })

  test('import.meta: url, resolve, dynamic import of a new module', async () => {
    const { rt } = app({
      'lib/m.js': "export const url = import.meta.url\nexport const sib = import.meta.resolve('./x.js')\nexport const later = (await import('../late.js')).v",
      'late.js': 'export const v = 42',
    })
    const ns = await rt.import('./lib/m.js')
    assert.deepEqual({ ...ns }, { url: 'http://app/lib/m.js', sib: 'http://app/lib/x.js', later: 42 })
  })

  test('concurrent imports of one module evaluate it once', async () => {
    const { rt } = app({ 'once.js': 'globalThis.runs = (globalThis.runs ?? 0) + 1\nexport const x = 1' })
    ;(globalThis as any).runs = 0
    const [a, b] = await Promise.all([rt.import('./once.js'), rt.import('./once.js')])
    assert.equal(a, b)
    assert.equal((globalThis as any).runs, 1)
  })

  test('errors name the module', async () => {
    const { rt } = app({ 'main.js': "import './missing.js'", 'bad.js': 'let = ;' })
    await assert.rejects(rt.import('./main.js'), /404 loading http:\/\/app\/missing\.js/)
    await assert.rejects(rt.import('./bad.js'), /http:\/\/app\/bad\.js:1/)
    assert.equal(rt.records.get('http://app/bad.js')!.status, 'failed')
  })
})

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

  describe('redefine', () => {
    const counter = "export let count = 0\nexport function inc() { count++ }\nexport function label() { return 'n=' + count }"
    const files = () => ({
      'counter.js': counter,
      'main.js': "import { inc, label } from './counter.js'\nexport const click = () => { inc(); return label() }",
    })

    test('changing one function keeps the state; importers and old callbacks see it', async () => {
      const { rt } = app(files())
      const main = await rt.import('./main.js')
      const click = main.click as () => string // a callback handed out before the change
      assert.equal(click(), 'n=1')
      const r = await rt.redefine('http://app/counter.js', counter.replace("'n=' + count", "'count: ' + count"))
      assert.deepEqual(r, { url: 'http://app/counter.js', version: 2, changed: 1, removed: [] })
      assert.equal(click(), 'count: 2', 'new label, count kept going')
    })

    test('a changed initializer re-runs (like def); layout-only changes run nothing', async () => {
      const { rt } = app(files())
      const ns = await rt.import('./counter.js')
      ;(ns.inc as () => void)()
      const relaid = await rt.redefine('http://app/counter.js', counter.replaceAll(' ', '  ').replace('{', '{\n'))
      assert.equal(relaid.changed, 0)
      assert.equal(ns.count, 1)
      await rt.redefine('http://app/counter.js', counter.replace('count = 0', 'count = 10'))
      assert.equal(ns.count, 10)
    })

    test('comments are not part of a form: changing, adding or removing one runs nothing', async () => {
      const src = 'export let count = /* start */ 0\nexport function inc() {\n  // step\n  count++\n}'
      const { rt } = app({ 'c.js': src })
      const ns = await rt.import('./c.js')
      ;(ns.inc as () => void)()
      const url = 'http://app/c.js'
      const edits = [
        src.replace('start', 'begin'), // a leading comment in an initializer: changed
        src.replace('/* start */ ', ''), // removed
        src.replace('/* start */', '/* a */ /* b */'), // added
        src.replace('// step', '// one step'), // a comment in a function body: changed
        src.replace('  // step\n', ''), // removed
        src.replace('count++', '/* up */ count++\n  // done'), // added
        `// top\n${src}`, // a top-level comment
      ]
      for (const next of edits) assert.equal((await rt.redefine(url, next)).changed, 0, next)
      assert.equal(ns.count, 1, 'the initializer did not re-run')
      assert.equal(rt.records.get(url)!.source, edits.at(-1), 'the record has the new source')
      // A real change still runs, comments and all.
      assert.equal((await rt.redefine(url, src.replace('count++', 'count += 10'))).changed, 1)
      ;(ns.inc as () => void)()
      assert.equal(ns.count, 11)
      assert.equal((await rt.redefine(url, src.replace('/* start */ 0', '/* start */ 5'))).changed, 2)
      assert.equal(ns.count, 5)
    })

    test('removed bindings and exports go away', async () => {
      const { rt } = app(files())
      const ns = await rt.import('./counter.js')
      const r = await rt.redefine('http://app/counter.js', "export let count = 0\nexport function inc() { count++ }")
      assert.deepEqual(r.removed, ['label'])
      assert.equal('label' in ns, false)
      assert.equal('label' in rt.records.get('http://app/counter.js')!.env, false)
    })

    test('side effects run again only when their form changed', async () => {
      const g = globalThis as any
      g.effects = 0
      const src = "globalThis.effects++\nexport const v = 1"
      const { rt } = app({ 'fx.js': src })
      await rt.import('./fx.js')
      await rt.redefine('http://app/fx.js', src.replace('v = 1', 'v = 2'))
      assert.equal(g.effects, 1)
      await rt.redefine('http://app/fx.js', src.replace('effects++', 'effects += 10'))
      assert.equal(g.effects, 11)
    })

    test('a new import is loaded and joins the live graph; an AST works as input', async () => {
      const { rt } = app({ ...files(), 'extra.js': 'export const bonus = 100' })
      const main = await rt.import('./main.js')
      const next = "import { inc, label } from './counter.js'\nimport { bonus } from './extra.js'\nexport const click = () => { inc(); return label() + bonus }"
      const { read } = await import('../read/index.ts')
      await rt.redefine('http://app/main.js', read(next, { filename: 'http://app/main.js' }))
      assert.equal((main.click as () => string)(), 'n=1100')
      assert.ok(rt.records.get('http://app/extra.js')!.importers.has('http://app/main.js'))
      assert.deepEqual(rt.records.get('http://app/main.js')!.dependencies, ['http://app/counter.js', 'http://app/extra.js'])
    })
  })

  describe('eval', () => {
    const counter = "import { step } from './step.js'\nexport let count = 0\nexport function inc() { count += step }"
    const files = () => ({ 'counter.js': counter, 'step.js': 'export const step = 1' })

    test('reads and writes the module cells and imports; returns the last expression', async () => {
      const { rt } = app(files())
      const ns = await rt.import('./counter.js')
      assert.equal(await rt.eval('./counter.js', 'inc(); inc()\ncount * step'), 2)
      assert.equal(await rt.eval('./counter.js', 'count = 10'), 10)
      assert.equal(ns.count, 10, 'importers see it')
      assert.equal(await rt.eval('./counter.js', 'let x = 1'), undefined)
    })

    test('a new definition replaces the cell for every caller; new names persist', async () => {
      const { rt } = app({ ...files(), 'main.js': "import { inc, count } from './counter.js'\nexport const click = () => { inc(); return count }" })
      const click = (await rt.import('./main.js')).click as () => number
      const ns = await rt.import('./counter.js')
      await rt.eval('./counter.js', 'function inc() { count += 100 }\nconst twice = (x) => x * 2')
      assert.equal(click(), 100, 'callers by name reach the new definition')
      assert.equal(await rt.eval('./counter.js', 'twice(count)'), 200)
    })

    test('await, exports, errors', async () => {
      const { rt } = app(files())
      const ns = await rt.import('./counter.js')
      assert.equal(await rt.eval('./counter.js', 'await Promise.resolve(step + 1)'), 2)
      await rt.eval('./counter.js', 'export const extra = 7')
      assert.equal(ns.extra, 7)
      await assert.rejects(rt.eval('./counter.js', 'nope()'), /nope is not defined/)
      await assert.rejects(rt.eval('./counter.js', 'let = ;'), /counter\.js\?eval=\d+:1/)
    })
  })

  test('errors name the module', async () => {    const { rt } = app({ 'main.js': "import './missing.js'", 'bad.js': 'let = ;' })
    await assert.rejects(rt.import('./main.js'), /404 loading http:\/\/app\/missing\.js/)
    await assert.rejects(rt.import('./bad.js'), /http:\/\/app\/bad\.js:1/)
    assert.equal(rt.records.get('http://app/bad.js')!.status, 'failed')
  })
})

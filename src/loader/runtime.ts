// The module runtime: a registry of live module records.
//
//   const runtime = new Runtime()            // or bootstrap('./main.js')
//   const ns = await runtime.import(url)     // a module namespace
//   runtime.records                          // url -> record: the live module map
//
// Two phases, like ESM: `load` fetches, reads and lowers the whole static graph
// in parallel; `evaluate` runs it depth-first, dependencies before importers.
// Our modules (same origin, .js/.mjs) go through read -> lower -> emit; anything
// else (bare specifiers, other origins, .ts served by ts-code) is a native
// import() wrapped as a record.
//
// Live redefinition, Clojure style: `redefine(url, source | ast)` compares the
// new top-level forms with the old ones (by canonical text, comments aside) and
// runs only the changed ones into the module's env. Unchanged state stays,
// callers reach the new definitions through the env cells, and importers read
// the namespace's getters, so nobody has to re-run.
import { read, type Program } from '../read/index.ts'
import { emit, emitWithMap, type SourceMap } from '../emit/index.ts'
import { make, toNode, type Node } from '../ast/node.ts'
import { walk } from '../ast/walk.ts'
import { lower, type Lowered } from './lower.ts'

export type Namespace = Record<string, unknown>

export interface Redefinition {
  url: string
  version: number
  /** Top-level forms that were run (new or changed). */
  changed: number
  /** Top-level bindings that no longer exist (their cells were removed). */
  removed: string[]
}

export interface ModuleRecord {
  url: string
  /** `source`: read and lowered by us; `native`: loaded with import(). */
  kind: 'source' | 'native'
  status: 'loading' | 'loaded' | 'evaluating' | 'evaluated' | 'failed'
  namespace: Namespace
  /** The module's top-level bindings, one cell per name (source modules). */
  env: Record<string, unknown>
  /** Explicitly exported names (the getters this module defined). */
  exports: string[]
  /** 1 on first evaluation, +1 per redefinition. */
  version: number
  /** Resolved URLs of the static imports, in source order. */
  dependencies: string[]
  /** Records that import this one (the reverse edges of the live graph). */
  importers: Set<string>
  source?: string
  ast?: Program
  code?: string
  map?: SourceMap
  error?: unknown
}

export interface RuntimeOptions {
  /** Base for the entry and for deciding what is ours. Default: the page URL. */
  base?: string
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  /** Native loading for modules we don't read. Default: `import()`. */
  nativeImport?: (specifier: string) => Promise<Namespace>
  /** Which URLs we read and lower. Default: same origin as `base`, `.js` or `.mjs`. */
  isSource?: (url: string) => boolean
  /**
   * Macros: runs on every module AST after `read`, before lowering (also on
   * `redefine` and `eval` input). E.g. `(ast) => walk(ast, rules(...))`.
   */
  transform?: (ast: Program, url: string) => Node | null
}

const BARE = /^(?![a-z][a-z0-9+.-]*:|\.{0,2}\/)/i

/** UTF-8 safe base64 (btoa only takes Latin-1). */
function base64(text: string) {
  let bin = ''
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte)
  return btoa(bin)
}

export class Runtime {
  readonly records = new Map<string, ModuleRecord>()
  private loads = new Map<string, Promise<ModuleRecord>>()
  private evaluations = new Map<string, Promise<void>>()
  private base: string
  private fetchText: NonNullable<RuntimeOptions['fetch']>
  private nativeImport: NonNullable<RuntimeOptions['nativeImport']>
  private isSource: NonNullable<RuntimeOptions['isSource']>
  private transform: RuntimeOptions['transform']

  constructor(options: RuntimeOptions = {}) {
    this.base = options.base ?? globalThis.location?.href ?? 'file:///'
    this.fetchText = options.fetch ?? ((url) => fetch(url))
    this.nativeImport = options.nativeImport ?? ((specifier) => import(specifier))
    this.transform = options.transform
    const origin = new URL(this.base).origin
    this.isSource = options.isSource ?? ((url) => {
      const u = new URL(url)
      return u.origin === origin && /\.m?js$/.test(u.pathname)
    })
  }

  /** Like `import.meta.resolve`: a URL, or a bare specifier left to the native loader. */
  resolve(specifier: string, parent = this.base): string {
    return BARE.test(specifier) ? specifier : new URL(specifier, parent).href
  }

  /** Loads, evaluates and returns the namespace of `specifier` (relative to `parent`). */
  async import(specifier: string, parent = this.base): Promise<Namespace> {
    const url = this.resolve(specifier, parent)
    const record = await this.loadGraph(url)
    await this.evaluate(record, new Set())
    return record.namespace
  }

  // --- phase 1: the static graph, in parallel ---------------------------------

  /** Loads `url` and everything it imports; a visited set keeps cycles from waiting on themselves. */
  private async loadGraph(url: string): Promise<ModuleRecord> {
    const seen = new Set<string>()
    const visit = async (u: string): Promise<void> => {
      if (seen.has(u)) return
      seen.add(u)
      const record = await this.load(u)
      await Promise.all(
        record.dependencies.map((dep) => {
          const pending = visit(dep)
          this.records.get(dep)!.importers.add(u) // load() registers the record synchronously
          return pending
        }),
      )
    }
    await visit(url)
    return this.records.get(url)!
  }

  /** One module: fetched, read and lowered (its dependencies are loadGraph's job). */
  private load(url: string): Promise<ModuleRecord> {
    let pending = this.loads.get(url)
    if (!pending) {
      pending = this.fetchAndLower(url)
      this.loads.set(url, pending)
    }
    return pending
  }

  private async fetchAndLower(url: string): Promise<ModuleRecord> {
    const native = BARE.test(url) || !this.isSource(url)
    const record: ModuleRecord = {
      url,
      kind: native ? 'native' : 'source',
      status: 'loading',
      namespace: native ? {} : Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } }),
      env: Object.create(null),
      exports: [],
      version: 0,
      dependencies: [],
      importers: new Set(),
    }
    this.records.set(url, record)
    try {
      if (native) {
        record.namespace = await this.nativeImport(url)
        record.status = 'evaluated' // native modules evaluate on import()
        return record
      }
      const response = await this.fetchText(url)
      if (!response.ok) throw new Error(`js-meta: ${response.status} loading ${url}`)
      record.source = await response.text()
      record.ast = this.expand(read(record.source, { filename: url }), url)
      this.compile(record, lower(record.ast))
      record.status = 'loaded'
      return record
    } catch (error) {
      record.status = 'failed'
      record.error = error
      throw error
    }
  }

  /** The AST after the macros (`transform`): what runs and what `records` keep. */
  private expand(ast: Program, url: string): Program {
    if (!this.transform) return ast
    return (this.transform(ast, url) ?? make('Program', { sourceType: ast.sourceType }, [[]])) as Program
  }

  /** Lowered module -> runnable code with an inline source map; records its edges. */
  private compile(record: ModuleRecord, lowered: Lowered) {
    const { code, map } = emitWithMap(lowered.ast)
    const tag = record.version ? `#js-meta-v${record.version + 1}` : '#js-meta'
    record.code = `${code}//# sourceURL=${record.url}${tag}\n//# sourceMappingURL=data:application/json;base64,${base64(JSON.stringify(map))}\n`
    record.map = map
    record.exports = lowered.exports
    record.dependencies = lowered.imports.map((spec) => this.resolve(spec, record.url))
  }

  // --- live redefinition ----------------------------------------------------------

  private redefinitions = new Map<string, Promise<unknown>>()

  /**
   * Redefines a module from new source (or a new AST): runs only the top-level
   * forms that changed, in the same env. Returns what happened.
   */
  redefine(url: string, input: string | Node): Promise<Redefinition> {
    // One at a time per module: each compares against the previous result.
    const previous = this.redefinitions.get(url) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.redefineNow(url, input))
    this.redefinitions.set(url, next)
    return next
  }

  private async redefineNow(url: string, input: string | Node): Promise<Redefinition> {
    const record = this.records.get(url)
    if (!record || record.kind !== 'source' || record.status !== 'evaluated') {
      throw new Error(`js-meta: ${url} is not an evaluated source module`)
    }
    const source = typeof input === 'string' ? input : undefined
    const ast = this.expand((source !== undefined ? read(source, { filename: url }) : toNode(input)) as Program, url)

    // Forms by canonical text without comments: the same text means the same
    // form, whatever the layout and comments (editing a comment runs nothing).
    const form = (n: Node) => (n.type === 'Comment' ? null : emit(walk(n, { Comment: () => null })!))
    const before = new Map<string, number>()
    for (const n of record.ast!.body) {
      const k = form(n)
      if (k !== null) before.set(k, (before.get(k) ?? 0) + 1)
    }
    const changed = new Set<Node>()
    for (const n of ast.body) {
      const k = form(n)
      if (k === null) continue
      const left = before.get(k) ?? 0
      if (left > 0) before.set(k, left - 1)
      else changed.add(n)
    }

    const oldBindings = lower(record.ast!).bindings
    const oldExports = record.exports
    const oldDeps = record.dependencies
    const lowered = lower(ast, { include: (n) => changed.has(n) })
    this.compile(record, lowered)

    // Cells and exports that no longer exist go away.
    const removed = oldBindings.filter((name) => !lowered.bindings.includes(name))
    for (const name of removed) delete record.env[name]
    for (const name of oldExports) if (!lowered.exports.includes(name)) delete record.namespace[name]

    // The live graph follows the new imports.
    for (const dep of oldDeps) if (!record.dependencies.includes(dep)) this.records.get(dep)?.importers.delete(url)
    for (const dep of record.dependencies) {
      await this.loadGraph(dep)
      this.records.get(dep)!.importers.add(url)
      await this.evaluate(this.records.get(dep)!, new Set([url]))
    }

    const body = (0, eval)(record.code!) as (meta: object, env: object) => Promise<void>
    await body(this.metaFor(record, new Set([url])), record.env)
    record.ast = ast
    if (source !== undefined) record.source = source
    record.version++
    return { url, version: record.version, changed: changed.size, removed }
  }

  // --- REPL -------------------------------------------------------------------------

  private evals = 0

  /**
   * Runs `code` inside a module, like a REPL in a Clojure namespace, and returns
   * the value of its last expression statement. The module's bindings and
   * imports are in scope; new top-level bindings become cells of the module, so
   * `function inc() {...}` redefines `inc` for every caller. The file itself is
   * unchanged (a later `redefine` from the file doesn't remove what eval added).
   */
  async eval(specifier: string, code: string): Promise<unknown> {
    const url = this.resolve(specifier)
    await this.import(url)
    const record = this.records.get(url)!
    if (record.kind !== 'source') throw new Error(`js-meta: ${url} is a native module; eval works in modules js-meta reads`)
    const n = ++this.evals
    const snippet = this.expand(read(code, { filename: `${url}?eval=${n}` }), url)

    // The module's imports come along (they only read the loaded namespaces),
    // and the last expression statement becomes the result.
    const imports = record.ast!.body.filter((st) => st.type === 'ImportDeclaration')
    const body = [...snippet.body]
    const last = body.findLastIndex((st) => st.type !== 'Comment')
    if (last >= 0 && body[last].type === 'ExpressionStatement' && !body[last].directive) {
      body[last] = make('ReturnStatement', {}, [body[last].children[0]])
    }
    const program = make('Program', { sourceType: 'module' }, [[...imports, ...body]])
    const lowered = lower(program, { include: (st) => !imports.includes(st), cells: Object.keys(record.env) })

    const { code: js, map } = emitWithMap(lowered.ast)
    const run = (0, eval)(
      `${js}//# sourceURL=${url}?eval=${n}#js-meta\n//# sourceMappingURL=data:application/json;base64,${base64(JSON.stringify(map))}\n`,
    ) as (meta: object, env: object) => Promise<unknown>
    const value = await run(this.metaFor(record, new Set([url])), record.env)
    for (const name of lowered.exports) if (!record.exports.includes(name)) record.exports.push(name)
    return value
  }

  // --- phase 2: depth-first evaluation ------------------------------------------

  private evaluate(record: ModuleRecord, ancestors: Set<string>): Promise<void> {
    if (record.status === 'evaluated') return Promise.resolve()
    if (record.status === 'failed') return Promise.reject(record.error)
    // A back edge of a cycle: the importer gets the namespace as it is now.
    if (ancestors.has(record.url)) return Promise.resolve()
    let pending = this.evaluations.get(record.url)
    if (!pending) {
      pending = this.run(record, new Set(ancestors).add(record.url))
      this.evaluations.set(record.url, pending)
    }
    return pending
  }

  private async run(record: ModuleRecord, ancestors: Set<string>) {
    record.status = 'evaluating'
    try {
      for (const dep of record.dependencies) await this.evaluate(this.records.get(dep)!, ancestors)
      const body = (0, eval)(record.code!) as (meta: object, env: object) => Promise<void>
      await body(this.metaFor(record, ancestors), record.env)
      record.status = 'evaluated'
      record.version = 1
    } catch (error) {
      record.status = 'failed'
      record.error = error
      throw error
    }
  }

  /** The module's `import.meta`. */
  private metaFor(record: ModuleRecord, ancestors: Set<string>) {
    const ns = record.namespace
    const define = (name: string, get: () => unknown) =>
      Object.defineProperty(ns, name, { get, enumerable: true, configurable: true })
    return {
      url: record.url,
      resolve: (specifier: string) => this.resolve(specifier, record.url),
      import: async (specifier: string) => {
        const url = this.resolve(specifier, record.url)
        const dep = this.records.get(url)
        // Static imports: already evaluated by phase 2, or an ancestor in a cycle.
        if (dep && (dep.status === 'evaluated' || ancestors.has(url))) return dep.namespace
        return this.import(url) // dynamic import of something new
      },
      export: (getters: Record<string, () => unknown>) => {
        for (const [name, get] of Object.entries(getters)) define(name, get)
      },
      exportAll: (other: Namespace) => {
        for (const name of Object.keys(other)) if (name !== 'default' && !(name in ns)) define(name, () => other[name])
      },
    }
  }
}

let shared: Runtime | undefined

/** The page's runtime (created on first use). */
export const runtime = (options?: RuntimeOptions) => (shared ??= new Runtime(options))

/** Starts the app: loads and runs `entry` through the runtime, returns its namespace. */
export function bootstrap(entry: string, options?: RuntimeOptions): Promise<Namespace> {
  const rt = runtime(options)
  return rt.import(entry)
}

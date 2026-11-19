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
// import() wrapped as a record. Namespaces of our modules are objects with
// configurable getters, so a module can later be re-run and importers see the
// new bindings.
import { read, type Program } from '../read/index.ts'
import { emitWithMap, type SourceMap } from '../emit/index.ts'
import { lower } from './lower.ts'

export type Namespace = Record<string, unknown>

export interface ModuleRecord {
  url: string
  /** `source`: read and lowered by us; `native`: loaded with import(). */
  kind: 'source' | 'native'
  status: 'loading' | 'loaded' | 'evaluating' | 'evaluated' | 'failed'
  namespace: Namespace
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

  constructor(options: RuntimeOptions = {}) {
    this.base = options.base ?? globalThis.location?.href ?? 'file:///'
    this.fetchText = options.fetch ?? ((url) => fetch(url))
    this.nativeImport = options.nativeImport ?? ((specifier) => import(specifier))
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
      record.ast = read(record.source, { filename: url })
      const lowered = lower(record.ast)
      const { code, map } = emitWithMap(lowered.ast)
      record.code = `${code}//# sourceURL=${url}#js-meta\n//# sourceMappingURL=data:application/json;base64,${base64(JSON.stringify(map))}\n`
      record.map = map
      record.dependencies = lowered.imports.map((spec) => this.resolve(spec, url))
      record.status = 'loaded'
      return record
    } catch (error) {
      record.status = 'failed'
      record.error = error
      throw error
    }
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
      const body = (0, eval)(record.code!) as (meta: object) => Promise<void>
      await body(this.metaFor(record, ancestors))
      record.status = 'evaluated'
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

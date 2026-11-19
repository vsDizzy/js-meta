// lower(ast): canonical ESM -> a function the runtime can run. A compile step
// before execution; users and macros keep working on canonical ESM.
//
//   import d, { a } from './b.js'          (async function (meta, env) {
//   export let count = 0                      'use strict'
//   export function inc() { count++ }         meta.export({ count: () => env.count, inc: () => env.inc, default: () => env.default })
//   export default inc                        env.inc = function inc() { env.count++ }
//   a(d)                               ->     const b = await meta.import('./b.js')
//                                             env.count = 0
//                                             env.default = env.inc
//                                             ;(0, b.a)(b.default)
//                                           })
//
// Top-level bindings live in `env`, the module's environment: one cell per name,
// like Clojure vars. Every use goes through the cell, so redefining one form
// (re-running just it into the same env) leaves the rest of the state alone and
// every caller sees the new value. `include` picks the forms to run: all of them
// on first load, only the changed ones on a redefinition (runtime.ts).
//
// - Exports are registered first, as getters over `env`: live bindings that other
//   modules (cycles too) read through the runtime's records.
// - Function declarations are hoisted (assigned first), as in ESM.
// - Imported names read the dependency's namespace: `a` -> `b.a`, `a()` ->
//   `(0, b.a)()` (no `this`), `{ a }` -> `{ a: b.a }`, `<A />` -> `<b.A />`.
// - `import.meta` -> the `meta` parameter, `import(x)` -> `meta.import(x)`.
// - New names (`meta`, `env`, namespaces) are fresh; `env.default` can't clash
//   with a binding since `default` is a reserved word.
// Known gap: no TDZ for top-level let/const (a cell reads undefined before its
// initializer runs). Plain JS only for now: JSX and TS types are left as they are.
import { b, make, type Node } from '../ast/node.ts'
import { edit } from '../ast/edit.ts'
import { originOf, setOrigin } from '../ast/origin.ts'
import { walk, type Ctx } from '../ast/walk.ts'
import { freshName, scope, type Binding } from '../ast/scope.ts'

export interface Lowered {
  /** A Program with one statement: the `(async function (meta, env) { ... })` wrapper. */
  ast: Node
  /** Static dependencies in source order, as written (`./b.js`). */
  imports: string[]
  /** Exported names. */
  exports: string[]
  /** Whether the module re-exports everything of some dependency (`export * from`). */
  exportsAll: boolean
  /** Names of the module's top-level bindings (its env cells), imports excluded. */
  bindings: string[]
}

export interface LowerOptions {
  /** Top-level statements to run (default: all). Exports and imports are always set up. */
  include?: (statement: Node) => boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u

const id = (name: string) => b.Identifier({ name })
const str = (value: string) => b.Literal({ value })
const key = (name: string) => (IDENT.test(name) ? id(name) : str(name))
const member = (object: Node, name: string) =>
  IDENT.test(name)
    ? b.MemberExpression({ object, property: id(name), computed: false, optional: false })
    : b.MemberExpression({ object, property: str(name), computed: true, optional: false })
const call = (callee: Node, args: Node[]) => b.CallExpression({ callee, arguments: args, optional: false })
const stmt = (expression: Node) => b.ExpressionStatement({ expression })
const assign = (left: Node, right: Node) => b.AssignmentExpression({ operator: '=', left, right })
const getter = (body: Node) =>
  b.ArrowFunctionExpression({ params: [], body, async: false, expression: true, generator: false, id: null })
const constant = (name: string, init: Node) =>
  b.VariableDeclaration({ kind: 'const', declare: false, declarations: [b.VariableDeclarator({ id: id(name), init, definite: false })] })
const voidZero = () => b.UnaryExpression({ operator: 'void', prefix: true, argument: b.Literal({ value: 0, raw: '0' }) })

/** Same children and attrs under another type (declaration <-> expression), keeping the origin. */
function retype(n: N, type: string): Node {
  const { type: _, children, ...attrs } = n
  const out = make(type, attrs, children)
  const origin = originOf(n)
  if (origin) setOrigin(out, origin)
  return out
}

/** `./utils/foo-bar.js` -> `foo_bar`, `@scope/pkg` -> `pkg`. */
function baseName(source: string): string {
  const last = source.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() ?? 'mod'
  const name = last.replace(/\.[^.]*$/, '').replace(/[^\p{ID_Continue}$]+/gu, '_')
  return IDENT.test(name) ? name : '_' + name
}

/** Names a binding pattern declares. */
function patternNames(p: N, out: string[] = []): string[] {
  switch (p?.type) {
    case 'Identifier':
      out.push(p.name)
      break
    case 'ObjectPattern':
      for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out)
      break
    case 'ArrayPattern':
      for (const el of p.elements) if (el) patternNames(el, out)
      break
    case 'AssignmentPattern':
      patternNames(p.left, out)
      break
    case 'RestElement':
      patternNames(p.argument, out)
      break
  }
  return out
}

/** A declarator id after the rewrite: env cells (members) instead of names. */
function holdsCells(p: N): boolean {
  switch (p?.type) {
    case 'MemberExpression':
      return true
    case 'ObjectPattern':
      return p.properties.some((prop: N) => holdsCells(prop.type === 'RestElement' ? prop.argument : prop.value))
    case 'ArrayPattern':
      return p.elements.some((el: N) => el && holdsCells(el))
    case 'AssignmentPattern':
      return holdsCells(p.left)
    case 'RestElement':
      return holdsCells(p.argument)
    default:
      return false
  }
}

const nameOf = (n: N): string => (n.type === 'Identifier' ? n.name : n.value)

export function lower(program: Node, options: LowerOptions = {}): Lowered {
  const include = options.include ?? (() => true)
  const info = scope(program)
  const names = new Set(info.names)
  const fresh = (base: string) => {
    const name = freshName(base, names)
    names.add(name)
    return name
  }
  const param = fresh('meta')
  const envParam = fresh('env')
  const cell = (name: string) => member(id(envParam), name)

  /** A top-level binding of the module (an env cell), not an import. */
  const isCell = (binding: Binding | null | undefined): binding is Binding =>
    !!binding && binding.scope === info.root && !binding.import && binding.kind !== 'enum'

  /** source -> namespace variable (null: imported for side effects only). */
  const deps = new Map<string, string | null>()
  const dep = (source: string, needsNs: boolean) => {
    const ns = deps.get(source) ?? null
    if (!needsNs) {
      if (!deps.has(source)) deps.set(source, null)
      return ns
    }
    if (ns) return ns
    const name = fresh(baseName(source))
    deps.set(source, name)
    return name
  }

  /** Reading an imported binding: `ns.name`, or `ns` itself for `* as ns`. */
  const importRead = (binding: Binding): Node => {
    const ns = dep(binding.import!.source, true)!
    return binding.import!.name === '*' ? id(ns) : member(id(ns), binding.import!.name)
  }

  // --- module syntax: imports out, exports into the registry ------------------
  const exports = new Map<string, Node>()
  const exportAll: string[] = []
  const body: Node[] = []

  for (const st of (program as N).body as N[]) {
    const run = include(st)
    switch (st.type) {
      case 'ImportDeclaration': {
        if (st.importKind === 'type') break
        const values = st.specifiers.filter((s: N) => s.type !== 'Comment' && s.importKind !== 'type')
        dep(st.source.value, values.length > 0)
        break
      }
      case 'ExportNamedDeclaration': {
        if (st.exportKind === 'type') break
        if (st.declaration) {
          const d = st.declaration
          if (d.declare || /^TS(Interface|TypeAlias|Declare|Module)/.test(d.type)) break
          if (run) body.push(d)
          const declared = d.type === 'VariableDeclaration' ? d.declarations.flatMap((x: N) => patternNames(x.id)) : [d.id.name]
          for (const name of declared) exports.set(name, getter(cell(name)))
          break
        }
        const specs = st.specifiers.filter((s: N) => s.type === 'ExportSpecifier' && s.exportKind !== 'type')
        if (st.source) {
          const ns = dep(st.source.value, true)!
          for (const s of specs) exports.set(nameOf(s.exported), getter(member(id(ns), nameOf(s.local))))
        } else {
          for (const s of specs) {
            const binding = info.bindingOf(s.local)
            exports.set(nameOf(s.exported), getter(binding?.import ? importRead(binding) : cell(s.local.name)))
          }
        }
        break
      }
      case 'ExportAllDeclaration': {
        if (st.exportKind === 'type') break
        const ns = dep(st.source.value, true)!
        if (st.exported) exports.set(nameOf(st.exported), getter(id(ns)))
        else exportAll.push(ns)
        break
      }
      case 'ExportDefaultDeclaration': {
        const d = st.declaration
        if (/^TS/.test(d.type)) break
        const named = (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id
        if (named) {
          if (run) body.push(d)
          exports.set('default', getter(cell(d.id.name)))
        } else {
          const value = d.type === 'FunctionDeclaration' ? retype(d, 'FunctionExpression') : d.type === 'ClassDeclaration' ? retype(d, 'ClassExpression') : d
          if (run) body.push(stmt(assign(cell('default'), value)))
          exports.set('default', getter(cell('default')))
        }
        break
      }
      default:
        if (run) body.push(st)
    }
  }

  // --- names: cells, imports, import.meta, import() -------------------------
  const top = b.BlockStatement({ body })
  const hoisted: Node[] = []
  const importOf = (n: N): Binding | undefined => {
    const binding = info.bindingOf(n)
    return binding?.import && binding.declarations[0] !== n ? binding : undefined
  }
  /** What a name reads as: a cell, an import, or itself (undefined). */
  const read = (n: N): Node | undefined => {
    const imported = importOf(n)
    if (imported) return importRead(imported)
    if (isCell(info.bindingOf(n))) return cell(n.name)
  }
  /** `(0, x.f)`: call without `x` as `this`. */
  const detached = (target: Node) => b.SequenceExpression({ expressions: [b.Literal({ value: 0, raw: '0' }), target] })
  /** The name of a function or class stays a name. */
  const isOwnName = (ctx: Ctx) => ctx.key === 'id' && /^(Function|Class)(Declaration|Expression)$/.test(ctx.parent?.type ?? '')

  const rewrite = {
    Identifier(n: N, ctx: Ctx) {
      if (!isOwnName(ctx)) return read(n)
    },
    JSXIdentifier(n: N) {
      const binding = info.bindingOf(n)
      const jsx = (path: string[]): Node =>
        path.slice(1).reduce<Node>((object, name) => b.JSXMemberExpression({ object, property: b.JSXIdentifier({ name }) }), b.JSXIdentifier({ name: path[0] }))
      if (binding?.import && binding.declarations[0] !== n) {
        const ns = dep(binding.import.source, true)!
        return jsx(binding.import.name === '*' ? [ns] : [ns, binding.import.name])
      }
      if (isCell(binding)) return jsx([envParam, n.name])
    },
    CallExpression(n: N) {
      const target = n.callee.type === 'Identifier' && read(n.callee)
      if (target && !(n.callee.type === 'Identifier' && importOf(n.callee)?.import?.name === '*')) {
        return edit(n, (d: N) => void (d.callee = detached(target)))
      }
    },
    TaggedTemplateExpression(n: N) {
      const target = n.tag.type === 'Identifier' && read(n.tag)
      if (target) return edit(n, (d: N) => void (d.tag = detached(target)))
    },
    Property(n: N, ctx: Ctx) {
      if (!n.shorthand || !/^Object(Expression|Pattern)$/.test(ctx.parent?.type ?? '')) return
      const value = n.value.type === 'AssignmentPattern' ? n.value.left : n.value
      const target = read(value)
      if (!target) return
      return edit(n, (d: N) => {
        d.shorthand = false
        d.value = n.value.type === 'AssignmentPattern' ? edit(n.value, (p: N) => void (p.left = target)) : target
      })
    },
    MetaProperty(n: N) {
      if (n.meta.name === 'import' && n.property.name === 'meta') return id(param)
    },
    ImportExpression(n: N) {
      return call(member(id(param), 'import'), n.options ? [n.source, n.options] : [n.source])
    },
    // Declarations of cells become assignments to them.
    VariableDeclaration: {
      leave(n: N, ctx: Ctx) {
        const decls = n.declarations.filter((d: N) => d.type === 'VariableDeclarator')
        if (!decls.length || !holdsCells(decls[0].id)) return
        if (ctx.key === 'left') return decls[0].id // for (env.x of xs)
        // `var x` alone keeps the cell; `let x` resets it.
        const parts = decls
          .filter((d: N) => d.init || n.kind !== 'var')
          .map((d: N) => assign(d.id, d.init ?? voidZero()))
        const expr = parts.length === 1 ? parts[0] : b.SequenceExpression({ expressions: parts })
        if (ctx.key === 'init') return parts.length ? expr : null // for (env.i = 0; ...)
        return parts.length ? stmt(expr) : null
      },
    },
    FunctionDeclaration: {
      leave(n: N, ctx: Ctx) {
        if (ctx.parent !== top || !isCell(info.bindingOf(n.id))) return
        hoisted.push(stmt(assign(cell(n.id.name), retype(n, 'FunctionExpression'))))
        return null
      },
    },
    ClassDeclaration: {
      leave(n: N, ctx: Ctx) {
        if (ctx.parent !== top || !n.id || !isCell(info.bindingOf(n.id))) return
        return stmt(assign(cell(n.id.name), retype(n, 'ClassExpression')))
      },
    },
  }
  const rewritten = (walk(top, rewrite) as N).body as Node[]

  // --- the wrapper ----------------------------------------------------------
  const head: Node[] = [b.ExpressionStatement({ expression: str('use strict'), directive: 'use strict' })]
  if (exports.size) {
    const props = [...exports].map(([name, value]) =>
      b.Property({ key: key(name), value, kind: 'init', computed: false, method: false, shorthand: false }),
    )
    head.push(stmt(call(member(id(param), 'export'), [b.ObjectExpression({ properties: props })])))
  }
  head.push(...hoisted)
  for (const [source, ns] of deps) {
    const load = b.AwaitExpression({ argument: call(member(id(param), 'import'), [str(source)]) })
    head.push(ns ? constant(ns, load) : stmt(load))
  }
  for (const ns of exportAll) head.push(stmt(call(member(id(param), 'exportAll'), [id(ns)])))

  const fn = b.FunctionExpression({
    id: null,
    params: [id(param), id(envParam)],
    body: b.BlockStatement({ body: [...head, ...rewritten] }),
    async: true,
    generator: false,
    expression: false,
    declare: false,
  })
  const bindings = [...info.root.bindings.values()].filter(isCell).map((x) => x.name)
  return {
    ast: b.Program({ sourceType: 'script', body: [stmt(fn)] }),
    imports: [...deps.keys()],
    exports: [...exports.keys()],
    exportsAll: exportAll.length > 0,
    bindings,
  }
}

// lower(ast): canonical ESM -> a function the runtime can run. A compile step
// before execution; users and macros keep working on canonical ESM.
//
//   import d, { a } from './b.js'          (async function (meta) {
//   export const c = a + d                    'use strict'
//   export default c * 2                      meta.export({ c: () => c, default: () => _default })
//   import.meta.url; import('./x.js')   ->    const b = await meta.import('./b.js')
//                                             const c = b.a + b.default
//                                             const _default = c * 2
//                                             meta.url; meta.import('./x.js')
//                                           })
//
// - Exports are registered first, as getters: live bindings, TDZ like ESM, and
//   other modules (cycles too) read them through the runtime's records.
// - Uses of imported names become reads of the module's namespace: `a` -> `b.a`,
//   `a()` -> `(0, b.a)()` (no `this`), `{ a }` -> `{ a: b.a }`, `<A />` -> `<b.A />`.
// - `import.meta` -> the wrapper's parameter, `import(x)` -> `meta.import(x)`.
// - New names (`meta`, namespaces, `_default`) are fresh: no clash with the module's.
// Plain JS only for now: JSX and TS types are left as they are.
import { b } from '../ast/node.ts'
import { edit } from '../ast/edit.ts'
import { walk } from '../ast/walk.ts'
import { freshName, scope, type Binding } from '../ast/scope.ts'
import type { Node } from '../ast/node.ts'

export interface Lowered {
  /** A Program with one statement: the `(async function (meta) { ... })` wrapper. */
  ast: Node
  /** Static dependencies in source order, as written (`./b.js`). */
  imports: string[]
  /** Exported names. */
  exports: string[]
  /** Whether the module re-exports everything of some dependency (`export * from`). */
  exportsAll: boolean
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
const getter = (body: Node) =>
  b.ArrowFunctionExpression({ params: [], body, async: false, expression: true, generator: false, id: null })
const constant = (name: string, init: Node) =>
  b.VariableDeclaration({ kind: 'const', declare: false, declarations: [b.VariableDeclarator({ id: id(name), init, definite: false })] })

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

const nameOf = (n: N): string => (n.type === 'Identifier' ? n.name : n.value)

export function lower(program: Node): Lowered {
  const info = scope(program)
  const names = new Set(info.names)
  const fresh = (base: string) => {
    const name = freshName(base, names)
    names.add(name)
    return name
  }
  const param = fresh('meta')

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
          body.push(d)
          const declared = d.type === 'VariableDeclaration' ? d.declarations.flatMap((x: N) => patternNames(x.id)) : [d.id.name]
          for (const name of declared) exports.set(name, getter(id(name)))
          break
        }
        const specs = st.specifiers.filter((s: N) => s.type === 'ExportSpecifier' && s.exportKind !== 'type')
        if (st.source) {
          const ns = dep(st.source.value, true)!
          for (const s of specs) exports.set(nameOf(s.exported), getter(member(id(ns), nameOf(s.local))))
        } else {
          for (const s of specs) {
            const binding = info.bindingOf(s.local)
            exports.set(nameOf(s.exported), getter(binding?.import ? importRead(binding) : id(s.local.name)))
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
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
          const named = d.id ? d : edit(d, (draft: N) => void (draft.id = id(fresh('_default'))))
          body.push(named)
          exports.set('default', getter(id((named as N).id.name)))
        } else {
          const name = fresh('_default')
          body.push(constant(name, d))
          exports.set('default', getter(id(name)))
        }
        break
      }
      default:
        body.push(st)
    }
  }

  // --- uses of imports, import.meta, import() --------------------------------
  const importOf = (n: N): Binding | undefined => {
    const binding = info.bindingOf(n)
    return binding?.import && binding.declarations[0] !== n ? binding : undefined
  }
  /** `(0, ns.a)`: call an import without `ns` as `this`. */
  const detached = (binding: Binding) =>
    binding.import!.name === '*' ? importRead(binding) : b.SequenceExpression({ expressions: [b.Literal({ value: 0, raw: '0' }), importRead(binding)] })

  const rewrite = {
    Identifier(n: N) {
      const binding = importOf(n)
      if (binding) return importRead(binding)
    },
    JSXIdentifier(n: N) {
      const binding = importOf(n)
      if (!binding) return
      const ns = dep(binding.import!.source, true)!
      if (binding.import!.name === '*') return b.JSXIdentifier({ name: ns })
      return b.JSXMemberExpression({ object: b.JSXIdentifier({ name: ns }), property: b.JSXIdentifier({ name: binding.import!.name }) })
    },
    CallExpression(n: N) {
      const binding = n.callee.type === 'Identifier' && importOf(n.callee)
      if (binding) return edit(n, (d: N) => void (d.callee = detached(binding)))
    },
    TaggedTemplateExpression(n: N) {
      const binding = n.tag.type === 'Identifier' && importOf(n.tag)
      if (binding) return edit(n, (d: N) => void (d.tag = detached(binding)))
    },
    Property(n: N, ctx: N) {
      if (!n.shorthand || ctx.parent?.type !== 'ObjectExpression') return
      const binding = importOf(n.value)
      if (binding) return edit(n, (d: N) => void ((d.shorthand = false), (d.value = importRead(binding))))
    },
    MetaProperty(n: N) {
      if (n.meta.name === 'import' && n.property.name === 'meta') return id(param)
    },
    ImportExpression(n: N) {
      return call(member(id(param), 'import'), n.options ? [n.source, n.options] : [n.source])
    },
  }
  const rewritten = (walk(b.BlockStatement({ body }), rewrite) as N).body as Node[]

  // --- the wrapper ----------------------------------------------------------
  const head: Node[] = [b.ExpressionStatement({ expression: str('use strict'), directive: 'use strict' })]
  if (exports.size) {
    const props = [...exports].map(([name, value]) =>
      b.Property({ key: key(name), value, kind: 'init', computed: false, method: false, shorthand: false }),
    )
    head.push(stmt(call(member(id(param), 'export'), [b.ObjectExpression({ properties: props })])))
  }
  for (const [source, ns] of deps) {
    const load = b.AwaitExpression({ argument: call(member(id(param), 'import'), [str(source)]) })
    head.push(ns ? constant(ns, load) : stmt(load))
  }
  for (const ns of exportAll) head.push(stmt(call(member(id(param), 'exportAll'), [id(ns)])))

  const fn = b.FunctionExpression({
    id: null,
    params: [id(param)],
    body: b.BlockStatement({ body: [...head, ...rewritten] }),
    async: true,
    generator: false,
    expression: false,
    declare: false,
  })
  return {
    ast: b.Program({ sourceType: 'script', body: [stmt(fn)] }),
    imports: [...deps.keys()],
    exports: [...exports.keys()],
    exportsAll: exportAll.length > 0,
  }
}

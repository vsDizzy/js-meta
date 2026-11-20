// scope(ast): which declaration each identifier refers to. A snapshot of one tree
// (nodes are values: after an edit, analyze the new tree). Identity-keyed.
//
//   const info = scope(ast)
//   info.bindingOf(id)     -> Binding | null (null: free, a global) | undefined (not a name)
//   info.scopeOf(node)     -> the Scope a function/block/class/... creates
//   info.root.bindings     -> top-level names; binding.references, binding.import
//   info.free              -> globals by name
//   freshName('meta', info.names) -> a name not used anywhere in the tree
//
// JS semantics (strict, as in modules): `var` and parameters belong to the
// function, `let`/`const`/`class`/functions in blocks to the block, imports to
// the module. TypeScript types are skipped: they are not values.
import { slotsOf, type Node } from './node.ts'

export type BindingKind = 'var' | 'let' | 'const' | 'using' | 'function' | 'class' | 'param' | 'catch' | 'import' | 'enum'
export type ScopeKind = 'module' | 'function' | 'block' | 'class' | 'catch' | 'for' | 'switch'

export interface Binding {
  name: string
  kind: BindingKind
  scope: Scope
  /** Identifiers that declare it (`var a; var a` has two). */
  declarations: Node[]
  references: Reference[]
  /** For imports: the module and the name taken from it (`default`, `*`, or a named export). */
  import?: { source: string; name: string }
}

export interface Reference {
  /** An Identifier, or a JSXIdentifier naming a component (`<Foo />`). */
  node: Node
  scope: Scope
  /** Assigned to (`a = 1`, `a++`, `for (a of x)`). */
  write: boolean
  /** null when nothing in the tree declares it. */
  binding: Binding | null
}

export class Scope {
  readonly kind: ScopeKind
  readonly node: Node
  readonly parent: Scope | null
  bindings = new Map<string, Binding>()
  children: Scope[] = []
  constructor(kind: ScopeKind, node: Node, parent: Scope | null) {
    this.kind = kind
    this.node = node
    this.parent = parent
    parent?.children.push(this)
  }
  /** The binding `name` resolves to from here, or null. */
  lookup(name: string): Binding | null {
    for (let s: Scope | null = this; s; s = s.parent) {
      const b = s.bindings.get(name)
      if (b) return b
    }
    return null
  }
  /** Where `var` lands: the nearest function or module scope. */
  get functionScope(): Scope {
    let s: Scope = this
    while (s.kind !== 'function' && s.kind !== 'module' && s.parent) s = s.parent
    return s
  }
}

export interface ScopeInfo {
  root: Scope
  bindingOf(node: Node): Binding | null | undefined
  scopeOf(node: Node): Scope | undefined
  references: Reference[]
  free: Map<string, Reference[]>
  /** Every name in the tree, of any role: for picking fresh names. */
  names: Set<string>
}

/** `base`, or `base_1`, `base_2`, ... : the first that isn't in `taken`. */
export function freshName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 1; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
}

/** Slots that hold types, never values. */
const TYPE_SLOTS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeArguments', 'implements'])
/** Statements that only declare types (or overloads). */
const TYPE_ONLY = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
  'TSModuleDeclaration',
  'TSImportEqualsDeclaration',
  'TSNamespaceExportDeclaration',
  'TSIndexSignature',
])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export function scope(ast: Node): ScopeInfo {
  const scopes = new Map<Node, Scope>()
  const bindings = new Map<Node, Binding | null>()
  const pending: { node: N; scope: Scope; write: boolean }[] = []
  const names = new Set<string>()
  const root = new Scope('module', ast, null)
  scopes.set(ast, root)

  const open = (kind: ScopeKind, node: N, parent: Scope) => {
    const s = new Scope(kind, node, parent)
    scopes.set(node, s)
    return s
  }

  function declare(id: N, kind: BindingKind, s: Scope, extra?: Partial<Binding>) {
    names.add(id.name)
    let b = s.bindings.get(id.name)
    if (!b) {
      b = { name: id.name, kind, scope: s, declarations: [], references: [], ...extra }
      s.bindings.set(id.name, b)
    }
    b.declarations.push(id)
    bindings.set(id, b)
  }

  const ref = (node: N, s: Scope, write = false) => {
    names.add(node.name)
    pending.push({ node, scope: s, write })
  }

  /** Every child slot as an expression, types skipped (the fallback). */
  function children(n: N, s: Scope) {
    const slots = slotsOf(n.type)
    n.children.forEach((slot: N, i: number) => {
      if (slots && TYPE_SLOTS.has(slots[i])) return
      for (const c of Array.isArray(slot) ? slot : [slot]) if (c) visit(c, s)
    })
  }

  /** A binding pattern: `a`, `{ a, b: [c] }`, `a = 1`, `...rest`. */
  function pattern(p: N, kind: BindingKind, s: Scope, target: Scope) {
    if (!p) return
    switch (p.type) {
      case 'Identifier':
        return declare(p, kind, target)
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'RestElement') pattern(prop.argument, kind, s, target)
          else if (prop.type === 'Property') {
            if (prop.computed) visit(prop.key, s)
            pattern(prop.value, kind, s, target)
          }
        }
        return
      case 'ArrayPattern':
        for (const el of p.elements) if (el) pattern(el, kind, s, target)
        return
      case 'AssignmentPattern':
        pattern(p.left, kind, s, target)
        return visit(p.right, s)
      case 'RestElement':
        return pattern(p.argument, kind, s, target)
      case 'TSParameterProperty':
        return pattern(p.parameter, kind, s, target)
      default:
        return visit(p, s)
    }
  }

  /** An assignment target: like a pattern, but names are written references. */
  function target(p: N, s: Scope) {
    if (!p) return
    switch (p.type) {
      case 'Identifier':
        return ref(p, s, true)
      case 'ObjectPattern':
        for (const prop of p.properties) {
          if (prop.type === 'RestElement') target(prop.argument, s)
          else if (prop.type === 'Property') {
            if (prop.computed) visit(prop.key, s)
            target(prop.value, s)
          }
        }
        return
      case 'ArrayPattern':
        for (const el of p.elements) if (el) target(el, s)
        return
      case 'AssignmentPattern':
        target(p.left, s)
        return visit(p.right, s)
      case 'RestElement':
        return target(p.argument, s)
      default:
        return visit(p, s) // a.b = 1, (a as any) = 1
    }
  }

  function fn(n: N, s: Scope) {
    const f = open('function', n, s)
    if (n.type === 'FunctionExpression' && n.id) declare(n.id, 'function', f)
    for (const p of n.params) pattern(p, 'param', f, f)
    if (!n.body) return
    // The body block shares the function scope (`let` can't redeclare a param anyway).
    if (n.body.type === 'BlockStatement') {
      scopes.set(n.body, f)
      for (const st of n.body.body) visit(st, f)
    } else visit(n.body, f)
  }

  function cls(n: N, s: Scope) {
    if (n.type === 'ClassDeclaration' && n.id) declare(n.id, 'class', s)
    for (const d of n.decorators ?? []) visit(d, s)
    if (n.superClass) visit(n.superClass, s)
    const c = open('class', n, s)
    if (n.type === 'ClassExpression' && n.id) declare(n.id, 'class', c)
    if (n.body?.type === 'ClassBody') for (const m of n.body.body) visit(m, c)
    else visit(n.body, c)
  }

  /** Class members and object properties: the key is a name unless computed. */
  function member(n: N, s: Scope) {
    for (const d of n.decorators ?? []) visit(d, s)
    if (n.computed) visit(n.key, s)
    if (n.value) visit(n.value, s)
  }

  function jsxName(n: N, s: Scope) {
    if (n.type === 'JSXIdentifier') {
      // `<div>` is a tag, `<Foo>` a variable.
      if (/^[A-Z_$]/.test(n.name) || n.name.includes('.')) ref(n, s)
      else names.add(n.name)
    } else if (n.type === 'JSXMemberExpression') {
      let o = n.object
      while (o.type === 'JSXMemberExpression') o = o.object
      if (o.type === 'JSXIdentifier') ref(o, s)
    }
  }

  function visit(n: N, s: Scope): void {
    // Nodes of other families (`lua/...`) go through `children`; where one stands
    // in an ESTree node, a field read by name may be missing: nothing to visit.
    if (!n || TYPE_ONLY.has(n.type)) return
    switch (n.type) {
      case 'Comment':
      case 'Literal':
      case 'TemplateElement':
      case 'ThisExpression':
      case 'Super':
      case 'MetaProperty':
      case 'PrivateIdentifier':
      case 'JSXText':
      case 'JSXClosingFragment':
      case 'JSXOpeningFragment':
      case 'JSXEmptyExpression':
        return
      case 'Identifier':
        return ref(n, s)
      case 'MemberExpression':
        visit(n.object, s)
        if (n.computed) visit(n.property, s)
        return
      case 'Property':
      case 'MethodDefinition':
      case 'PropertyDefinition':
      case 'AccessorProperty':
      case 'TSAbstractMethodDefinition':
      case 'TSAbstractPropertyDefinition':
      case 'TSAbstractAccessorProperty':
        return member(n, s)
      case 'LabeledStatement':
        names.add(n.label.name)
        return visit(n.body, s)
      case 'BreakStatement':
      case 'ContinueStatement':
        return
      case 'AssignmentExpression':
        target(n.left, s)
        return visit(n.right, s)
      case 'UpdateExpression':
        return target(n.argument, s)
      case 'VariableDeclaration':
        for (const d of n.declarations) {
          const kind = n.kind === 'var' ? 'var' : n.kind === 'let' ? 'let' : n.kind === 'const' ? 'const' : 'using'
          pattern(d.id, kind, s, kind === 'var' ? s.functionScope : s)
          if (d.init) visit(d.init, s)
        }
        return
      case 'FunctionDeclaration':
        if (n.id) declare(n.id, 'function', s)
        return fn(n, s)
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'TSEmptyBodyFunctionExpression':
        return fn(n, s)
      case 'ClassDeclaration':
      case 'ClassExpression':
        return cls(n, s)
      case 'StaticBlock': {
        const f = open('function', n, s)
        for (const st of n.body) visit(st, f)
        return
      }
      case 'BlockStatement': {
        const b = open('block', n, s)
        for (const st of n.body) visit(st, b)
        return
      }
      case 'ForStatement': {
        const f = open('for', n, s)
        if (n.init) visit(n.init, f)
        if (n.test) visit(n.test, f)
        if (n.update) visit(n.update, f)
        return visit(n.body, f)
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const f = open('for', n, s)
        if (n.left.type === 'VariableDeclaration') visit(n.left, f)
        else target(n.left, f)
        visit(n.right, f)
        return visit(n.body, f)
      }
      case 'SwitchStatement': {
        visit(n.discriminant, s)
        const sw = open('switch', n, s)
        for (const c of n.cases) visit(c, sw)
        return
      }
      case 'CatchClause': {
        const c = open('catch', n, s)
        if (n.param) pattern(n.param, 'catch', c, c)
        scopes.set(n.body, c)
        for (const st of n.body.body) visit(st, c)
        return
      }
      case 'ImportDeclaration':
        if (n.importKind === 'type') return
        for (const sp of n.specifiers) {
          if (sp.type === 'Comment' || sp.importKind === 'type') continue
          const name =
            sp.type === 'ImportDefaultSpecifier' ? 'default'
            : sp.type === 'ImportNamespaceSpecifier' ? '*'
            : sp.imported.type === 'Identifier' ? sp.imported.name : sp.imported.value
          declare(sp.local, 'import', root, { import: { source: n.source.value, name } })
        }
        return
      case 'ExportNamedDeclaration':
        if (n.exportKind === 'type') return
        if (n.declaration) return visit(n.declaration, s)
        // `export { a as b }` reads the local `a`; `export { a } from './x'` doesn't.
        if (!n.source) {
          for (const sp of n.specifiers) if (sp.type === 'ExportSpecifier' && sp.exportKind !== 'type') visit(sp.local, s)
        }
        return
      case 'ExportDefaultDeclaration':
        return visit(n.declaration, s)
      case 'ExportAllDeclaration':
        return
      case 'TSEnumDeclaration':
        declare(n.id, 'enum', s)
        for (const m of n.body.members) if (m.type === 'TSEnumMember' && m.initializer) visit(m.initializer, s)
        return
      case 'JSXOpeningElement':
        jsxName(n.name, s)
        for (const a of n.attributes) visit(a, s)
        return
      case 'JSXClosingElement':
        return jsxName(n.name, s)
      case 'JSXAttribute':
        if (n.value) visit(n.value, s)
        return
      default:
        return children(n, s)
    }
  }

  visit(ast as N, root)

  const references: Reference[] = []
  const free = new Map<string, Reference[]>()
  for (const p of pending) {
    const binding = p.scope.lookup(p.node.name)
    const r: Reference = { node: p.node, scope: p.scope, write: p.write, binding }
    references.push(r)
    bindings.set(p.node, binding)
    if (binding) binding.references.push(r)
    else {
      let list = free.get(p.node.name)
      if (!list) free.set(p.node.name, (list = []))
      list.push(r)
    }
  }

  return {
    root,
    references,
    free,
    names,
    bindingOf: (node) => bindings.get(node),
    scopeOf: (node) => scopes.get(node),
  }
}

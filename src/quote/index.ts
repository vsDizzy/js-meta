// Quasiquote and pattern matching on code:
//
//   const m = match(node, js`$a + $b`)
//   if (m) return js`add(${m.a}, ${m.b})`
//
// `js` parses a tagged template with our `read` and puts the `${}` values in.
// `${}` always means a value from JS: a node, an array of nodes (spliced into a
// list), a string, number, boolean, null, bigint or RegExp. In a pattern, `$a`
// is a variable, `$$a` a sequence in a list, `$_` / `$$_` match without capturing.
import { attrsOf, make, Node, slotsOf, toNode, type Slot } from '../ast/node.ts'
import { originOf, setOrigin } from '../ast/origin.ts'
import { read, ReadError } from '../read/index.ts'

type Mode = 'expr' | 'stmt' | 'stmts'

interface Template {
  /** Parsed once per call site, without origins (a result maps to where it's used). */
  tree: Node | Node[]
  /** Placeholder identifiers are `${prefix}${index}`. */
  prefix: string
  /** For messages: the template with `${…}` for the holes. */
  shown: string
}

const cache = new WeakMap<TemplateStringsArray, Partial<Record<Mode, Template>>>()

function template(strings: TemplateStringsArray, mode: Mode): Template {
  let byMode = cache.get(strings)
  if (!byMode) cache.set(strings, (byMode = {}))
  return (byMode[mode] ??= parse(strings, mode))
}

const isComment = (n: Slot) => n !== null && !Array.isArray(n) && n.type === 'Comment'

function parse(strings: TemplateStringsArray, mode: Mode): Template {
  // Raw text is the source as written; only the template's own escapes go away.
  const raw = strings.raw.map((s) => s.replace(/\\(`|\$\{)/g, '$1'))
  const all = raw.join('')
  let prefix = '__js_hole_'
  while (all.includes(prefix)) prefix += '_'
  const text = raw.reduce((acc, s, i) => acc + prefix + (i - 1) + s)
  const shown = 'js`' + strings.raw.join('${…}') + '`'
  const statements = (src: string) => read(src, { filename: 'js.jsx' }).body.map(bare)

  const fail = (err: unknown): never => {
    if (!(err instanceof ReadError)) throw err
    const message = err.message.replace(/ \([^()]*\)$/, '')
    throw new SyntaxError(`${message} (line ${err.line}, column ${err.column + 1}) in ${shown}`)
  }
  const one = (list: Node[]) => {
    const code = list.filter((n) => !isComment(n))
    if (code.length === 1) return code[0]
    throw new SyntaxError(`${code.length ? 'several statements' : 'nothing'} in ${shown}${code.length ? ': use js.stmts' : ''}`)
  }

  let tree: Node | Node[]
  if (mode === 'expr') {
    // Expression first: `{ a }` is an object, `function f() {}` an expression
    // (it becomes a declaration where a statement is put).
    let expr: Node | undefined
    try {
      const code = statements(`(\n${text}\n)`).filter((n) => !isComment(n))
      if (code.length === 1 && code[0].type === 'ExpressionStatement') expr = code[0].children[0] as Node
    } catch {}
    if (expr) tree = expr
    else {
      let list: Node[] = []
      try {
        list = statements(text)
      } catch (err) {
        fail(err)
      }
      tree = one(list)
    }
  } else {
    let list: Node[] = []
    try {
      list = statements(text)
    } catch (err) {
      fail(err)
    }
    tree = mode === 'stmt' ? one(list) : list
  }
  checkStrings(tree, prefix, shown)
  return { tree, prefix, shown }
}

/** A copy without origins: template nodes take the origin of what they replace. */
function bare(node: Node): Node {
  return make(node.type, attrsOf(node), node.children.map((s) => (Array.isArray(s) ? s.map((n) => n && bare(n)) : s && bare(s))))
}

function checkStrings(tree: Node | Node[], prefix: string, shown: string) {
  const visit = (n: Node | null) => {
    if (!n) return
    const texts = [n.type === 'Literal' && typeof n.value === 'string' ? n.value : '', (n.value as { raw?: string })?.raw ?? '']
    if (n.type === 'JSXText') texts.push(String(n.value))
    if (texts.some((t) => typeof t === 'string' && t.includes(prefix))) {
      throw new SyntaxError(`a \${} inside a string or JSX text in ${shown}: put a whole node there instead`)
    }
    for (const s of n.children) Array.isArray(s) ? s.forEach(visit) : visit(s)
  }
  Array.isArray(tree) ? tree.forEach(visit) : visit(tree)
}

// --- where a hole stands, and what a value becomes there ---

type Role = 'expression' | 'name' | 'statement' | 'property' | 'member' | 'jsxChild' | 'jsxName'

/** Slots where only a name (or pattern) can stand; a string there is an identifier. */
const NAME_SLOTS: Record<string, string[]> = {
  VariableDeclarator: ['id'],
  FunctionDeclaration: ['id', 'params'],
  FunctionExpression: ['id', 'params'],
  ArrowFunctionExpression: ['params'],
  ClassDeclaration: ['id'],
  ClassExpression: ['id'],
  CatchClause: ['param'],
  LabeledStatement: ['label'],
  BreakStatement: ['label'],
  ContinueStatement: ['label'],
  ImportSpecifier: ['imported', 'local'],
  ImportDefaultSpecifier: ['local'],
  ImportNamespaceSpecifier: ['local'],
  ExportSpecifier: ['local', 'exported'],
  AssignmentPattern: ['left'],
  ArrayPattern: ['elements'],
  RestElement: ['argument'],
  AssignmentExpression: ['left'],
  UpdateExpression: ['argument'],
  ForInStatement: ['left'],
  ForOfStatement: ['left'],
  Property: ['key'],
  MethodDefinition: ['key'],
  PropertyDefinition: ['key'],
  AccessorProperty: ['key'],
  MemberExpression: ['property'],
}
const KEYED = new Set(['Property', 'MethodDefinition', 'PropertyDefinition', 'AccessorProperty'])

interface Hole {
  index: number
  role: Role
}

const slotOf = (n: Node, name: string) => n.children[slotsOf(n.type)!.indexOf(name)] ?? null

/** The hole that `node` is, in slot `key` of `parent`; wrapper forms count only where noted. */
function holeAt(node: Node, parent: Node, key: string, inList: boolean, inPattern: boolean, prefix: string): Hole | undefined {
  const index = (n: Slot) =>
    n && !Array.isArray(n) && (n.type === 'Identifier' || n.type === 'JSXIdentifier') && typeof n.name === 'string' && n.name.startsWith(prefix)
      ? Number(n.name.slice(prefix.length))
      : undefined
  let i: number | undefined
  if (node.type === 'ExpressionStatement' && !node.directive && (i = index(node.children[0])) !== undefined) return { index: i, role: 'statement' }
  if (inList) {
    if (node.type === 'Property' && node.shorthand && (i = index(slotOf(node, 'value'))) !== undefined) return { index: i, role: 'property' }
    if (node.type === 'PropertyDefinition' && !node.computed && !node.static && !slotOf(node, 'value') && (i = index(slotOf(node, 'key'))) !== undefined) {
      return { index: i, role: 'member' }
    }
    if (node.type === 'JSXExpressionContainer' && (i = index(node.children[0])) !== undefined) return { index: i, role: 'jsxChild' }
  }
  if ((i = index(node)) === undefined) return undefined
  if (node.type === 'JSXIdentifier') return { index: i, role: 'jsxName' }
  const named = NAME_SLOTS[parent.type]?.includes(key) && !(parent.computed && (KEYED.has(parent.type) || parent.type === 'MemberExpression'))
  return { index: i, role: named || (parent.type === 'Property' && key === 'value' && inPattern) ? 'name' : 'expression' }
}

const PATTERNS = new Set(['ObjectPattern', 'ArrayPattern', 'RestElement', 'AssignmentPattern'])

/** The template's tree with the values put in; untouched subtrees are shared. */
function fill(t: Template, values: unknown[]): Node | Node[] {
  const put = (hole: Hole, item: unknown) => coerce(item, hole, t.shown)
  const visit = (node: Node, inPattern: boolean): Node => {
    const slots = slotsOf(node.type) ?? []
    let changed = false
    const children = node.children.map((slot, s): Slot => {
      const key = slots[s]
      const pattern = inPattern || PATTERNS.has(node.type) || !!NAME_SLOTS[node.type]?.includes(key)
      if (Array.isArray(slot)) {
        const out: (Node | null)[] = []
        for (const el of slot) {
          const hole = el && holeAt(el, node, key, true, pattern, t.prefix)
          if (!hole) {
            const next = el && visit(el, pattern)
            if (next !== el) changed = true
            out.push(next)
            continue
          }
          changed = true
          const v = values[hole.index]
          if (Array.isArray(v)) for (const item of v) out.push(put(hole, item))
          else out.push(put(hole, v))
        }
        return out
      }
      if (!slot) return slot
      const hole = holeAt(slot, node, key, false, pattern, t.prefix)
      if (!hole) {
        const next = visit(slot, pattern)
        if (next !== slot) changed = true
        return next
      }
      changed = true
      const v = values[hole.index]
      if (Array.isArray(v)) throw new TypeError(`\${} #${hole.index + 1} is an array, but it stands where a single node goes, in ${t.shown}`)
      return put(hole, v)
    })
    if (!changed) return node
    const attrs = attrsOf(node)
    // A key or member property that isn't a plain name becomes computed: `a.${'my-key'}` is `a['my-key']`.
    const keySlot = node.type === 'MemberExpression' ? 'property' : KEYED.has(node.type) ? 'key' : undefined
    if (keySlot && !attrs.computed) {
      const k = children[slots.indexOf(keySlot)] as Node | null
      if (k && k.type !== 'Identifier' && k.type !== 'PrivateIdentifier' && (node.type === 'MemberExpression' || k.type !== 'Literal')) attrs.computed = true
    }
    return make(node.type, attrs, children)
  }

  // The root may itself be a hole: `js\`${x}\``.
  const root = make('Program', {}, [Array.isArray(t.tree) ? t.tree : [t.tree]])
  const body = visit(root, false).children[0] as Node[]
  if (Array.isArray(t.tree)) return body
  if (body.length !== 1) throw new TypeError(`\${} spliced ${body.length} nodes where one goes, in ${t.shown}`)
  return body[0]
}

const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u

function coerce(value: unknown, { index, role }: Hole, shown: string): Node {
  const where = `\${} #${index + 1} in ${shown}`
  if (value === undefined) throw new TypeError(`${where} is undefined`)
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`${where} is a ${typeof value}, not a node`)
  const isNode = typeof value === 'object' && value !== null && !(value instanceof RegExp)
  if (isNode && typeof (value as { type?: unknown }).type !== 'string') throw new TypeError(`${where} is an object, not a node`)
  const node = isNode ? toNode(value) : undefined

  switch (role) {
    case 'expression':
      return node ? asExpression(node, where) : literal(value)
    case 'name':
      if (node) return node
      if (typeof value === 'string') {
        if (IDENT.test(value)) return ident(value)
        return literal(value) // a key: `{ 'my-key': 1 }`, `a['my-key']`
      }
      return literal(value)
    case 'statement':
      return asStatement(node ?? literal(value))
    case 'property':
      if (node) {
        if (['Property', 'SpreadElement', 'RestElement'].includes(node.type)) return node
        throw new TypeError(`${where}: a ${node.type} can't be a property`)
      }
      if (typeof value === 'string' && IDENT.test(value)) {
        return make('Property', { computed: false, kind: 'init', method: false, optional: false, shorthand: true }, [ident(value), ident(value)])
      }
      throw new TypeError(`${where}: ${JSON.stringify(value)} can't be a property`)
    case 'member':
      if (node && /^(MethodDefinition|PropertyDefinition|AccessorProperty|StaticBlock|Comment)$/.test(node.type)) return node
      throw new TypeError(`${where}: not a class member`)
    case 'jsxChild':
      if (node && /^JSX/.test(node.type)) return node
      return make('JSXExpressionContainer', {}, [node ? asExpression(node, where) : literal(value)])
    case 'jsxName':
      if (typeof value === 'string') return make('JSXIdentifier', { name: value }, [])
      if (node?.type === 'Identifier') return make('JSXIdentifier', { name: node.name }, [])
      if (node && /^JSX(Identifier|MemberExpression|NamespacedName)$/.test(node.type)) return node
      throw new TypeError(`${where}: not a JSX name`)
  }
}

function retype(node: Node, type: string): Node {
  const out = make(type, attrsOf(node), node.children)
  const origin = originOf(node)
  if (origin) setOrigin(out, origin)
  return out
}

function asExpression(node: Node, where: string): Node {
  if (node.type === 'FunctionDeclaration') return retype(node, 'FunctionExpression')
  if (node.type === 'ClassDeclaration') return retype(node, 'ClassExpression')
  if (node.type === 'ExpressionStatement' && !node.directive) return node.children[0] as Node
  if (/Statement$/.test(node.type)) throw new TypeError(`${where}: a ${node.type} can't stand where an expression goes`)
  return node
}

function asStatement(node: Node): Node {
  const id = (slotsOf(node.type) ?? []).includes('id') ? slotOf(node, 'id') : null
  if (node.type === 'FunctionExpression' && id) return retype(node, 'FunctionDeclaration')
  if (node.type === 'ClassExpression' && id) return retype(node, 'ClassDeclaration')
  if (/Statement$|Declaration$/.test(node.type) || node.type === 'Comment') return node
  return make('ExpressionStatement', {}, [node])
}

const ident = (name: string) => make('Identifier', { name, optional: false }, [[], null])

/** Single-quoted, as most JS is written. */
const quote = (s: string) => `'${JSON.stringify(s).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`

function literal(value: unknown): Node {
  if (typeof value === 'string') return make('Literal', { raw: quote(value), value }, [])
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ident('NaN')
    if (value < 0 || Object.is(value, -0)) return make('UnaryExpression', { operator: '-', prefix: true }, [literal(-value)])
    if (value === Infinity) return ident('Infinity')
    return make('Literal', { raw: String(value), value }, [])
  }
  if (typeof value === 'boolean' || value === null) return make('Literal', { raw: String(value), value }, [])
  if (typeof value === 'bigint') return make('Literal', { bigint: String(value), raw: `${value}n`, value }, [])
  if (value instanceof RegExp) return make('Literal', { raw: String(value), regex: { flags: value.flags, pattern: value.source }, value }, [])
  throw new TypeError(`not a literal: ${String(value)}`)
}

// --- the tags ---

export interface Js {
  /** An expression, or else one statement: `js\`${a} + 1\``. */
  (strings: TemplateStringsArray, ...values: unknown[]): Node
  /** Exactly one statement, read as in a file: `{}` is a block. */
  stmt(strings: TemplateStringsArray, ...values: unknown[]): Node
  /** A list of statements. */
  stmts(strings: TemplateStringsArray, ...values: unknown[]): Node[]
  /** An identifier: a string in `${}` is a literal where an expression goes. */
  id(name: string): Node
}

export const js: Js = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => fill(template(strings, 'expr'), values) as Node, {
  stmt: (strings: TemplateStringsArray, ...values: unknown[]) => fill(template(strings, 'stmt'), values) as Node,
  stmts: (strings: TemplateStringsArray, ...values: unknown[]) => fill(template(strings, 'stmts'), values) as Node[],
  id: (name: string) => ident(name),
})

export { match, type Captures } from './match.ts'

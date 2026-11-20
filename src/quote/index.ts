// Quasiquote and pattern matching on code:
//
//   const m = match(node, js`$a + $b`)
//   if (m) return js`add(${m.a}, ${m.b})`
//
// `js` parses a tagged template with our `read` and puts the `${}` values in.
// `${}` always means a value from JS: a node, an array of nodes (spliced into a
// list), a string, number, boolean, null, bigint or RegExp. In a pattern, `$a`
// is a variable, `$$a` a sequence in a list, `$_` / `$$_` match without capturing.
//
// Comments in a template stay in the nodes. Those around the root (before or
// after it) go in front of it, in its `comments`: `js\`/* @__PURE__ */ $f()\``.
// A comment that is just a hole stands for comments: `/* ${c} */` puts a
// Comment node or an array of them there; in a replacement, `/* $c */` puts the
// captured comment and `/* $$cs */` the captured ones.
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
    if (code.length === 1) return gather(list, code[0])
    throw new SyntaxError(`${code.length ? 'several statements' : 'nothing'} in ${shown}${code.length ? ': use js.stmts' : ''}`)
  }

  let tree: Node | Node[]
  if (mode === 'expr') {
    // Expression first: `{ a }` is an object, `function f() {}` an expression
    // (it becomes a declaration where a statement is put).
    let expr: Node | undefined
    try {
      const list = statements(`(\n${text}\n)`)
      const code = list.filter((n) => !isComment(n))
      if (code.length === 1 && code[0].type === 'ExpressionStatement') expr = gather(list, code[0], code[0].children[0] as Node)
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

/**
 * `root` (the statement `stmt` of `list`, or its expression) with the comments
 * around it in front: `read` puts some of them in the list (a line comment, one
 * with nothing after it), but a template's root has no list.
 */
function gather(list: Node[], stmt: Node, root: Node = stmt): Node {
  const i = list.indexOf(stmt)
  const comments = [...list.slice(0, i), ...(root === stmt ? [] : leadOf(stmt)), ...leadOf(root), ...list.slice(i + 1)]
  if (comments.length === leadOf(root).length) return root
  // In source order: `read` leaves some in place and hoists others.
  comments.sort((a, b) => (written.get(a) ?? 0) - (written.get(b) ?? 0))
  return make(root.type, { ...attrsOf(root), comments }, root.children)
}

/** Where a template's comment was written in its text, to keep comments in source order. */
const written = new WeakMap<Node, number>()

/** A copy without origins: template nodes take the origin of what they replace. */
function bare(node: Node): Node {
  const attrs = attrsOf(node)
  if (Array.isArray(attrs.comments)) attrs.comments = attrs.comments.map(bare)
  if (node.type === 'Comment') {
    const copy = make(node.type, attrs, node.children)
    written.set(copy, originOf(node)?.start ?? 0)
    return copy
  }
  return make(node.type, attrs, node.children.map((s) => (Array.isArray(s) ? s.map((n) => n && bare(n)) : s && bare(s))))
}

const leadOf = (n: Node | null | undefined) => (n?.comments as Node[] | undefined) ?? []

function checkStrings(tree: Node | Node[], prefix: string, shown: string) {
  const visit = (n: Node | null) => {
    if (!n) return
    if (n.type === 'Comment') {
      if (String(n.value).includes(prefix) && !commentName(n)?.startsWith(prefix)) {
        throw new SyntaxError(`a \${} inside a comment in ${shown}: a comment can only be a hole as a whole, /* \${c} */`)
      }
      return
    }
    const texts = [n.type === 'Literal' && typeof n.value === 'string' ? n.value : '', (n.value as { raw?: string })?.raw ?? '']
    if (n.type === 'JSXText') texts.push(String(n.value))
    if (texts.some((t) => typeof t === 'string' && t.includes(prefix))) {
      throw new SyntaxError(`a \${} inside a string or JSX text in ${shown}: put a whole node there instead`)
    }
    leadOf(n).forEach(visit)
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

/** How holes are spotted and filled: `${}` placeholders for `js`, `$a` variables for `substitute`. */
interface Holes {
  /** The hole an identifier name stands for, if any. */
  key(name: string): string | number | undefined
  value(key: string | number): unknown
  /** For messages: `${} #2`, `$a`. */
  label(key: string | number): string
  /** For messages: the template. */
  shown: string
}

interface Hole {
  key: string | number
  role: Role
}

const slotOf = (n: Node, name: string) => n.children[slotsOf(n.type)!.indexOf(name)] ?? null

/** The hole that `node` is, in slot `key` of `parent`; wrapper forms count only where noted. */
function holeAt(node: Node, parent: Node, key: string, inList: boolean, inPattern: boolean, h: Holes): Hole | undefined {
  const index = (n: Slot) =>
    n && !Array.isArray(n) && (n.type === 'Identifier' || n.type === 'JSXIdentifier') && typeof n.name === 'string' ? h.key(n.name) : undefined
  let i: string | number | undefined
  if (node.type === 'ExpressionStatement' && !node.directive && (i = index(node.children[0])) !== undefined) return { key: i, role: 'statement' }
  if (inList) {
    if (node.type === 'Property' && node.shorthand && (i = index(slotOf(node, 'value'))) !== undefined) return { key: i, role: 'property' }
    if (node.type === 'PropertyDefinition' && !node.computed && !node.static && !slotOf(node, 'value') && (i = index(slotOf(node, 'key'))) !== undefined) {
      return { key: i, role: 'member' }
    }
    if (node.type === 'JSXExpressionContainer' && (i = index(node.children[0])) !== undefined) return { key: i, role: 'jsxChild' }
  }
  if ((i = index(node)) === undefined) return undefined
  if (node.type === 'JSXIdentifier') return { key: i, role: 'jsxName' }
  const named = NAME_SLOTS[parent.type]?.includes(key) && !(parent.computed && (KEYED.has(parent.type) || parent.type === 'MemberExpression'))
  return { key: i, role: named || (parent.type === 'Property' && key === 'value' && inPattern) ? 'name' : 'expression' }
}

const PATTERNS = new Set(['ObjectPattern', 'ArrayPattern', 'RestElement', 'AssignmentPattern'])

/** Lists `read` puts no comments in (as in read/comments.ts): there a comment leads its element. */
const NO_COMMENT_LISTS = new Set(['TemplateLiteral', 'TSTemplateLiteralType'])

/** `node` with `comments` in front (none if empty): a copy that keeps the origin, or `node` if they are the same. */
function setLead(node: Node, comments: Node[]): Node {
  const now = leadOf(node)
  if (now.length === comments.length && now.every((c, i) => c === comments[i])) return node
  const attrs = attrsOf(node)
  if (comments.length) attrs.comments = comments
  else delete attrs.comments
  const out = make(node.type, attrs, node.children)
  const origin = originOf(node)
  if (origin) setOrigin(out, origin)
  return out
}

const isCommentValue = (v: unknown) => typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'Comment'

/** What a comment hole stands for: a Comment node or an array of them. */
function toComments(value: unknown, where: string): Node[] {
  return (Array.isArray(value) ? value : [value]).map((c) => {
    if (isCommentValue(c)) return toNode(c)
    const what = typeof c === 'object' && c !== null && typeof (c as { type?: unknown }).type === 'string' ? `a ${(c as Node).type}` : typeof c
    throw new TypeError(`${where} stands for a comment, but it is ${what}, not a Comment node`)
  })
}

/** `tree` with the holes filled; untouched subtrees are shared. */
function fill(tree: Node | Node[], h: Holes): Node | Node[] {
  const put = (hole: Hole, item: unknown) => coerce(item, hole, h)
  /** The comments that comment `c` stands for, if it is a hole (`/* $c *\/`). */
  const commentHole = (c: Node): Node[] | undefined => {
    const name = commentName(c)
    const key = name === undefined ? undefined : h.key(name)
    return key === undefined ? undefined : toComments(h.value(key), `${h.label(key)} in ${h.shown}`)
  }
  /** `list` with its comment holes filled; the same array if it has none. */
  const comments = (list: Node[]): Node[] => {
    let changed = false
    const out = list.flatMap((c) => {
      const filled = commentHole(c)
      if (filled) changed = true
      return filled ?? [c]
    })
    return changed ? out : list
  }
  /** The leading comments of a hole, filled. */
  const holeLead = (hole: Node) =>
    // `{/* c */ ${kids}}`: the comment sits on the placeholder inside the wrapper.
    comments([...leadOf(hole), ...(hole.type === 'JSXExpressionContainer' ? leadOf(hole.children[0] as Node) : [])])
  /** `node` with the leading comments of the hole it fills first: `/* @__PURE__ *\/ ${call}`. */
  const withLead = (hole: Node, node: Node): Node => {
    const lead = holeLead(hole)
    // A captured comment may already be on the captured node: `/* $c */ $call`.
    return lead.length ? setLead(node, [...lead, ...leadOf(node).filter((c) => !lead.includes(c))]) : node
  }
  const root = make('Program', {}, [Array.isArray(tree) ? tree : [tree]])
  const visit = (node: Node, inPattern: boolean): Node => {
    const slots = slotsOf(node.type) ?? []
    const own = leadOf(node)
    const lead = comments(own)
    let changed = lead !== own
    const children = node.children.map((slot, s): Slot => {
      const key = slots[s]
      const pattern = inPattern || PATTERNS.has(node.type) || !!NAME_SLOTS[node.type]?.includes(key)
      if (Array.isArray(slot)) {
        const out: (Node | null)[] = []
        for (const el of slot) {
          if (el?.type === 'Comment') {
            const filled = commentHole(el)
            if (filled) changed = true
            out.push(...(filled ?? [el]))
            continue
          }
          const hole = el && holeAt(el, node, key, true, pattern, h)
          if (!hole) {
            const next = el && visit(el, pattern)
            if (next !== el) changed = true
            out.push(next)
            continue
          }
          changed = true
          const v = h.value(hole.key)
          // Comments in a run (`$$body`) stay comments, before the element they lead.
          const items = (Array.isArray(v) ? v : [v]).map((item) => (isCommentValue(item) ? toNode(item) : put(hole, item)))
          const first = items.findIndex((n) => n.type !== 'Comment')
          if (first >= 0) items[first] = withLead(el, items[first])
          else items.push(...holeLead(el))
          // In a list the comments in front of an element are its siblings, as
          // `read` gives them (and a line comment can only be printed there).
          // Not in the template's own root, which is a single node.
          const siblings = node !== root || Array.isArray(tree)
          out.push(...(siblings && !NO_COMMENT_LISTS.has(node.type) ? items.flatMap((n) => [...leadOf(n), setLead(n, [])]) : items))
        }
        return out
      }
      if (!slot) return slot
      const hole = holeAt(slot, node, key, false, pattern, h)
      if (!hole) {
        const next = visit(slot, pattern)
        if (next !== slot) changed = true
        return next
      }
      changed = true
      const v = h.value(hole.key)
      if (Array.isArray(v)) throw new TypeError(`${h.label(hole.key)} is an array, but it stands where a single node goes, in ${h.shown}`)
      return withLead(slot, put(hole, v))
    })
    if (!changed) return node
    const attrs = attrsOf(node)
    if (lead.length) attrs.comments = lead
    else delete attrs.comments
    // A key or member property that isn't a plain name becomes computed: `a.${'my-key'}` is `a['my-key']`.
    const keySlot = node.type === 'MemberExpression' ? 'property' : KEYED.has(node.type) ? 'key' : undefined
    if (keySlot && !attrs.computed) {
      const k = children[slots.indexOf(keySlot)] as Node | null
      if (k && k.type !== 'Identifier' && k.type !== 'PrivateIdentifier' && (node.type === 'MemberExpression' || k.type !== 'Literal')) attrs.computed = true
    }
    return make(node.type, attrs, children)
  }

  // The root may itself be a hole: `js\`${x}\``.
  const body = visit(root, false).children[0] as Node[]
  if (Array.isArray(tree)) return body
  if (body.length !== 1) throw new TypeError(`a hole spliced ${body.length} nodes where one goes, in ${h.shown}`)
  return body[0]
}

const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u

function coerce(value: unknown, { key, role }: Hole, h: Holes): Node {
  const where = `${h.label(key)} in ${h.shown}`
  if (value === undefined) throw new TypeError(`${where} is undefined`)
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`${where} is a ${typeof value}, not a node`)
  const isNode = typeof value === 'object' && value !== null && !(value instanceof RegExp)
  if (isNode && typeof (value as { type?: unknown }).type !== 'string') throw new TypeError(`${where} is an object, not a node`)
  const node = isNode ? toNode(value) : undefined
  if (node?.type === 'Comment') throw new TypeError(`${where} is a Comment: it goes in a list, or in a comment hole (/* $c */)`)

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
      if (node && /^(MethodDefinition|PropertyDefinition|AccessorProperty|StaticBlock)$/.test(node.type)) return node
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
  if (/Statement$|Declaration$/.test(node.type)) return node
  // The comments in front of the expression go in front of the statement, as `read` puts them.
  const comments = leadOf(node)
  return make('ExpressionStatement', comments.length ? { comments } : {}, [setLead(node, [])])
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

const tag = (mode: Mode) => (strings: TemplateStringsArray, ...values: unknown[]) => {
  const t = template(strings, mode)
  return fill(t.tree, {
    key: (name) => (name.startsWith(t.prefix) ? Number(name.slice(t.prefix.length)) : undefined),
    value: (i) => values[i as number],
    label: (i) => `\${} #${(i as number) + 1}`,
    shown: t.shown,
  })
}

export const js: Js = Object.assign(tag('expr') as Js, {
  stmt: tag('stmt') as Js['stmt'],
  stmts: tag('stmts') as Js['stmts'],
  id: (name: string) => ident(name),
})

/** A template written with pattern variables (`js\`($a + $b)\``), with the captures put in. */
export function substitute(template: Node | Node[], captures: Captures): Node | Node[] {
  return fill(template, {
    key: (name) => {
      const v = variable(name)
      if (!v) return undefined
      if (v.name === '_') throw new TypeError(`${name} in a replacement: it matches anything, so there is nothing to put in`)
      return v.name
    },
    value: (name) => {
      if (!((name as string) in captures)) throw new TypeError(`$${name as string} in a replacement is not captured by the pattern`)
      return captures[name as string]
    },
    label: (name) => `$${name as string}`,
    shown: 'the replacement',
  })
}

import { commentName, variable, type Captures } from './match.ts'
export { match, type Captures, type MatchContext } from './match.ts'
export { rule, rules, type Rule } from './rule.ts'

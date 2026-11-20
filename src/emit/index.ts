// emit(ast) -> JavaScript source. One canonical style, no options:
//   2-space indent, no semicolons (ASI-safe), no line wrapping,
//   literals from `raw` when present, parentheses from precedence,
//   comments as nodes: own line in statement lists, inline in expression lists,
//   and a node's leading comments (`comments`) right before it: `f(/* c */ a)`.
// Printers are plain functions `node -> Doc` (doc.ts), one per node type
// (PRINTERS); the renderer turns the Doc into text and, if asked, a source map.
import { toNode, type Node } from '../ast/node.ts'
import { aside, hardline, head, indent, join, mark, render, text, type Doc } from './doc.ts'
import { MapBuilder, type SourceMap } from './sourcemap.ts'

export type { Doc } from './doc.ts'
export type { SourceMap } from './sourcemap.ts'

// The AST is open-ended data; printers read slots and attrs by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

interface Ctx {
  /** Inside a `for (init;;)`: a bare `in` would be read as for-in. */
  noIn?: boolean
}

const PLAIN: Ctx = {}

function doc(input: Node | object): Doc {
  const ast = toNode(input)
  if (ast.type === 'Program') {
    const body = stmts((ast as N).body, PLAIN)
    return mark(ast, head(body, 1) ? [body, '\n'] : '')
  }
  return print(ast, PLAIN)
}

/** Prints a node: a Node, a plain `{ type, ...attrs, children }` or an ESTree object. */
export function emit(input: Node | object): string {
  return render(doc(input))
}

/** Code plus a Source Map v3 pointing at the origins of the nodes (see sourcemap.ts). */
export function emitWithMap(input: Node | object): { code: string; map: SourceMap } {
  const map = new MapBuilder()
  const code = render(doc(input), map.sink)
  return { code, map: map.toJSON() }
}

/** Nodes to wrap in parens once, whatever their position (see `wrapLeftmost`, `startChild`). */
const wrapOnce = new WeakSet<object>()

/** Prints a node with its leading comments; `leading: false` leaves them to the caller. */
function print(node: N, ctx: Ctx, leading = true): Doc {
  const printer = PRINTERS[node.type]
  if (!printer) throw new Error(`emit: unknown node type "${node.type}"`)
  const first = startChild(node)
  if (first && hasLead(first)) wrapOnce.add(first)
  const comments = leading ? lead(node) : ''
  // Comments inside the parens (before them they would lead the parent); the
  // mark starts at the node itself, so a name maps where it is written.
  if (wrapOnce.delete(node)) return ['(', comments, mark(node, printer(node, PLAIN)), ')']
  return [comments, mark(node, printer(node, ctx))]
}

/**
 * The child whose text starts the text of `n`, with no keyword or bracket before
 * it. A leading comment printed there would be read back as the comment of `n`
 * (or of the statement), so such a child is wrapped once: `(/* c *\/ a) + b`.
 * Like `leftmost`, one step at a time; patterns can't be wrapped.
 */
function startChild(n: N): N | undefined {
  switch (n.type) {
    case 'ExpressionStatement':
      return n.directive === undefined ? n.expression : undefined
    case 'CallExpression':
      return n.callee
    case 'MemberExpression':
      return n.object
    case 'TaggedTemplateExpression':
      return n.tag
    case 'BinaryExpression':
    case 'LogicalExpression':
      return n.left
    case 'AssignmentExpression':
      return /Pattern$/.test(n.left.type) ? undefined : n.left
    case 'ConditionalExpression':
      return n.test
    case 'UpdateExpression':
      return n.prefix ? undefined : n.argument
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSInstantiationExpression':
      return n.expression
    case 'TSArrayType':
      return n.elementType
    case 'TSIndexedAccessType':
      return n.objectType
    case 'TSConditionalType':
      return n.checkType
    case 'TSOptionalType':
      return n.typeAnnotation
    default:
      return undefined
  }
}

/** The node whose text starts the text of `n` (ignoring parens). */
function leftmost(n: N): N {
  for (;;) {
    switch (n.type) {
      case 'CallExpression':
        n = n.callee
        break
      case 'MemberExpression':
        n = n.object
        break
      case 'TaggedTemplateExpression':
        n = n.tag
        break
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'AssignmentExpression':
        n = n.left
        break
      case 'ConditionalExpression':
        n = n.test
        break
      case 'SequenceExpression':
        n = n.expressions.find((e: N) => !isComment(e))
        break
      case 'UpdateExpression':
        if (n.prefix) return n
        n = n.argument
        break
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSInstantiationExpression':
        n = n.expression
        break
      default:
        return n
    }
  }
}

/**
 * `(function () {})()` rather than `(function () {}())`: where a statement (or
 * arrow body, default export) must not start with `function`/`class`/`{`, wrap
 * just the expression that starts it. Patterns can't be wrapped (`({ a }) = b`).
 */
function wrapLeftmost(n: N, types: RegExp) {
  const first = leftmost(n)
  if (first !== n && types.test(first.type)) wrapOnce.add(first)
}

// ---------------------------------------------------------------------------
// Precedence

const P = { SEQ: 1, ASSIGN: 2, COND: 3, NULLISH: 4, AS: 10, UNARY: 15, POSTFIX: 16, CALL: 17, PRIMARY: 20 }

const BINARY: Record<string, number> = {
  '||': 4, '??': 4, '&&': 5, '|': 6, '^': 7, '&': 8,
  '==': 9, '!=': 9, '===': 9, '!==': 9,
  '<': 10, '>': 10, '<=': 10, '>=': 10, instanceof: 10, in: 10,
  '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, '**': 14,
}

function prec(n: N): number {
  switch (n.type) {
    case 'SequenceExpression':
      return P.SEQ
    case 'AssignmentExpression':
    case 'ArrowFunctionExpression':
    case 'YieldExpression':
      return P.ASSIGN
    case 'ConditionalExpression':
      return P.COND
    case 'BinaryExpression':
    case 'LogicalExpression':
      return BINARY[n.operator]
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return P.AS
    case 'UnaryExpression':
    case 'AwaitExpression':
    case 'TSTypeAssertion':
      return P.UNARY
    case 'UpdateExpression':
      return n.prefix ? P.UNARY : P.POSTFIX
    case 'CallExpression':
    case 'MemberExpression':
    case 'NewExpression':
    case 'TaggedTemplateExpression':
    case 'ChainExpression':
    case 'ImportExpression':
    case 'TSNonNullExpression':
    case 'TSInstantiationExpression':
      return P.CALL
    case 'Literal':
      // A macro may put a negative number into a Literal: print it like `-1`.
      return typeof n.value === 'number' && n.raw === undefined && (n.value < 0 || Object.is(n.value, -0))
        ? P.UNARY
        : P.PRIMARY
    default:
      return P.PRIMARY
  }
}

/** `(node)`; these parens also serve a pending wrap (`wrapOnce`). */
function parens(node: N): Doc {
  wrapOnce.delete(node)
  return ['(', print(node, PLAIN), ')']
}

/** `node` as an operand that must bind at least as tight as `min`. */
function expr(node: N, ctx: Ctx, min = P.SEQ): Doc {
  const wrap = prec(node) < min || (ctx.noIn && node.type === 'BinaryExpression' && node.operator === 'in')
  return wrap ? parens(node) : print(node, ctx)
}

/** Object of a member access, callee, tag: a left-hand-side expression. */
function lhs(node: N, ctx: Ctx): Doc {
  // `(a?.b).c` ends the chain; without parens it would continue it.
  if (node.type === 'ChainExpression') return parens(node)
  return expr(node, ctx, P.CALL)
}

/** `new (f())()`, `new (a.b())`: a call inside the callee would take the arguments. */
function hasCall(n: N): boolean {
  for (;;) {
    if (n.type === 'CallExpression' || n.type === 'ChainExpression') return true
    if (n.type === 'MemberExpression') n = n.object
    else if (n.type === 'TaggedTemplateExpression') n = n.tag
    else if (n.type === 'TSNonNullExpression') n = n.expression
    else return false
  }
}

// ---------------------------------------------------------------------------
// Comments and lists

const commentText = (c: N) => (c.kind === 'Line' ? `//${c.value}` : `/*${c.value}*/`)
const comment = (c: N): Doc => mark(c, commentText(c))
const isComment = (n: N) => n !== null && n.type === 'Comment'

const hasLead = (n: N): boolean => !!n?.comments?.length

/**
 * `/* c *\/ ` before a node: its leading comments, inline. Not code to `head`, so
 * checks like "starts with `{`" see through them. Only block comments: a line
 * comment would swallow the rest of the line.
 */
function lead(n: N): Doc {
  if (!hasLead(n)) return ''
  return aside(
    (n.comments as N[]).map((c) => {
      if (c.kind !== 'Block') throw new Error(`emit: a ${c.kind} comment can't lead ${n.type} (it would end the line), only a Block comment`)
      return [comment(c), ' ']
    }),
  )
}

/** ` /* c *\/ ` where the node follows text with no space (`f /* c *\/ <T>()`, `x /* c *\/ : T`). */
const leadAfter = (n: N): Doc => (hasLead(n) ? [' ', lead(n)] : '')
/** A space before a child that `print` gives leading comments: `< /* c *\/ a>`, not `</* c *\/ a>`. */
const spaceBefore = (n: N): Doc => (hasLead(n) ? ' ' : '')

/** After `return`/`throw`/`yield` a line break ends the statement: a multi-line comment goes in parens. */
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`)
const breaksLine = (n: N): boolean => !!n?.comments?.some((c: N) => LINE_BREAK.test(c.value))
const restricted = (n: N, ctx: Ctx, min = P.SEQ): Doc => (breaksLine(n) ? parens(n) : expr(n, ctx, min))

interface ListOptions {
  open: string
  close: string
  /** Between items; inline it is followed by a space. */
  sep?: string
  /** `{ a }` instead of `{a}`. */
  pad?: boolean
  /** Separator after the last item when one per line. */
  trailing?: boolean
  /** No brackets of its own (`let a, b`, `a, b`): keep the context (`noIn`). */
  bare?: boolean
}

/**
 * Items inline: `(a, /* c *\/ b)`. One per line when a line comment needs a line
 * break or comments end the list (inline they would read as the last item's).
 */
function list(items: N[], ctx: Ctx, item: (n: N, ctx: Ctx) => Doc, o: ListOptions): Doc {
  const { open, close, sep = ',', pad = false, trailing = true, bare = false } = o
  const groups: { comments: N[]; node: N }[] = []
  let pending: N[] = []
  for (const n of items) {
    if (isComment(n)) pending.push(n)
    else {
      groups.push({ comments: pending, node: n })
      pending = []
    }
  }
  if (!groups.length && !pending.length) return open + close

  const multiline = pending.length > 0 || groups.some((g) => g.comments.some((c) => c.kind === 'Line'))
  if (!multiline) {
    const inline = bare ? ctx : PLAIN
    const s: Doc[] = join(`${sep} `, groups.map((g) => join(' ', [...g.comments.map(comment), item(g.node, inline)])))
    if (groups.at(-1)!.node === null) s.push(sep) // `[a, ,]`: a trailing hole needs its comma
    return pad ? [open, ' ', s, ' ', close] : [open, s, close]
  }

  const lines: Doc[] = []
  groups.forEach((g, i) => {
    for (const c of g.comments) lines.push(comment(c))
    const last = i === groups.length - 1
    const end = last && (!trailing || g.node?.type === 'RestElement') ? '' : sep.trim()
    lines.push([g.node === null ? '' : item(g.node, PLAIN), end])
  })
  for (const c of pending) lines.push(comment(c))
  return [open, indent([hardline, join(hardline, lines)]), hardline, close]
}

const exprItem = (n: N, ctx: Ctx): Doc => (n === null ? '' : expr(n, ctx, P.ASSIGN))
const nodeItem = (n: N, ctx: Ctx): Doc => (n === null ? '' : print(n, ctx))

const args = (items: N[], ctx: Ctx) => list(items, ctx, exprItem, { open: '(', close: ')' })
const params = (items: N[], ctx: Ctx) => list(items, ctx, nodeItem, { open: '(', close: ')' })

// ---------------------------------------------------------------------------
// Statement lists

/** A line starting with one of these would continue the previous statement. */
const ASI_HAZARD = /^[([`+\-/<*]/

/** Can the next line continue this statement? (It doesn't end with `}`.) */
function openEnd(n: N): boolean {
  switch (n.type) {
    case 'BlockStatement':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TryStatement':
    case 'SwitchStatement':
    case 'EmptyStatement':
    case 'DoWhileStatement':
    case 'TSInterfaceDeclaration':
    case 'TSEnumDeclaration':
    case 'StaticBlock':
      return false
    case 'MethodDefinition':
      return !n.value.body
    case 'TSModuleDeclaration':
      return !n.body
    case 'IfStatement':
      return openEnd(n.alternate ?? n.consequent)
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'WithStatement':
    case 'LabeledStatement':
      return openEnd(n.body)
    case 'ExportNamedDeclaration':
      return n.declaration ? openEnd(n.declaration) : true
    case 'ExportDefaultDeclaration':
      return !/^(FunctionDeclaration|ClassDeclaration|TSInterfaceDeclaration)$/.test(n.declaration.type)
    default:
      return true
  }
}

/** Declarations that get a blank line around them. */
function spaced(n: N): boolean {
  if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') {
    return !!n.declaration && spaced(n.declaration)
  }
  if (n.type === 'MethodDefinition' || n.type === 'TSAbstractMethodDefinition') return !!n.value.body
  return /^(FunctionDeclaration|ClassDeclaration|TSInterfaceDeclaration|TSModuleDeclaration|TSEnumDeclaration|StaticBlock)$/.test(n.type)
}

/** One per line at the current indentation; comments on their own lines. */
function stmts(items: N[], ctx: Ctx, { asi = true } = {}): Doc {
  const lines: Doc[] = []
  let pending: Doc[] = []
  let prev: N | undefined
  for (const n of items) {
    if (isComment(n)) {
      pending.push(comment(n))
      continue
    }
    let s = print(n, ctx)
    if (asi && prev && openEnd(prev) && ASI_HAZARD.test(head(s, 1))) s = [';', s]
    if (prev && (spaced(prev) || spaced(n))) lines.push('')
    lines.push(...pending, s)
    pending = []
    prev = n
  }
  lines.push(...pending)
  return join(hardline, lines)
}

/** `{ ... }` with the items one level deeper. */
const braces = (inner: Doc): Doc => ['{', indent([hardline, inner]), hardline, '}']

const block = (items: N[], options?: { asi?: boolean }): Doc =>
  items.length ? braces(stmts(items, PLAIN, options)) : '{}'

/** Body of if/for/while: a block, or a statement on the same line. */
const body = (n: N): Doc => [' ', print(n, PLAIN)]

// ---------------------------------------------------------------------------
// Literals

/** Backslash, quote, control characters, and the two line separators (U+2028, U+2029). */
const NEEDS_ESCAPE = new RegExp(`[\\\\'\\x00-\\x1f${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

function quote(s: string) {
  return `'${s.replace(NEEDS_ESCAPE, (ch) => {
    switch (ch) {
      case '\\': return '\\\\'
      case "'": return "\\'"
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      default: return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    }
  })}'`
}

function literal(n: N): string {
  if (typeof n.raw === 'string') return n.raw
  if (n.regex) return `/${n.regex.pattern}/${n.regex.flags}`
  if (n.bigint !== undefined) return `${n.bigint}n`
  if (typeof n.value === 'string') return quote(n.value)
  if (typeof n.value === 'bigint') return `${n.value}n`
  return String(n.value)
}

// ---------------------------------------------------------------------------
// Pieces shared by several node types

// The helpers below print a child's parts in place of `print(child)`, so they
// print its leading comments themselves.

/** `: T` */
const ann = (n: N): Doc => (n ? [leadAfter(n), ': ', type(n.typeAnnotation)] : '')

const typeParams = (n: N, ctx: Ctx): Doc => (n ? [leadAfter(n), list(n.params, ctx, nodeItem, { open: '<', close: '>' })] : '')
const typeArgs = (n: N, ctx: Ctx): Doc => (n ? [leadAfter(n), list(n.params, ctx, typeItem, { open: '<', close: '>' })] : '')

/** A function's block body, `{ ... }`. */
const fnBody = (n: N): Doc => [lead(n), block(n.body)]

function decorators(items: N[] | undefined, ctx: Ctx): Doc {
  if (!items?.length) return ''
  return [list(items, ctx, nodeItem, { open: '', close: '', sep: '', trailing: false }), ' ']
}

const key = (n: N, ctx: Ctx): Doc => (n.computed ? ['[', expr(n.key, PLAIN, P.ASSIGN), ']'] : print(n.key, ctx))

/** Modifiers in the order TypeScript accepts them. */
function modifiers(n: N) {
  let s = ''
  if (n.declare) s += 'declare '
  if (n.accessibility) s += n.accessibility + ' '
  if (n.static) s += 'static '
  if (n.type?.startsWith('TSAbstract')) s += 'abstract '
  if (n.override) s += 'override '
  if (n.readonly) s += 'readonly '
  return s
}

/** `async get *name?<T>(a): R { ... }` for methods and object methods. */
function method(n: N, ctx: Ctx, prefix: string): Doc {
  const f = n.value
  let words = prefix
  if (f.async) words += 'async '
  if (n.kind === 'get' || n.kind === 'set') words += n.kind + ' '
  if (f.generator) words += '*'
  return [
    decorators(n.decorators, ctx),
    words,
    f.generator ? spaceBefore(n.key) : '',
    key(n, ctx),
    n.optional ? '?' : '',
    leadAfter(f),
    signature(f, ctx),
    f.body ? [' ', fnBody(f.body)] : '',
  ]
}

/** `<T>(a: A): R` */
const signature = (f: N, ctx: Ctx): Doc => [typeParams(f.typeParameters, ctx), params(f.params, ctx), ann(f.returnType)]

function fn(n: N, ctx: Ctx): Doc {
  let s = n.declare ? 'declare ' : ''
  if (n.async) s += 'async '
  s += 'function' + (n.generator ? '*' : '')
  // `function /* c */ <T>()`: the comment of the type parameters brings its own space.
  if (n.id || !hasLead(n.typeParameters)) s += ' '
  return [s, n.id ? print(n.id, ctx) : '', signature(n, ctx), n.body ? [' ', fnBody(n.body)] : '']
}

function cls(n: N, ctx: Ctx): Doc {
  const out: Doc[] = [decorators(n.decorators, ctx)]
  if (n.declare) out.push('declare ')
  if (n.abstract) out.push('abstract ')
  out.push('class', n.id ? [' ', print(n.id, ctx)] : '', typeParams(n.typeParameters, ctx))
  if (n.superClass) out.push(' extends ', lhs(n.superClass, ctx), typeArgs(n.superTypeArguments, ctx))
  if (n.implements?.length) {
    out.push(' implements ', list(n.implements, ctx, nodeItem, { open: '', close: '', trailing: false }))
  }
  out.push(' ', print(n.body, ctx))
  return out
}

/** Identifier and patterns in a binding position: `a?: T`. */
const binding = (n: N, ctx: Ctx, s: Doc): Doc => [decorators(n.decorators, ctx), s, n.optional ? '?' : '', ann(n.typeAnnotation)]

/** Statement-start forms that would be read as something else. */
const STATEMENT_START = /^(\{|function\b|class\b|let\s*\[|async\s+function\b)/
const DEFAULT_EXPORT_START = /^(function\b|class\b|async\s+function\b)/
/** Long enough for every pattern above. */
const START = 16

const importSource = (n: N, ctx: Ctx): Doc => [' from ', print(n.source, ctx), attributes(n, ctx)]

/** ` with { type: 'json' }` */
const attributes = (n: N, ctx: Ctx): Doc =>
  n.attributes?.length ? [' with ', list(n.attributes, ctx, nodeItem, { open: '{', close: '}', pad: true })] : ''

// ---------------------------------------------------------------------------
// Types

const T = { FUNCTION: 1, UNION: 2, INTERSECTION: 3, OPERATOR: 4, POSTFIX: 5, PRIMARY: 6 }

function typePrec(n: N): number {
  switch (n.type) {
    case 'TSFunctionType':
    case 'TSConstructorType':
    case 'TSConditionalType':
      return T.FUNCTION
    case 'TSUnionType':
      return T.UNION
    case 'TSIntersectionType':
      return T.INTERSECTION
    case 'TSTypeOperator':
    case 'TSInferType':
      return T.OPERATOR
    case 'TSArrayType':
    case 'TSIndexedAccessType':
      return T.POSTFIX
    default:
      return T.PRIMARY
  }
}

function type(n: N, min = T.FUNCTION): Doc {
  return typePrec(n) < min ? parens(n) : print(n, PLAIN)
}

const typeItem = (n: N): Doc => type(n)

const KEYWORDS: Record<string, string> = {
  TSAnyKeyword: 'any', TSUnknownKeyword: 'unknown', TSNumberKeyword: 'number', TSStringKeyword: 'string',
  TSBooleanKeyword: 'boolean', TSBigIntKeyword: 'bigint', TSSymbolKeyword: 'symbol', TSObjectKeyword: 'object',
  TSNeverKeyword: 'never', TSVoidKeyword: 'void', TSUndefinedKeyword: 'undefined', TSNullKeyword: 'null',
  TSIntrinsicKeyword: 'intrinsic', TSThisType: 'this',
}

const optionalMark = (v: unknown) => (v === '+' ? '+?' : v === '-' ? '-?' : v ? '?' : '')
const readonlyMark = (v: unknown) => (v === '+' ? '+readonly ' : v === '-' ? '-readonly ' : v ? 'readonly ' : '')

/** Members of a type literal: inline `{ a: A; b: B }`. */
const typeMembers = (items: N[], ctx: Ctx) => list(items, ctx, nodeItem, { open: '{', close: '}', sep: ';', pad: true })

/** `a${x}b` from quasis and the parts between them. */
function template(quasis: N[], parts: N[], part: (n: N) => Doc): Doc {
  const out: Doc[] = ['`']
  quasis.forEach((q, i) => {
    out.push(mark(q, q.value.raw))
    if (i < parts.length) out.push('${', part(parts[i]), '}')
  })
  out.push('`')
  return out
}

// ---------------------------------------------------------------------------
// Printers

type Printer = (n: N, ctx: Ctx) => Doc

const PRINTERS: Record<string, Printer> = {
  Comment: (n) => commentText(n),

  // --- statements ---
  Program: (n, ctx) => stmts(n.body, ctx),
  ExpressionStatement(n, ctx) {
    if (n.directive !== undefined) return print(n.expression, ctx)
    wrapLeftmost(n.expression, /^(FunctionExpression|ClassExpression|ObjectExpression)$/)
    const s = expr(n.expression, ctx)
    return STATEMENT_START.test(head(s, START)) ? ['(', s, ')'] : s
  },
  BlockStatement: (n) => block(n.body),
  StaticBlock: (n) => ['static ', block(n.body)],
  EmptyStatement: () => ';',
  DebuggerStatement: () => 'debugger',
  ReturnStatement: (n, ctx) => ['return', n.argument ? [' ', restricted(n.argument, ctx)] : ''],
  ThrowStatement: (n, ctx) => ['throw ', restricted(n.argument, ctx)],
  BreakStatement: (n, ctx) => ['break', n.label ? [' ', print(n.label, ctx)] : ''],
  ContinueStatement: (n, ctx) => ['continue', n.label ? [' ', print(n.label, ctx)] : ''],
  LabeledStatement: (n, ctx) => [print(n.label, ctx), ':', body(n.body)],
  WithStatement: (n) => ['with (', expr(n.object, PLAIN), ')', body(n.body)],
  WhileStatement: (n) => ['while (', expr(n.test, PLAIN), ')', body(n.body)],
  DoWhileStatement(n) {
    // `do x() while (y)` is a syntax error without `;`, so a new line instead.
    const sep = n.body.type === 'BlockStatement' ? ' ' : hardline
    return ['do ', print(n.body, PLAIN), sep, 'while (', expr(n.test, PLAIN), ')']
  },
  IfStatement(n) {
    let cons = n.consequent
    // `if (a) if (b) x; else y` would give the else to the inner if.
    if (n.alternate && danglingIf(cons)) cons = { type: 'BlockStatement', body: [cons] }
    const out: Doc[] = ['if (', expr(n.test, PLAIN), ')', body(cons)]
    if (n.alternate) out.push(cons.type === 'BlockStatement' ? ' ' : hardline, 'else', body(n.alternate))
    return out
  },
  ForStatement(n) {
    const head = { noIn: true }
    const init = n.init ? (n.init.type === 'VariableDeclaration' ? print(n.init, head) : expr(n.init, head)) : ''
    const test = n.test ? [' ', expr(n.test, PLAIN)] : ''
    const update = n.update ? [' ', expr(n.update, PLAIN)] : ''
    return ['for (', init, ';', test, ';', update, ')', body(n.body)]
  },
  ForInStatement: (n) => ['for (', forLeft(n.left), ' in ', expr(n.right, PLAIN), ')', body(n.body)],
  ForOfStatement: (n) =>
    [`for${n.await ? ' await' : ''} (`, forLeft(n.left), ' of ', expr(n.right, PLAIN, P.ASSIGN), ')', body(n.body)],
  TryStatement: (n, ctx) => [
    'try ',
    print(n.block, ctx),
    n.handler ? [' ', print(n.handler, ctx)] : '',
    n.finalizer ? [' finally ', print(n.finalizer, ctx)] : '',
  ],
  CatchClause: (n, ctx) => ['catch ', n.param ? ['(', print(n.param, ctx), ') '] : '', print(n.body, ctx)],
  SwitchStatement: (n) => [
    'switch (',
    expr(n.discriminant, PLAIN),
    ') ',
    n.cases.length ? braces(stmts(n.cases, PLAIN, { asi: false })) : '{}',
  ],
  SwitchCase(n, ctx) {
    const head: Doc = n.test ? ['case ', expr(n.test, ctx), ':'] : 'default:'
    const c = n.consequent
    if (c.length === 1 && c[0].type === 'BlockStatement') return [head, ' ', print(c[0], ctx)]
    return c.length ? [head, indent([hardline, stmts(c, PLAIN)])] : head
  },
  VariableDeclaration: (n, ctx) => [
    n.declare ? 'declare ' : '',
    n.kind,
    ' ',
    list(n.declarations, ctx, nodeItem, { open: '', close: '', trailing: false, bare: true }),
  ],
  VariableDeclarator(n, ctx) {
    const id = [print(n.id, ctx), n.definite ? '!' : '']
    return n.init ? [id, ' = ', expr(n.init, ctx, P.ASSIGN)] : id
  },
  FunctionDeclaration: fn,
  FunctionExpression: fn,
  TSDeclareFunction: fn,
  TSEmptyBodyFunctionExpression: fn,
  ClassDeclaration: cls,
  ClassExpression: cls,
  ClassBody: (n) => block(n.body),
  MethodDefinition: (n, ctx) => method(n, ctx, modifiers(n)),
  TSAbstractMethodDefinition: (n, ctx) => method(n, ctx, modifiers(n)),
  PropertyDefinition: property,
  AccessorProperty: property,
  TSAbstractPropertyDefinition: property,
  TSAbstractAccessorProperty: property,
  Decorator(n, ctx) {
    const e = n.expression
    const simple = /^(Identifier|MemberExpression|CallExpression)$/.test(e.type) && !hasComputed(e)
    return ['@', simple ? print(e, ctx) : parens(e)]
  },

  // --- modules ---
  ImportDeclaration(n, ctx) {
    const s = 'import ' + (n.importKind === 'type' ? 'type ' : '') + (n.phase ? n.phase + ' ' : '')
    const specs: N[] = n.specifiers
    // `import {} from 'x'` and `import 'x'` are one AST; the short form wins.
    if (!specs.some((x) => !isComment(x))) return [s, print(n.source, ctx), attributes(n, ctx)]
    const named = specs.filter((x) => x.type === 'ImportSpecifier' || isComment(x))
    const front = specs.filter((x) => x.type === 'ImportDefaultSpecifier' || x.type === 'ImportNamespaceSpecifier')
    const parts: Doc[] = front.map((x) => print(x, ctx))
    if (named.some((x) => !isComment(x))) parts.push(list(named, ctx, nodeItem, { open: '{', close: '}', pad: true }))
    return [s, join(', ', parts), importSource(n, ctx)]
  },
  ImportDefaultSpecifier: (n, ctx) => print(n.local, ctx),
  ImportNamespaceSpecifier: (n, ctx) => ['* as ', print(n.local, ctx)],
  ImportSpecifier(n, ctx) {
    const kind = n.importKind === 'type' ? 'type ' : ''
    const imported = print(n.imported, ctx)
    const local = print(n.local, ctx)
    return [kind, sameName(n.imported, imported, n.local, local) ? local : [imported, ' as ', local]]
  },
  ImportAttribute: (n, ctx) => [print(n.key, ctx), ': ', print(n.value, ctx)],
  ExportNamedDeclaration(n, ctx) {
    if (n.declaration) return ['export ', print(n.declaration, ctx)]
    const kind = n.exportKind === 'type' ? 'type ' : ''
    const specs = list(n.specifiers, ctx, nodeItem, { open: '{', close: '}', pad: true })
    return ['export ', kind, specs, n.source ? importSource(n, ctx) : '']
  },
  ExportSpecifier(n, ctx) {
    const kind = n.exportKind === 'type' ? 'type ' : ''
    const local = print(n.local, ctx)
    const exported = print(n.exported, ctx)
    return [kind, sameName(n.local, local, n.exported, exported) ? local : [local, ' as ', exported]]
  },
  ExportDefaultDeclaration(n, ctx) {
    const d = n.declaration
    if (/^(FunctionDeclaration|ClassDeclaration|TSDeclareFunction|TSInterfaceDeclaration)$/.test(d.type)) {
      return ['export default ', print(d, ctx)]
    }
    wrapLeftmost(d, /^(FunctionExpression|ClassExpression)$/)
    const s = expr(d, ctx, P.ASSIGN)
    return ['export default ', DEFAULT_EXPORT_START.test(head(s, START)) ? ['(', s, ')'] : s]
  },
  ExportAllDeclaration(n, ctx) {
    const kind = n.exportKind === 'type' ? 'type ' : ''
    return ['export ', kind, '*', n.exported ? [' as ', print(n.exported, ctx)] : '', importSource(n, ctx)]
  },

  // --- expressions ---
  Identifier: (n, ctx) => binding(n, ctx, n.name),
  PrivateIdentifier: (n) => '#' + n.name,
  Literal: literal,
  ThisExpression: () => 'this',
  Super: () => 'super',
  MetaProperty: (n, ctx) => [print(n.meta, ctx), '.', print(n.property, ctx)],
  TemplateLiteral: (n) => template(n.quasis, n.expressions, (e) => expr(e, PLAIN)),
  TemplateElement: (n) => n.value.raw,
  TaggedTemplateExpression: (n, ctx) =>
    [lhs(n.tag, ctx), typeArgs(n.typeArguments, ctx), spaceBefore(n.quasi), print(n.quasi, ctx)],
  ArrayExpression: (n, ctx) => list(n.elements, ctx, exprItem, { open: '[', close: ']' }),
  ArrayPattern: (n, ctx) => binding(n, ctx, list(n.elements, ctx, nodeItem, { open: '[', close: ']' })),
  ObjectExpression: (n, ctx) => list(n.properties, ctx, nodeItem, { open: '{', close: '}', pad: true }),
  ObjectPattern: (n, ctx) => binding(n, ctx, list(n.properties, ctx, nodeItem, { open: '{', close: '}', pad: true })),
  Property(n, ctx) {
    if (n.method || n.kind === 'get' || n.kind === 'set') return method(n, ctx, '')
    if (n.shorthand) return print(n.value, ctx)
    return [key(n, ctx), ': ', expr(n.value, ctx, P.ASSIGN)]
  },
  SpreadElement: (n, ctx) => ['...', expr(n.argument, ctx, P.ASSIGN)],
  RestElement: (n, ctx) => binding(n, ctx, ['...', print(n.argument, ctx)]),
  AssignmentPattern: (n, ctx) => [print(n.left, ctx), ' = ', expr(n.right, ctx, P.ASSIGN)],
  ArrowFunctionExpression(n, ctx) {
    const out: Doc[] = [n.async ? 'async ' : '']
    // `<T,>`: a bare `<T>` would start JSX in .tsx files.
    const tp = n.typeParameters
    if (tp?.params.length === 1 && !tp.params[0].constraint && !isComment(tp.params[0])) {
      out.push(lead(tp), mark(tp, ['<', print(tp.params[0], ctx), ',>']))
    } else if (tp) out.push(lead(tp), list(tp.params, ctx, nodeItem, { open: '<', close: '>' }))
    out.push(params(n.params, ctx), ann(n.returnType), ' => ')
    if (n.body.type === 'BlockStatement') return [out, lead(n.body), mark(n.body, block(n.body.body))]
    wrapLeftmost(n.body, /^ObjectExpression$/)
    const b = expr(n.body, ctx, P.ASSIGN)
    return [out, head(b, 1) === '{' ? ['(', b, ')'] : b]
  },
  SequenceExpression: (n, ctx) =>
    list(n.expressions, ctx, exprItem, { open: '', close: '', trailing: false, bare: true }),
  AssignmentExpression: (n, ctx) => [expr(n.left, ctx, P.CALL), ` ${n.operator} `, expr(n.right, ctx, P.ASSIGN)],
  ConditionalExpression: (n, ctx) => [
    expr(n.test, ctx, P.NULLISH),
    ' ? ',
    expr(n.consequent, ctx, P.ASSIGN),
    ' : ',
    expr(n.alternate, ctx, P.ASSIGN),
  ],
  LogicalExpression: binary,
  BinaryExpression: binary,
  UnaryExpression(n, ctx) {
    const arg = expr(n.argument, ctx, P.UNARY)
    if (/^[a-z]/.test(n.operator)) return [n.operator, ' ', arg]
    // `- -x`, `+ +x`, `- --x`: no space would make `--`/`++`.
    const space = (n.operator === '-' || n.operator === '+') && head(arg, 1) === n.operator
    return [n.operator, space ? ' ' : '', arg]
  },
  UpdateExpression(n, ctx) {
    const arg = expr(n.argument, ctx, P.CALL)
    return n.prefix ? [n.operator, arg] : [arg, n.operator]
  },
  AwaitExpression: (n, ctx) => ['await ', expr(n.argument, ctx, P.UNARY)],
  YieldExpression: (n, ctx) =>
    ['yield', n.delegate ? '*' : '', n.argument ? [' ', restricted(n.argument, ctx, P.ASSIGN)] : ''],
  CallExpression: (n, ctx) =>
    [lhs(n.callee, ctx), n.optional ? '?.' : '', typeArgs(n.typeArguments, ctx), args(n.arguments, ctx)],
  NewExpression(n, ctx) {
    const callee = hasCall(n.callee) ? parens(n.callee) : lhs(n.callee, ctx)
    return ['new ', callee, typeArgs(n.typeArguments, ctx), args(n.arguments, ctx)]
  },
  MemberExpression(n, ctx) {
    let obj = lhs(n.object, ctx)
    // `1.toString()` would read `1.` as the number.
    if (n.object.type === 'Literal' && /^\d+$/.test(text(obj))) obj = ['(', obj, ')']
    if (n.computed) return [obj, n.optional ? '?.' : '', '[', expr(n.property, PLAIN), ']']
    return [obj, n.optional ? '?.' : '.', print(n.property, ctx)]
  },
  ChainExpression: (n, ctx) => print(n.expression, ctx),
  ImportExpression: (n, ctx) => ['import', args(n.options ? [n.source, n.options] : [n.source], ctx)],

  // --- JSX ---
  JSXElement: (n, ctx) =>
    [print(n.openingElement, ctx), jsxChildren(n.content, ctx), n.closingElement ? print(n.closingElement, ctx) : ''],
  JSXFragment: (n, ctx) => ['<>', jsxChildren(n.content, ctx), '</>'],
  JSXOpeningElement(n, ctx) {
    const attrs = list(n.attributes, ctx, nodeItem, { open: '', close: '', sep: '', trailing: false })
    const first = head(attrs, 1)
    const multiline = first === '\n'
    const sp = multiline || !first ? attrs : [' ', attrs]
    const end = n.selfClosing ? (multiline ? '/>' : ' />') : '>'
    return ['<', spaceBefore(n.name), print(n.name, ctx), typeArgs(n.typeArguments, ctx), sp, end]
  },
  JSXClosingElement: (n, ctx) => ['</', spaceBefore(n.name), print(n.name, ctx), '>'],
  JSXAttribute: (n, ctx) => [print(n.name, ctx), n.value ? ['=', print(n.value, ctx)] : ''],
  JSXSpreadAttribute: (n) => ['{...', expr(n.argument, PLAIN, P.ASSIGN), '}'],
  JSXSpreadChild: (n) => ['{...', expr(n.expression, PLAIN, P.ASSIGN), '}'],
  JSXExpressionContainer: (n) => ['{', expr(n.expression, PLAIN, P.ASSIGN), '}'],
  JSXEmptyExpression: () => '',
  JSXText: (n) => n.raw,
  JSXIdentifier: (n) => n.name,
  JSXNamespacedName: (n, ctx) => [print(n.namespace, ctx), ':', print(n.name, ctx)],
  JSXMemberExpression: (n, ctx) => [print(n.object, ctx), '.', print(n.property, ctx)],

  // --- TypeScript: expressions and declarations ---
  TSAsExpression: (n, ctx) => [expr(n.expression, ctx, P.AS), ' as ', type(n.typeAnnotation)],
  TSSatisfiesExpression: (n, ctx) => [expr(n.expression, ctx, P.AS), ' satisfies ', type(n.typeAnnotation)],
  TSNonNullExpression: (n, ctx) => [lhs(n.expression, ctx), '!'],
  TSTypeAssertion: (n, ctx) => ['<', type(n.typeAnnotation), '>', expr(n.expression, ctx, P.UNARY)],
  TSInstantiationExpression: (n, ctx) => [lhs(n.expression, ctx), typeArgs(n.typeArguments, ctx)],
  TSParameterProperty: (n, ctx) => [decorators(n.decorators, ctx), modifiers(n), print(n.parameter, ctx)],
  TSTypeAliasDeclaration: (n, ctx) => [
    n.declare ? 'declare ' : '',
    'type ',
    print(n.id, ctx),
    typeParams(n.typeParameters, ctx),
    ' = ',
    type(n.typeAnnotation),
  ],
  TSInterfaceDeclaration(n, ctx) {
    const out: Doc[] = [n.declare ? 'declare ' : '', 'interface ', print(n.id, ctx), typeParams(n.typeParameters, ctx)]
    if (n.extends?.length) out.push(' extends ', list(n.extends, ctx, nodeItem, { open: '', close: '', trailing: false }))
    out.push(' ', print(n.body, ctx))
    return out
  },
  TSInterfaceBody: (n) => block(n.body, { asi: false }),
  TSInterfaceHeritage: (n, ctx) => [lhs(n.expression, ctx), typeArgs(n.typeArguments, ctx)],
  TSClassImplements: (n, ctx) => [lhs(n.expression, ctx), typeArgs(n.typeArguments, ctx)],
  TSEnumDeclaration: (n, ctx) =>
    [n.declare ? 'declare ' : '', n.const ? 'const ' : '', 'enum ', print(n.id, ctx), ' ', print(n.body, ctx)],
  TSEnumBody: (n, ctx) => list(n.members, ctx, nodeItem, { open: '{', close: '}', pad: true }),
  TSEnumMember: (n, ctx) => [
    n.computed ? ['[', print(n.id, ctx), ']'] : print(n.id, ctx),
    n.initializer ? [' = ', expr(n.initializer, ctx, P.ASSIGN)] : '',
  ],
  TSModuleDeclaration(n, ctx) {
    const head: Doc = [n.declare ? 'declare ' : '', n.kind === 'global' ? 'global' : [n.kind, ' ', print(n.id, ctx)]]
    return n.body ? [head, ' ', print(n.body, ctx)] : head
  },
  TSModuleBlock: (n) => block(n.body),
  TSImportEqualsDeclaration: (n, ctx) =>
    ['import ', n.importKind === 'type' ? 'type ' : '', print(n.id, ctx), ' = ', print(n.moduleReference, ctx)],
  TSExternalModuleReference: (n, ctx) => ['require(', print(n.expression, ctx), ')'],
  TSExportAssignment: (n, ctx) => ['export = ', expr(n.expression, ctx, P.ASSIGN)],
  TSNamespaceExportDeclaration: (n, ctx) => ['export as namespace ', print(n.id, ctx)],
  TSIndexSignature: (n, ctx) =>
    [modifiers(n), list(n.parameters, ctx, nodeItem, { open: '[', close: ']' }), ann(n.typeAnnotation)],
  TSTypeParameterDeclaration: (n, ctx) => list(n.params, ctx, nodeItem, { open: '<', close: '>' }),
  TSTypeParameterInstantiation: (n, ctx) => list(n.params, ctx, typeItem, { open: '<', close: '>' }),
  TSTypeParameter(n, ctx) {
    const mods = (n.const ? 'const ' : '') + (n.in ? 'in ' : '') + (n.out ? 'out ' : '')
    return [
      mods,
      print(n.name, ctx),
      n.constraint ? [' extends ', type(n.constraint)] : '',
      n.default ? [' = ', type(n.default)] : '',
    ]
  },
  TSTypeAnnotation: (n) => type(n.typeAnnotation),

  // --- TypeScript: types ---
  TSTypeReference: (n, ctx) => [print(n.typeName, ctx), typeArgs(n.typeArguments, ctx)],
  TSQualifiedName: (n, ctx) => [print(n.left, ctx), '.', print(n.right, ctx)],
  TSUnionType: (n, ctx) =>
    list(n.types, ctx, (t) => type(t, T.INTERSECTION), { open: '', close: '', sep: ' |', trailing: false }),
  TSIntersectionType: (n, ctx) =>
    list(n.types, ctx, (t) => type(t, T.OPERATOR), { open: '', close: '', sep: ' &', trailing: false }),
  TSArrayType: (n) => [type(n.elementType, T.POSTFIX), '[]'],
  TSIndexedAccessType: (n) => [type(n.objectType, T.POSTFIX), '[', type(n.indexType), ']'],
  TSTypeOperator: (n) => [n.operator, ' ', type(n.typeAnnotation, T.OPERATOR)],
  TSInferType: (n, ctx) => ['infer ', print(n.typeParameter, ctx)],
  TSConditionalType: (n) => [
    type(n.checkType, T.UNION),
    ' extends ',
    type(n.extendsType, T.UNION),
    ' ? ',
    type(n.trueType),
    ' : ',
    type(n.falseType),
  ],
  TSFunctionType: (n, ctx) => [signatureNoReturn(n, ctx), arrowReturn(n.returnType)],
  TSConstructorType: (n, ctx) =>
    [n.abstract ? 'abstract ' : '', 'new ', signatureNoReturn(n, ctx), arrowReturn(n.returnType)],
  TSTypeLiteral: (n, ctx) => typeMembers(n.members, ctx),
  TSPropertySignature: (n, ctx) =>
    [n.readonly ? 'readonly ' : '', key(n, ctx), n.optional ? '?' : '', ann(n.typeAnnotation)],
  TSMethodSignature(n, ctx) {
    const kind = n.kind === 'get' || n.kind === 'set' ? n.kind + ' ' : ''
    return [kind, key(n, ctx), n.optional ? '?' : '', signature(n, ctx)]
  },
  TSCallSignatureDeclaration: (n, ctx) => signature(n, ctx),
  TSConstructSignatureDeclaration: (n, ctx) => ['new ', signature(n, ctx)],
  TSMappedType(n, ctx) {
    return [
      '{ ',
      readonlyMark(n.readonly),
      '[',
      print(n.key, ctx),
      ' in ',
      type(n.constraint),
      n.nameType ? [' as ', type(n.nameType)] : '',
      ']',
      optionalMark(n.optional),
      n.typeAnnotation ? [': ', type(n.typeAnnotation)] : '',
      ' }',
    ]
  },
  TSTupleType: (n, ctx) => list(n.elementTypes, ctx, typeItem, { open: '[', close: ']' }),
  TSNamedTupleMember: (n, ctx) => [print(n.label, ctx), n.optional ? '?' : '', ': ', type(n.elementType)],
  TSOptionalType: (n) => [type(n.typeAnnotation, T.POSTFIX), '?'],
  TSRestType: (n) => ['...', type(n.typeAnnotation)],
  TSLiteralType: (n, ctx) => print(n.literal, ctx),
  TSTemplateLiteralType: (n) => template(n.quasis, n.types, (t) => type(t)),
  TSTypeQuery: (n, ctx) => ['typeof ', print(n.exprName, ctx), typeArgs(n.typeArguments, ctx)],
  TSImportType: (n, ctx) => [
    'import',
    list(n.options ? [n.source, n.options] : [n.source], ctx, nodeItem, { open: '(', close: ')' }),
    n.qualifier ? ['.', print(n.qualifier, ctx)] : '',
    typeArgs(n.typeArguments, ctx),
  ],
  TSTypePredicate(n, ctx) {
    const s: Doc = [n.asserts ? 'asserts ' : '', print(n.parameterName, ctx)]
    return n.typeAnnotation ? [s, ' is ', lead(n.typeAnnotation), returnType(n.typeAnnotation)] : s
  },
}

for (const [name, word] of Object.entries(KEYWORDS)) PRINTERS[name] = () => word

/** A TSTypeAnnotation printed without `: ` (after `=>`, `is`); marked as itself. */
const returnType = (n: N): Doc => mark(n, type(n.typeAnnotation))

/** ` => R` of a function type; the annotation starts at `=>`, so its comments go before it. */
const arrowReturn = (n: N): Doc => [hasLead(n) ? [' ', lead(n), '=> '] : ' => ', returnType(n)]

/** `a as a` is just `a`, unless a comment sits on one of them. */
const sameName = (a: N, ad: Doc, b: N, bd: Doc) => !hasLead(a) && !hasLead(b) && text(ad) === text(bd)

function property(n: N, ctx: Ctx): Doc {
  const accessor = n.type === 'AccessorProperty' || n.type === 'TSAbstractAccessorProperty' ? 'accessor ' : ''
  const s: Doc = [
    decorators(n.decorators, ctx),
    modifiers(n),
    accessor,
    key(n, ctx),
    n.optional ? '?' : '',
    n.definite ? '!' : '',
    ann(n.typeAnnotation),
  ]
  return n.value ? [s, ' = ', expr(n.value, ctx, P.ASSIGN)] : s
}

function binary(n: N, ctx: Ctx): Doc {
  const p = BINARY[n.operator]
  const right = n.operator === '**'
  let l = expr(n.left, ctx, right ? P.POSTFIX : p)
  let r = expr(n.right, ctx, right ? p : p + 1)
  // `a ?? b || c` is a syntax error: `??` never mixes with `||`/`&&` without parens.
  if (mixesNullish(n, n.left) && head(l, 1) !== '(') l = ['(', l, ')']
  if (mixesNullish(n, n.right) && head(r, 1) !== '(') r = ['(', r, ')']
  return [l, ` ${n.operator} `, r]
}

function mixesNullish(parent: N, child: N) {
  if (child.type !== 'LogicalExpression' || parent.type !== 'LogicalExpression') return false
  return (parent.operator === '??') !== (child.operator === '??')
}

function signatureNoReturn(n: N, ctx: Ctx): Doc {
  return [typeParams(n.typeParameters, ctx), params(n.params, ctx)]
}

function forLeft(n: N): Doc {
  return n.type === 'VariableDeclaration' ? print(n, PLAIN) : expr(n, PLAIN, P.CALL)
}

/** Ends with an `if` without `else`, which would capture a following `else`. */
function danglingIf(n: N): boolean {
  switch (n.type) {
    case 'IfStatement':
      return !n.alternate || danglingIf(n.alternate)
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'WithStatement':
    case 'LabeledStatement':
      return danglingIf(n.body)
    default:
      return false
  }
}

function hasComputed(n: N): boolean {
  if (n.type === 'MemberExpression') return n.computed || hasComputed(n.object)
  if (n.type === 'CallExpression') return hasComputed(n.callee)
  return false
}

/** JSX children are printed verbatim; a comment child becomes `{/* c *\/}`, so do leading comments. */
function jsxChildren(children: N[], ctx: Ctx): Doc {
  const commentChild = (c: N): Doc => (c.kind === 'Line' ? ['{', comment(c), hardline, '}'] : ['{', comment(c), '}'])
  return children.map((c) => {
    if (isComment(c)) return commentChild(c)
    return [(c.comments ?? []).map(commentChild), print(c, ctx, false)]
  })
}

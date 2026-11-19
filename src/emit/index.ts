// emit(ast) -> JavaScript source. One canonical style, no options:
//   2-space indent, no semicolons (ASI-safe), no line wrapping,
//   literals from `raw` when present, parentheses from precedence,
//   comments as nodes: own line in statement lists, inline in expression lists.
// Printers are plain functions `node -> string`, one per node type (PRINTERS).
import type { Node } from '../read/index.ts'

// The AST is open-ended data; printers read fields by name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

interface Ctx {
  /** Indentation of the current line. */
  ind: string
  /** Inside a `for (init;;)`: a bare `in` would be read as for-in. */
  noIn?: boolean
}

const STEP = '  '
const deeper = (ctx: Ctx): Ctx => ({ ind: ctx.ind + STEP })
const plain = (ctx: Ctx): Ctx => ({ ind: ctx.ind })

export function emit(ast: Node): string {
  if (ast.type === 'Program') {
    const body = stmts((ast as N).body, { ind: '' })
    return body ? body + '\n' : ''
  }
  return print(ast, { ind: '' })
}

/** Nodes to wrap in parens once, whatever their position (see `wrapLeftmost`). */
const wrapOnce = new WeakSet<object>()

function print(node: N, ctx: Ctx): string {
  const printer = PRINTERS[node.type]
  if (!printer) throw new Error(`emit: unknown node type "${node.type}"`)
  if (wrapOnce.delete(node)) return `(${printer(node, plain(ctx))})`
  return printer(node, ctx)
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

/** `node` as an operand that must bind at least as tight as `min`. */
function expr(node: N, ctx: Ctx, min = P.SEQ): string {
  const parens = prec(node) < min || (ctx.noIn && node.type === 'BinaryExpression' && node.operator === 'in')
  return parens ? `(${print(node, plain(ctx))})` : print(node, ctx)
}

/** Object of a member access, callee, tag: a left-hand-side expression. */
function lhs(node: N, ctx: Ctx): string {
  // `(a?.b).c` ends the chain; without parens it would continue it.
  if (node.type === 'ChainExpression') return `(${print(node, plain(ctx))})`
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

const comment = (c: N) => (c.kind === 'Line' ? `//${c.value}` : `/*${c.value}*/`)
const isComment = (n: N) => n !== null && n.type === 'Comment'

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
function list(items: N[], ctx: Ctx, item: (n: N, ctx: Ctx) => string, o: ListOptions): string {
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
    const inline = bare ? ctx : plain(ctx)
    let s = groups.map((g) => [...g.comments.map(comment), item(g.node, inline)].join(' ')).join(`${sep} `)
    if (groups.at(-1)!.node === null) s += sep // `[a, ,]`: a trailing hole needs its comma
    return pad ? `${open} ${s} ${close}` : open + s + close
  }

  const inner = deeper(ctx)
  const lines: string[] = []
  groups.forEach((g, i) => {
    for (const c of g.comments) lines.push(inner.ind + comment(c))
    const last = i === groups.length - 1
    const end = last && (!trailing || g.node?.type === 'RestElement') ? '' : sep.trim()
    lines.push(inner.ind + (g.node === null ? '' : item(g.node, inner)) + end)
  })
  for (const c of pending) lines.push(inner.ind + comment(c))
  return `${open}\n${lines.join('\n')}\n${ctx.ind}${close}`
}

const exprItem = (n: N, ctx: Ctx) => (n === null ? '' : expr(n, ctx, P.ASSIGN))
const nodeItem = (n: N, ctx: Ctx) => (n === null ? '' : print(n, ctx))

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

/** One per line, each indented by `ctx.ind`; comments on their own lines. */
function stmts(items: N[], ctx: Ctx, { asi = true } = {}): string {
  const lines: string[] = []
  let pending: string[] = []
  let prev: N | undefined
  for (const n of items) {
    if (isComment(n)) {
      pending.push(comment(n))
      continue
    }
    let s = print(n, ctx)
    if (asi && prev && openEnd(prev) && ASI_HAZARD.test(s)) s = ';' + s
    if (prev && (spaced(prev) || spaced(n))) lines.push('')
    for (const c of pending) lines.push(ctx.ind + c)
    pending = []
    lines.push(ctx.ind + s)
    prev = n
  }
  for (const c of pending) lines.push(ctx.ind + c)
  return lines.join('\n')
}

const block = (items: N[], ctx: Ctx, options?: { asi?: boolean }) =>
  items.length ? `{\n${stmts(items, deeper(ctx), options)}\n${ctx.ind}}` : '{}'

/** Body of if/for/while: a block, or a statement on the same line. */
const body = (n: N, ctx: Ctx) => ' ' + print(n, plain(ctx))

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

/** `: T` */
const ann = (n: N, ctx: Ctx) => (n ? ': ' + type(n.typeAnnotation, ctx) : '')

const typeParams = (n: N, ctx: Ctx) => (n ? list(n.params, ctx, nodeItem, { open: '<', close: '>' }) : '')
const typeArgs = (n: N, ctx: Ctx) => (n ? list(n.params, ctx, typeItem, { open: '<', close: '>' }) : '')

function decorators(items: N[] | undefined, ctx: Ctx) {
  if (!items?.length) return ''
  return list(items, ctx, nodeItem, { open: '', close: '', sep: '', trailing: false }) + ' '
}

const key = (n: N, ctx: Ctx) => (n.computed ? `[${expr(n.key, plain(ctx), P.ASSIGN)}]` : print(n.key, ctx))

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
function method(n: N, ctx: Ctx, prefix: string) {
  const f = n.value
  let s = decorators(n.decorators, ctx) + prefix
  if (f.async) s += 'async '
  if (n.kind === 'get' || n.kind === 'set') s += n.kind + ' '
  if (f.generator) s += '*'
  s += key(n, ctx) + (n.optional ? '?' : '')
  return s + signature(f, ctx) + (f.body ? ' ' + block(f.body.body, ctx) : '')
}

/** `<T>(a: A): R` */
const signature = (f: N, ctx: Ctx) => typeParams(f.typeParameters, ctx) + params(f.params, ctx) + ann(f.returnType, ctx)

function fn(n: N, ctx: Ctx) {
  let s = n.declare ? 'declare ' : ''
  if (n.async) s += 'async '
  s += 'function' + (n.generator ? '*' : '') + ' ' + (n.id ? print(n.id, ctx) : '')
  return s + signature(n, ctx) + (n.body ? ' ' + block(n.body.body, ctx) : '')
}

function cls(n: N, ctx: Ctx) {
  let s = decorators(n.decorators, ctx)
  if (n.declare) s += 'declare '
  if (n.abstract) s += 'abstract '
  s += 'class' + (n.id ? ' ' + print(n.id, ctx) : '') + typeParams(n.typeParameters, ctx)
  if (n.superClass) s += ' extends ' + lhs(n.superClass, ctx) + typeArgs(n.superTypeArguments, ctx)
  if (n.implements?.length) s += ' implements ' + list(n.implements, ctx, nodeItem, { open: '', close: '', trailing: false })
  return s + ' ' + print(n.body, ctx)
}

/** Identifier and patterns in a binding position: `a?: T`. */
const binding = (n: N, ctx: Ctx, s: string) =>
  decorators(n.decorators, ctx) + s + (n.optional ? '?' : '') + ann(n.typeAnnotation, ctx)

/** Statement-start forms that would be read as something else. */
const STATEMENT_START = /^(\{|function\b|class\b|let\s*\[|async\s+function\b)/
const DEFAULT_EXPORT_START = /^(function\b|class\b|async\s+function\b)/

const importSource = (n: N, ctx: Ctx) => ' from ' + print(n.source, ctx) + attributes(n, ctx)

/** ` with { type: 'json' }` */
const attributes = (n: N, ctx: Ctx) =>
  n.attributes?.length ? ' with ' + list(n.attributes, ctx, nodeItem, { open: '{', close: '}', pad: true }) : ''

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

function type(n: N, ctx: Ctx, min = T.FUNCTION): string {
  const s = print(n, ctx)
  return typePrec(n) < min ? `(${s})` : s
}

const typeItem = (n: N, ctx: Ctx) => type(n, ctx)

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

// ---------------------------------------------------------------------------
// Printers

type Printer = (n: N, ctx: Ctx) => string

const PRINTERS: Record<string, Printer> = {
  Comment: (n) => comment(n),

  // --- statements ---
  Program: (n, ctx) => stmts(n.body, ctx),
  ExpressionStatement(n, ctx) {
    if (n.directive !== undefined) return print(n.expression, ctx)
    wrapLeftmost(n.expression, /^(FunctionExpression|ClassExpression|ObjectExpression)$/)
    const s = expr(n.expression, ctx)
    return STATEMENT_START.test(s) ? `(${s})` : s
  },
  BlockStatement: (n, ctx) => block(n.body, ctx),
  StaticBlock: (n, ctx) => 'static ' + block(n.body, ctx),
  EmptyStatement: () => ';',
  DebuggerStatement: () => 'debugger',
  ReturnStatement: (n, ctx) => 'return' + (n.argument ? ' ' + expr(n.argument, ctx) : ''),
  ThrowStatement: (n, ctx) => 'throw ' + expr(n.argument, ctx),
  BreakStatement: (n, ctx) => 'break' + (n.label ? ' ' + print(n.label, ctx) : ''),
  ContinueStatement: (n, ctx) => 'continue' + (n.label ? ' ' + print(n.label, ctx) : ''),
  LabeledStatement: (n, ctx) => print(n.label, ctx) + ':' + body(n.body, ctx),
  WithStatement: (n, ctx) => `with (${expr(n.object, plain(ctx))})` + body(n.body, ctx),
  WhileStatement: (n, ctx) => `while (${expr(n.test, plain(ctx))})` + body(n.body, ctx),
  DoWhileStatement(n, ctx) {
    const b = print(n.body, plain(ctx))
    // `do x() while (y)` is a syntax error without `;`, so a new line instead.
    const sep = n.body.type === 'BlockStatement' ? ' ' : `\n${ctx.ind}`
    return `do ${b}${sep}while (${expr(n.test, plain(ctx))})`
  },
  IfStatement(n, ctx) {
    let cons = n.consequent
    // `if (a) if (b) x; else y` would give the else to the inner if.
    if (n.alternate && danglingIf(cons)) cons = { type: 'BlockStatement', body: [cons] }
    let s = `if (${expr(n.test, plain(ctx))})` + body(cons, ctx)
    if (n.alternate) {
      s += cons.type === 'BlockStatement' ? ' ' : `\n${ctx.ind}`
      s += 'else' + body(n.alternate, ctx)
    }
    return s
  },
  ForStatement(n, ctx) {
    const head = { ind: ctx.ind, noIn: true }
    const init = n.init ? (n.init.type === 'VariableDeclaration' ? print(n.init, head) : expr(n.init, head)) : ''
    const test = n.test ? ' ' + expr(n.test, plain(ctx)) : ''
    const update = n.update ? ' ' + expr(n.update, plain(ctx)) : ''
    return `for (${init};${test};${update})` + body(n.body, ctx)
  },
  ForInStatement: (n, ctx) => `for (${forLeft(n.left, ctx)} in ${expr(n.right, plain(ctx))})` + body(n.body, ctx),
  ForOfStatement: (n, ctx) =>
    `for${n.await ? ' await' : ''} (${forLeft(n.left, ctx)} of ${expr(n.right, plain(ctx), P.ASSIGN)})` + body(n.body, ctx),
  TryStatement(n, ctx) {
    let s = 'try ' + print(n.block, ctx)
    if (n.handler) s += ' ' + print(n.handler, ctx)
    if (n.finalizer) s += ' finally ' + print(n.finalizer, ctx)
    return s
  },
  CatchClause: (n, ctx) => 'catch ' + (n.param ? `(${print(n.param, ctx)}) ` : '') + print(n.body, ctx),
  SwitchStatement(n, ctx) {
    const head = `switch (${expr(n.discriminant, plain(ctx))}) `
    return head + (n.cases.length ? `{\n${stmts(n.cases, deeper(ctx), { asi: false })}\n${ctx.ind}}` : '{}')
  },
  SwitchCase(n, ctx) {
    const head = n.test ? `case ${expr(n.test, ctx)}:` : 'default:'
    const c = n.consequent
    if (c.length === 1 && c[0].type === 'BlockStatement') return head + ' ' + print(c[0], ctx)
    return c.length ? `${head}\n${stmts(c, deeper(ctx))}` : head
  },
  VariableDeclaration(n, ctx) {
    const decls = list(n.declarations, ctx, nodeItem, { open: '', close: '', trailing: false, bare: true })
    return (n.declare ? 'declare ' : '') + n.kind + ' ' + decls
  },
  VariableDeclarator(n, ctx) {
    const id = print(n.id, ctx) + (n.definite ? '!' : '')
    return n.init ? `${id} = ${expr(n.init, ctx, P.ASSIGN)}` : id
  },
  FunctionDeclaration: fn,
  FunctionExpression: fn,
  TSDeclareFunction: fn,
  TSEmptyBodyFunctionExpression: fn,
  ClassDeclaration: cls,
  ClassExpression: cls,
  ClassBody: (n, ctx) => block(n.body, ctx),
  MethodDefinition: (n, ctx) => method(n, ctx, modifiers(n)),
  TSAbstractMethodDefinition: (n, ctx) => method(n, ctx, modifiers(n)),
  PropertyDefinition: property,
  AccessorProperty: property,
  TSAbstractPropertyDefinition: property,
  TSAbstractAccessorProperty: property,
  Decorator(n, ctx) {
    const e = n.expression
    const simple = /^(Identifier|MemberExpression|CallExpression)$/.test(e.type) && !hasComputed(e)
    return '@' + (simple ? print(e, ctx) : `(${print(e, plain(ctx))})`)
  },

  // --- modules ---
  ImportDeclaration(n, ctx) {
    const s = 'import ' + (n.importKind === 'type' ? 'type ' : '') + (n.phase ? n.phase + ' ' : '')
    const specs: N[] = n.specifiers
    // `import {} from 'x'` and `import 'x'` are one AST; the short form wins.
    if (!specs.some((x) => !isComment(x))) return s + print(n.source, ctx) + attributes(n, ctx)
    const named = specs.filter((x) => x.type === 'ImportSpecifier' || isComment(x))
    const head = specs.filter((x) => x.type === 'ImportDefaultSpecifier' || x.type === 'ImportNamespaceSpecifier')
    const parts = head.map((x) => print(x, ctx))
    if (named.some((x) => !isComment(x))) parts.push(list(named, ctx, nodeItem, { open: '{', close: '}', pad: true }))
    return s + parts.join(', ') + importSource(n, ctx)
  },
  ImportDefaultSpecifier: (n, ctx) => print(n.local, ctx),
  ImportNamespaceSpecifier: (n, ctx) => '* as ' + print(n.local, ctx),
  ImportSpecifier(n, ctx) {
    const kind = n.importKind === 'type' ? 'type ' : ''
    const imported = print(n.imported, ctx)
    const local = print(n.local, ctx)
    return kind + (imported === local ? local : `${imported} as ${local}`)
  },
  ImportAttribute: (n, ctx) => `${print(n.key, ctx)}: ${print(n.value, ctx)}`,
  ExportNamedDeclaration(n, ctx) {
    if (n.declaration) return 'export ' + print(n.declaration, ctx)
    const kind = n.exportKind === 'type' ? 'type ' : ''
    const specs = list(n.specifiers, ctx, nodeItem, { open: '{', close: '}', pad: true })
    return 'export ' + kind + specs + (n.source ? importSource(n, ctx) : '')
  },
  ExportSpecifier(n, ctx) {
    const kind = n.exportKind === 'type' ? 'type ' : ''
    const local = print(n.local, ctx)
    const exported = print(n.exported, ctx)
    return kind + (local === exported ? local : `${local} as ${exported}`)
  },
  ExportDefaultDeclaration(n, ctx) {
    const d = n.declaration
    if (/^(FunctionDeclaration|ClassDeclaration|TSDeclareFunction|TSInterfaceDeclaration)$/.test(d.type)) {
      return 'export default ' + print(d, ctx)
    }
    wrapLeftmost(d, /^(FunctionExpression|ClassExpression)$/)
    const s = expr(d, ctx, P.ASSIGN)
    return 'export default ' + (DEFAULT_EXPORT_START.test(s) ? `(${s})` : s)
  },
  ExportAllDeclaration(n, ctx) {
    const kind = n.exportKind === 'type' ? 'type ' : ''
    return 'export ' + kind + '*' + (n.exported ? ' as ' + print(n.exported, ctx) : '') + importSource(n, ctx)
  },

  // --- expressions ---
  Identifier: (n, ctx) => binding(n, ctx, n.name),
  PrivateIdentifier: (n) => '#' + n.name,
  Literal: literal,
  ThisExpression: () => 'this',
  Super: () => 'super',
  MetaProperty: (n, ctx) => `${print(n.meta, ctx)}.${print(n.property, ctx)}`,
  TemplateLiteral(n, ctx) {
    let s = '`'
    n.quasis.forEach((q: N, i: number) => {
      s += q.value.raw
      if (i < n.expressions.length) s += '${' + expr(n.expressions[i], plain(ctx)) + '}'
    })
    return s + '`'
  },
  TemplateElement: (n) => n.value.raw,
  TaggedTemplateExpression: (n, ctx) => lhs(n.tag, ctx) + typeArgs(n.typeArguments, ctx) + print(n.quasi, ctx),
  ArrayExpression: (n, ctx) => list(n.elements, ctx, exprItem, { open: '[', close: ']' }),
  ArrayPattern: (n, ctx) => binding(n, ctx, list(n.elements, ctx, nodeItem, { open: '[', close: ']' })),
  ObjectExpression: (n, ctx) => list(n.properties, ctx, nodeItem, { open: '{', close: '}', pad: true }),
  ObjectPattern: (n, ctx) => binding(n, ctx, list(n.properties, ctx, nodeItem, { open: '{', close: '}', pad: true })),
  Property(n, ctx) {
    if (n.method || n.kind === 'get' || n.kind === 'set') return method(n, ctx, '')
    if (n.shorthand) return print(n.value, ctx)
    return `${key(n, ctx)}: ${expr(n.value, ctx, P.ASSIGN)}`
  },
  SpreadElement: (n, ctx) => '...' + expr(n.argument, ctx, P.ASSIGN),
  RestElement: (n, ctx) => binding(n, ctx, '...' + print(n.argument, ctx)),
  AssignmentPattern: (n, ctx) => `${print(n.left, ctx)} = ${expr(n.right, ctx, P.ASSIGN)}`,
  ArrowFunctionExpression(n, ctx) {
    let s = n.async ? 'async ' : ''
    // `<T,>`: a bare `<T>` would start JSX in .tsx files.
    const tp = n.typeParameters
    if (tp?.params.length === 1 && !tp.params[0].constraint && !isComment(tp.params[0])) s += `<${print(tp.params[0], ctx)},>`
    else s += typeParams(tp, ctx)
    s += params(n.params, ctx) + ann(n.returnType, ctx) + ' => '
    if (n.body.type === 'BlockStatement') return s + block(n.body.body, ctx)
    wrapLeftmost(n.body, /^ObjectExpression$/)
    const b = expr(n.body, ctx, P.ASSIGN)
    return s + (b.startsWith('{') ? `(${b})` : b)
  },
  SequenceExpression: (n, ctx) =>
    list(n.expressions, ctx, exprItem, { open: '', close: '', trailing: false, bare: true }),
  AssignmentExpression: (n, ctx) => `${expr(n.left, ctx, P.CALL)} ${n.operator} ${expr(n.right, ctx, P.ASSIGN)}`,
  ConditionalExpression: (n, ctx) =>
    `${expr(n.test, ctx, P.NULLISH)} ? ${expr(n.consequent, ctx, P.ASSIGN)} : ${expr(n.alternate, ctx, P.ASSIGN)}`,
  LogicalExpression: binary,
  BinaryExpression: binary,
  UnaryExpression(n, ctx) {
    const arg = expr(n.argument, ctx, P.UNARY)
    if (/^[a-z]/.test(n.operator)) return `${n.operator} ${arg}`
    // `- -x`, `+ +x`, `- --x`: no space would make `--`/`++`.
    return n.operator + ((n.operator === '-' || n.operator === '+') && arg[0] === n.operator ? ' ' : '') + arg
  },
  UpdateExpression(n, ctx) {
    const arg = expr(n.argument, ctx, P.CALL)
    return n.prefix ? n.operator + arg : arg + n.operator
  },
  AwaitExpression: (n, ctx) => 'await ' + expr(n.argument, ctx, P.UNARY),
  YieldExpression: (n, ctx) =>
    'yield' + (n.delegate ? '*' : '') + (n.argument ? ' ' + expr(n.argument, ctx, P.ASSIGN) : ''),
  CallExpression: (n, ctx) =>
    lhs(n.callee, ctx) + (n.optional ? '?.' : '') + typeArgs(n.typeArguments, ctx) + args(n.arguments, ctx),
  NewExpression(n, ctx) {
    const callee = hasCall(n.callee) ? `(${print(n.callee, plain(ctx))})` : lhs(n.callee, ctx)
    return 'new ' + callee + typeArgs(n.typeArguments, ctx) + args(n.arguments, ctx)
  },
  MemberExpression(n, ctx) {
    let obj = lhs(n.object, ctx)
    // `1.toString()` would read `1.` as the number.
    if (n.object.type === 'Literal' && /^\d+$/.test(obj)) obj = `(${obj})`
    if (n.computed) return `${obj}${n.optional ? '?.' : ''}[${expr(n.property, plain(ctx))}]`
    return `${obj}${n.optional ? '?.' : '.'}${print(n.property, ctx)}`
  },
  ChainExpression: (n, ctx) => print(n.expression, ctx),
  ImportExpression: (n, ctx) => 'import' + args(n.options ? [n.source, n.options] : [n.source], ctx),

  // --- JSX ---
  JSXElement: (n, ctx) =>
    print(n.openingElement, ctx) + jsxChildren(n.children, ctx) + (n.closingElement ? print(n.closingElement, ctx) : ''),
  JSXFragment: (n, ctx) => '<>' + jsxChildren(n.children, ctx) + '</>',
  JSXOpeningElement(n, ctx) {
    const attrs = list(n.attributes, ctx, nodeItem, { open: '', close: '', sep: '', trailing: false })
    const name = print(n.name, ctx) + typeArgs(n.typeArguments, ctx)
    const sp = attrs.startsWith('\n') || !attrs ? attrs : ' ' + attrs
    return `<${name}${sp}${n.selfClosing ? (sp.startsWith('\n') ? '/>' : ' />') : '>'}`
  },
  JSXClosingElement: (n, ctx) => `</${print(n.name, ctx)}>`,
  JSXAttribute: (n, ctx) => print(n.name, ctx) + (n.value ? '=' + print(n.value, ctx) : ''),
  JSXSpreadAttribute: (n, ctx) => `{...${expr(n.argument, plain(ctx), P.ASSIGN)}}`,
  JSXSpreadChild: (n, ctx) => `{...${expr(n.expression, plain(ctx), P.ASSIGN)}}`,
  JSXExpressionContainer: (n, ctx) => `{${expr(n.expression, plain(ctx), P.ASSIGN)}}`,
  JSXEmptyExpression: () => '',
  JSXText: (n) => n.raw,
  JSXIdentifier: (n) => n.name,
  JSXNamespacedName: (n, ctx) => `${print(n.namespace, ctx)}:${print(n.name, ctx)}`,
  JSXMemberExpression: (n, ctx) => `${print(n.object, ctx)}.${print(n.property, ctx)}`,

  // --- TypeScript: expressions and declarations ---
  TSAsExpression: (n, ctx) => `${expr(n.expression, ctx, P.AS)} as ${type(n.typeAnnotation, ctx)}`,
  TSSatisfiesExpression: (n, ctx) => `${expr(n.expression, ctx, P.AS)} satisfies ${type(n.typeAnnotation, ctx)}`,
  TSNonNullExpression: (n, ctx) => lhs(n.expression, ctx) + '!',
  TSTypeAssertion: (n, ctx) => `<${type(n.typeAnnotation, ctx)}>${expr(n.expression, ctx, P.UNARY)}`,
  TSInstantiationExpression: (n, ctx) => lhs(n.expression, ctx) + typeArgs(n.typeArguments, ctx),
  TSParameterProperty: (n, ctx) => decorators(n.decorators, ctx) + modifiers(n) + print(n.parameter, ctx),
  TSTypeAliasDeclaration: (n, ctx) =>
    `${n.declare ? 'declare ' : ''}type ${print(n.id, ctx)}${typeParams(n.typeParameters, ctx)} = ${type(n.typeAnnotation, ctx)}`,
  TSInterfaceDeclaration(n, ctx) {
    let s = `${n.declare ? 'declare ' : ''}interface ${print(n.id, ctx)}${typeParams(n.typeParameters, ctx)}`
    if (n.extends?.length) s += ' extends ' + list(n.extends, ctx, nodeItem, { open: '', close: '', trailing: false })
    return s + ' ' + print(n.body, ctx)
  },
  TSInterfaceBody: (n, ctx) => block(n.body, ctx, { asi: false }),
  TSInterfaceHeritage: (n, ctx) => lhs(n.expression, ctx) + typeArgs(n.typeArguments, ctx),
  TSClassImplements: (n, ctx) => lhs(n.expression, ctx) + typeArgs(n.typeArguments, ctx),
  TSEnumDeclaration: (n, ctx) =>
    `${n.declare ? 'declare ' : ''}${n.const ? 'const ' : ''}enum ${print(n.id, ctx)} ${print(n.body, ctx)}`,
  TSEnumBody: (n, ctx) => list(n.members, ctx, nodeItem, { open: '{', close: '}', pad: true }),
  TSEnumMember: (n, ctx) =>
    (n.computed ? `[${print(n.id, ctx)}]` : print(n.id, ctx)) +
    (n.initializer ? ' = ' + expr(n.initializer, ctx, P.ASSIGN) : ''),
  TSModuleDeclaration(n, ctx) {
    let s = n.declare ? 'declare ' : ''
    s += n.kind === 'global' ? 'global' : `${n.kind} ${print(n.id, ctx)}`
    return n.body ? s + ' ' + print(n.body, ctx) : s
  },
  TSModuleBlock: (n, ctx) => block(n.body, ctx),
  TSImportEqualsDeclaration: (n, ctx) =>
    `import ${n.importKind === 'type' ? 'type ' : ''}${print(n.id, ctx)} = ${print(n.moduleReference, ctx)}`,
  TSExternalModuleReference: (n, ctx) => `require(${print(n.expression, ctx)})`,
  TSExportAssignment: (n, ctx) => 'export = ' + expr(n.expression, ctx, P.ASSIGN),
  TSNamespaceExportDeclaration: (n, ctx) => 'export as namespace ' + print(n.id, ctx),
  TSIndexSignature: (n, ctx) =>
    modifiers(n) + list(n.parameters, ctx, nodeItem, { open: '[', close: ']' }) + ann(n.typeAnnotation, ctx),
  TSTypeParameterDeclaration: (n, ctx) => typeParams(n, ctx),
  TSTypeParameterInstantiation: (n, ctx) => typeArgs(n, ctx),
  TSTypeParameter(n, ctx) {
    let s = (n.const ? 'const ' : '') + (n.in ? 'in ' : '') + (n.out ? 'out ' : '') + print(n.name, ctx)
    if (n.constraint) s += ' extends ' + type(n.constraint, ctx)
    if (n.default) s += ' = ' + type(n.default, ctx)
    return s
  },
  TSTypeAnnotation: (n, ctx) => type(n.typeAnnotation, ctx),

  // --- TypeScript: types ---
  TSTypeReference: (n, ctx) => print(n.typeName, ctx) + typeArgs(n.typeArguments, ctx),
  TSQualifiedName: (n, ctx) => `${print(n.left, ctx)}.${print(n.right, ctx)}`,
  TSUnionType: (n, ctx) =>
    list(n.types, ctx, (t, c) => type(t, c, T.INTERSECTION), { open: '', close: '', sep: ' |', trailing: false }),
  TSIntersectionType: (n, ctx) =>
    list(n.types, ctx, (t, c) => type(t, c, T.OPERATOR), { open: '', close: '', sep: ' &', trailing: false }),
  TSArrayType: (n, ctx) => type(n.elementType, ctx, T.POSTFIX) + '[]',
  TSIndexedAccessType: (n, ctx) => `${type(n.objectType, ctx, T.POSTFIX)}[${type(n.indexType, ctx)}]`,
  TSTypeOperator: (n, ctx) => `${n.operator} ${type(n.typeAnnotation, ctx, T.OPERATOR)}`,
  TSInferType: (n, ctx) => 'infer ' + print(n.typeParameter, ctx),
  TSConditionalType: (n, ctx) =>
    `${type(n.checkType, ctx, T.UNION)} extends ${type(n.extendsType, ctx, T.UNION)} ? ${type(n.trueType, ctx)} : ${type(n.falseType, ctx)}`,
  TSFunctionType: (n, ctx) => `${signatureNoReturn(n, ctx)} => ${type(n.returnType.typeAnnotation, ctx)}`,
  TSConstructorType: (n, ctx) =>
    `${n.abstract ? 'abstract ' : ''}new ${signatureNoReturn(n, ctx)} => ${type(n.returnType.typeAnnotation, ctx)}`,
  TSTypeLiteral: (n, ctx) => typeMembers(n.members, ctx),
  TSPropertySignature: (n, ctx) =>
    (n.readonly ? 'readonly ' : '') + key(n, ctx) + (n.optional ? '?' : '') + ann(n.typeAnnotation, ctx),
  TSMethodSignature(n, ctx) {
    const kind = n.kind === 'get' || n.kind === 'set' ? n.kind + ' ' : ''
    return kind + key(n, ctx) + (n.optional ? '?' : '') + signature(n, ctx)
  },
  TSCallSignatureDeclaration: (n, ctx) => signature(n, ctx),
  TSConstructSignatureDeclaration: (n, ctx) => 'new ' + signature(n, ctx),
  TSMappedType(n, ctx) {
    let s = readonlyMark(n.readonly) + `[${print(n.key, ctx)} in ${type(n.constraint, ctx)}`
    if (n.nameType) s += ' as ' + type(n.nameType, ctx)
    s += ']' + optionalMark(n.optional)
    if (n.typeAnnotation) s += ': ' + type(n.typeAnnotation, ctx)
    return `{ ${s} }`
  },
  TSTupleType: (n, ctx) => list(n.elementTypes, ctx, typeItem, { open: '[', close: ']' }),
  TSNamedTupleMember: (n, ctx) => `${print(n.label, ctx)}${n.optional ? '?' : ''}: ${type(n.elementType, ctx)}`,
  TSOptionalType: (n, ctx) => type(n.typeAnnotation, ctx, T.POSTFIX) + '?',
  TSRestType: (n, ctx) => '...' + type(n.typeAnnotation, ctx),
  TSLiteralType: (n, ctx) => print(n.literal, ctx),
  TSTemplateLiteralType(n, ctx) {
    let s = '`'
    n.quasis.forEach((q: N, i: number) => {
      s += q.value.raw
      if (i < n.types.length) s += '${' + type(n.types[i], ctx) + '}'
    })
    return s + '`'
  },
  TSTypeQuery: (n, ctx) => 'typeof ' + print(n.exprName, ctx) + typeArgs(n.typeArguments, ctx),
  TSImportType(n, ctx) {
    let s = 'import' + list(n.options ? [n.source, n.options] : [n.source], ctx, nodeItem, { open: '(', close: ')' })
    if (n.qualifier) s += '.' + print(n.qualifier, ctx)
    return s + typeArgs(n.typeArguments, ctx)
  },
  TSTypePredicate(n, ctx) {
    const s = (n.asserts ? 'asserts ' : '') + print(n.parameterName, ctx)
    return n.typeAnnotation ? `${s} is ${type(n.typeAnnotation.typeAnnotation, ctx)}` : s
  },
}

for (const [name, word] of Object.entries(KEYWORDS)) PRINTERS[name] = () => word

function property(n: N, ctx: Ctx) {
  let s = decorators(n.decorators, ctx) + modifiers(n)
  if (n.type === 'AccessorProperty' || n.type === 'TSAbstractAccessorProperty') s += 'accessor '
  s += key(n, ctx) + (n.optional ? '?' : '') + (n.definite ? '!' : '') + ann(n.typeAnnotation, ctx)
  return n.value ? `${s} = ${expr(n.value, ctx, P.ASSIGN)}` : s
}

function binary(n: N, ctx: Ctx) {
  const p = BINARY[n.operator]
  const right = n.operator === '**'
  let l = expr(n.left, ctx, right ? P.POSTFIX : p)
  let r = expr(n.right, ctx, right ? p : p + 1)
  // `a ?? b || c` is a syntax error: `??` never mixes with `||`/`&&` without parens.
  if (mixesNullish(n, n.left) && !l.startsWith('(')) l = `(${l})`
  if (mixesNullish(n, n.right) && !r.startsWith('(')) r = `(${r})`
  return `${l} ${n.operator} ${r}`
}

function mixesNullish(parent: N, child: N) {
  if (child.type !== 'LogicalExpression' || parent.type !== 'LogicalExpression') return false
  return (parent.operator === '??') !== (child.operator === '??')
}

function signatureNoReturn(n: N, ctx: Ctx) {
  return typeParams(n.typeParameters, ctx) + params(n.params, ctx)
}

function forLeft(n: N, ctx: Ctx) {
  return n.type === 'VariableDeclaration' ? print(n, plain(ctx)) : expr(n, plain(ctx), P.CALL)
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

/** JSX children are printed verbatim; a comment child becomes `{/* c *\/}`. */
function jsxChildren(children: N[], ctx: Ctx) {
  return children
    .map((c) => {
      if (!isComment(c)) return print(c, ctx)
      return c.kind === 'Line' ? `{${comment(c)}\n${ctx.ind}}` : `{${comment(c)}}`
    })
    .join('')
}

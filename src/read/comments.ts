// Puts comments into the tree as `Comment` nodes, one canonical place each:
//
//   A comment is a node in the nearest enclosing list (body, arguments, params,
//   properties, ...) and stands right before the list element it belongs to.
//
// Owner, for a comment between elements of a list:
//   - on the line where the previous element ends and followed by a newline or a
//     comma (`x = 1 // note`, `f(a /* a */, b)`) -> the previous element;
//   - otherwise -> the next element (`f(a, /* b */ b)`); grouping parentheses
//     before it don't count (`f(/* c */ (a))`);
//   - no next element -> stays at the end of the list.
// A comment in no list (`if (/* c */ a == 0)`, `x = /* @__PURE__ */ f()`,
// `a + // why` then `b`) stays in place: it leads the node right after it, the
// next child of the deepest node around it, and goes into that node's `comments`
// attribute (a list of Comment nodes, not a slot). So the owner is the outermost
// node that starts after the comment: in `x = /* c */ a + b` the sum, not `a`.
// `emit` prints a leading line comment followed by a line break. Exceptions,
// which belong to the enclosing list element and move before it:
//   - a comment with nothing after it in its node (`a /* c */`, before a postfix `++`);
//   - template literal text (quasis) never takes one: it would be inside the string;
//   - a line comment where the printed line break would change the meaning: before
//     a class member's key after `async` or a modifier (`static // c` newline
//     `async m() {}` would print as `static async // c` newline `m() {}`), and the
//     other slots in `sameLine`.
// A JSDoc cast, a block comment starting `/** @type` or `/** @satisfies` right
// before `(` on the same line (only spaces between), is a leading comment of the
// expression in those grouping parentheses, wherever it is (`f(/** @type {T} */
// (x))`, `/** @type {T} */ (a).b`: `x`, `a`). `emit` prints it with the
// parentheses. Not across a line break, so a JSDoc on its own line before a
// statement that starts with `(` stays a statement comment (and `emit` can keep
// such a list comment apart from a `(` that follows it).
// The layout of a comment (same line or not) is not stored: after one read/emit
// round the result is a fixed point.
import type { EsNode, RawComment } from './parser.ts'

export interface EsComment extends EsNode {
  type: 'Comment'
  kind: 'Line' | 'Block'
  value: string
}

/** Lists that pair up positionally: a Comment in them would break the pairing. */
const NO_COMMENT_LISTS = new Set(['TemplateLiteral', 'TSTemplateLiteralType'])
const SKIP_KEYS = new Set(['range', 'loc', 'parent'])

export const isNode = (value: unknown): value is EsNode =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as EsNode).type === 'string' &&
  Array.isArray((value as EsNode).range)

/**
 * Keys of `node` that hold children. Skips positions, Program's own tokens, and
 * `comments`: the parser's list on Program, leading comments (an attribute) elsewhere.
 */
export function* childKeys(node: EsNode) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key) || key === 'comments') continue
    if (node.type === 'Program' && key === 'tokens') continue
    yield key
  }
}

/** `/** @type {T} *\/`, `/** @satisfies {T} *\/`: a type cast for tsc when parentheses follow. */
export const isCast = (c: { kind: string; value: string }): boolean =>
  c.kind === 'Block' && /^\*\s*(?:\*\s*)?@(?:type|satisfies)\b/.test(c.value)

/** A node as `sameLine` needs it: ESTree or ours, by type and attributes. */
interface Attrs {
  type: string
  [key: string]: unknown
}

/**
 * True when a line break right before the child in slot `key` of `parent` would
 * change the meaning, so a line comment can't lead that child: `break // c`
 * newline `label`, a class member key after `async` or a modifier, `asserts x`.
 * (`return`/`throw`/`yield` are fine: `emit` puts the argument in parentheses.)
 */
export function sameLine(parent: Attrs, key: string): boolean {
  switch (parent.type) {
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label'
    case 'TSTypePredicate':
      return key === 'parameterName' && !!parent.asserts
    case 'ArrowFunctionExpression':
      return key === 'typeParameters' && !!parent.async
    case 'TSParameterProperty':
      return key === 'parameter'
    case 'TSTypeAliasDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSModuleDeclaration':
      return key === 'id'
    case 'MethodDefinition':
    case 'TSAbstractMethodDefinition':
    case 'PropertyDefinition':
    case 'TSAbstractPropertyDefinition':
    case 'AccessorProperty':
    case 'TSAbstractAccessorProperty':
    case 'Property':
    case 'TSPropertySignature':
      return key === 'key' && keyAfterModifier(parent)
    default:
      return false
  }
}

/** The key of a member follows a word that must stay on its line: `async m() {}`, `accessor x`, `readonly x`. */
function keyAfterModifier(n: Attrs): boolean {
  if (n.declare || n.accessibility || n.override || n.readonly) return true
  if (/Accessor|^TSAbstract/.test(n.type)) return true
  const f = n.value as Attrs | null | undefined
  return !!f && /Function/.test(f.type) && !!f.async && !f.generator
}

interface Child {
  node: EsNode
  key: string
  /** The list `node` sits in, if comments may go there. */
  list?: unknown[]
}

function childrenOf(node: EsNode) {
  const commentable = !NO_COMMENT_LISTS.has(node.type)
  const children: Child[] = []
  const lists: unknown[][] = []
  /** A child held directly by a key, not in a list (`test`, `callee`, ...). */
  let hasFieldChild = false
  for (const key of childKeys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      if (commentable) lists.push(value)
      for (const el of value) {
        if (isNode(el) && el.type !== 'Comment') children.push({ node: el, key, list: commentable ? value : undefined })
      }
    } else if (isNode(value)) {
      children.push({ node: value, key })
      hasFieldChild = true
    }
  }
  children.sort((a, b) => a.node.range[0] - b.node.range[0])
  return { children, lists, hasFieldChild }
}

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g
/** Text between two positions with other comments removed. */
const gap = (text: string, from: number, to: number) => text.slice(from, to).replace(COMMENTS, ' ')
/** Only whitespace and commas: the comment sits among the list's elements. */
const isSeparator = (s: string) => /^[\s,]*$/.test(s)
/** Before the next element, grouping parentheses don't count: `f(/* c *\/ (a))`. */
const isSeparatorBefore = (s: string) => /^[\s,(]*$/.test(s)

const insertBefore = (list: unknown[], owner: EsNode, comment: EsComment) =>
  void list.splice(list.indexOf(owner), 0, comment)

/** True if placed somewhere inside `node`; false means "belongs to `node` as a whole". */
function place(node: EsNode, comment: EsComment, text: string): boolean {
  const [start, end] = comment.range
  const { children, lists, hasFieldChild } = childrenOf(node)

  for (const child of children) {
    const [s, e] = child.node.range
    if (s <= start && end <= e) {
      if (place(child.node, comment, text)) return true
      if (!child.list) return false
      insertBefore(child.list, child.node, comment)
      return true
    }
  }

  // In a gap between the children of `node`.
  let prev: Child | undefined
  let next: Child | undefined
  for (const child of children) {
    if (child.node.range[1] <= start) prev = child
    else if (child.node.range[0] >= end) {
      next = child
      break
    }
  }
  const before = prev && gap(text, prev.node.range[1], start)
  const after = next && gap(text, end, next.node.range[0])
  const prevAdjacent = prev?.list && isSeparator(before!)
  const nextAdjacent = next?.list && isSeparatorBefore(after!)

  if (prevAdjacent && !before!.includes('\n')) {
    const trailing = !nextAdjacent || prev!.list !== next!.list || /[\n,]/.test(after!)
    if (trailing) {
      insertBefore(prev!.list!, prev!.node, comment)
      return true
    }
  }
  if (nextAdjacent) {
    insertBefore(next!.list!, next!.node, comment)
    return true
  }
  if (prevAdjacent) {
    prev!.list!.push(comment)
    return true
  }
  // The node is just brackets or keywords around one list (`{ /* only */ }`,
  // `default /* c */: a`): before the next element, or at the end.
  if (!hasFieldChild && lists.length === 1) {
    if (next) insertBefore(lists[0], next.node, comment)
    else lists[0].push(comment)
    return true
  }
  // In no list: the comment leads the next child (`test`, `right`, a template
  // expression). Not template text: the comment would end up inside the string.
  if (next && !next.list && next.node.type !== 'TemplateElement') {
    if (comment.kind === 'Line' && sameLine(node, next.key)) return false
    ;((next.node.comments ??= []) as EsComment[]).push(comment)
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// JSDoc casts: grouping parentheses

/** Keys that hold types: parentheses there are not a cast. */
const TYPE_KEYS = new Set(['typeAnnotation', 'typeArguments', 'typeParameters', 'returnType', 'superTypeArguments', 'implements', 'extends'])

/** A child slot that holds a pattern, where `(x)` can't be printed back (`[(a)] = b`, `{ a: (b) } = c`). */
const isPatternSlot = (node: EsNode, key: string, parent: EsNode | undefined) =>
  (node.type === 'ArrayPattern' && key === 'elements') ||
  (node.type === 'RestElement' && key === 'argument') ||
  (node.type === 'AssignmentPattern' && key === 'left') ||
  (node.type === 'Property' && key === 'value' && parent?.type === 'ObjectPattern')

/**
 * Which of the parentheses around a child are its parent's own syntax, not
 * grouping: all for a parameter (`(a) => a`), the outermost for `if (x)`,
 * `f(x)` (when they close the call) and the like.
 */
function ownParens(parent: EsNode, key: string, outer: [number, number]): 'all' | 'outer' | false {
  if (key === 'params' || key === 'parameters') return 'all'
  switch (parent.type) {
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return key === 'test' && 'outer'
    case 'SwitchStatement':
      return key === 'discriminant' && 'outer'
    case 'WithStatement':
      return key === 'object' && 'outer'
    case 'CatchClause':
      return key === 'param' && 'outer'
    case 'TSExternalModuleReference':
      return key === 'expression' && 'outer'
    case 'CallExpression':
    case 'NewExpression':
    case 'ImportExpression':
      return key !== 'callee' && outer[1] === parent.range[1] - 1 && 'outer'
    default:
      return false
  }
}

/**
 * The expressions in grouping parentheses, by the position of each `(`. Ranges
 * leave the parentheses out, so they are found in the text around each node;
 * several nodes in the same parentheses (`(a?.b)`: chain and member) give the
 * outermost.
 */
function groupingParens(program: EsNode, text: string, comments: RawComment[]): Map<number, EsNode> {
  const startOf = new Map(comments.map((c) => [c.end, c.start]))
  const endOf = new Map(comments.map((c) => [c.start, c.end]))
  const space = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)
  /** Back over whitespace and comments. */
  const skipLeft = (i: number) => {
    for (;;) {
      if (space(text[i - 1])) i--
      else if (startOf.has(i)) i = startOf.get(i)!
      else return i
    }
  }
  /** On over whitespace and comments. */
  const skipRight = (i: number) => {
    for (;;) {
      if (space(text[i])) i++
      else if (endOf.has(i)) i = endOf.get(i)!
      else return i
    }
  }

  const found = new Map<number, EsNode>()
  const visit = (node: EsNode, parent: EsNode | undefined, key: string, pattern: boolean) => {
    // Same range as the parent (a chain's call): the parent's parentheses, already seen.
    const sameRange = parent && parent.range[0] === node.range[0] && parent.range[1] === node.range[1]
    if (parent && !pattern && !sameRange) {
      const pairs: [number, number][] = []
      let [l, r] = node.range
      for (;;) {
        const open = skipLeft(l) - 1
        const close = skipRight(r)
        if (text[open] !== '(' || text[close] !== ')') break
        pairs.push([open, close])
        l = open
        r = close + 1
      }
      const own = pairs.length ? ownParens(parent, key, pairs.at(-1)!) : false
      if (own === 'all') pairs.length = 0
      else if (own === 'outer') pairs.pop()
      for (const [open] of pairs) if (!found.has(open)) found.set(open, node)
    }
    for (const k of childKeys(node)) {
      if (TYPE_KEYS.has(k)) continue
      const value = node[k]
      const inPattern = isPatternSlot(node, k, parent)
      if (Array.isArray(value)) {
        for (const el of value) if (isNode(el)) visit(el, node, k, inPattern)
      } else if (isNode(value)) visit(value, node, k, inPattern)
    }
  }
  visit(program, undefined, '', false)
  return found
}

/** Whitespace that is not a line break. */
const SAME_LINE_SPACE = new RegExp(`[^\\S\\n\\r${String.fromCharCode(0x2028, 0x2029)}]`)

/** Mutates `program`: every comment becomes a Comment node in a list or a `comments` attribute. */
export function attachComments(program: EsNode, comments: RawComment[], text: string) {
  // Comments before the first or after the last token belong to the Program too.
  program.range = [0, text.length]
  const body = program.body as unknown[]
  const sorted = [...comments].sort((a, b) => a.start - b.start)
  const parens = sorted.some(isCast) ? groupingParens(program, text, sorted) : undefined
  for (const raw of sorted) {
    const comment: EsComment = { type: 'Comment', kind: raw.kind, value: raw.value, range: [raw.start, raw.end] }
    let cast: EsNode | undefined
    if (parens && isCast(raw)) {
      let i = raw.end
      while (SAME_LINE_SPACE.test(text[i] ?? '')) i++
      cast = parens.get(i)
    }
    if (cast) ((cast.comments ??= []) as EsComment[]).push(comment)
    // Program is a list of statements, so a comment always finds a place.
    else if (!place(program, comment, text)) body.push(comment)
  }
}

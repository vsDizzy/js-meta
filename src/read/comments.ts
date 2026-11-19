// Puts comments into the tree as `Comment` nodes, one canonical place each:
//
//   A comment is a node in the nearest enclosing list (body, arguments, params,
//   properties, ...) and stands right before the list element it belongs to.
//
// Owner, for a comment between elements of a list:
//   - on the line where the previous element ends and followed by a newline or a
//     comma (`x = 1 // note`, `f(a /* a */, b)`) -> the previous element;
//   - otherwise -> the next element (`f(a, /* b */ b)`);
//   - no next element -> stays at the end of the list.
// A comment inside an element but in no list of its own (`if (/* c */ x)`) belongs
// to that element. The layout of a comment (same line or not) is not stored: after
// one read/emit round the result is a fixed point.
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

/** Keys of `node` that hold children (skips positions and Program's own comments/tokens). */
export function* childKeys(node: EsNode) {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    if (node.type === 'Program' && (key === 'comments' || key === 'tokens')) continue
    yield key
  }
}

interface Child {
  node: EsNode
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
        if (isNode(el) && el.type !== 'Comment') children.push({ node: el, list: commentable ? value : undefined })
      }
    } else if (isNode(value)) {
      children.push({ node: value })
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
  const nextAdjacent = next?.list && isSeparator(after!)

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
  // `{ /* only */ }`, `[ /* only */ ]`: the node is just brackets around one list.
  if (!hasFieldChild && lists.length === 1) {
    lists[0].push(comment)
    return true
  }
  return false
}

/** Mutates `program`: every comment becomes a Comment node in a list. */
export function attachComments(program: EsNode, comments: RawComment[], text: string) {
  // Comments before the first or after the last token belong to the Program too.
  program.range = [0, text.length]
  const body = program.body as unknown[]
  for (const raw of [...comments].sort((a, b) => a.start - b.start)) {
    const comment: EsComment = { type: 'Comment', kind: raw.kind, value: raw.value, range: [raw.start, raw.end] }
    // Program is a list of statements, so a comment always finds a place.
    if (!place(program, comment, text)) body.push(comment)
  }
}

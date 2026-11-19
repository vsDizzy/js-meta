// read(source) -> AST: nodes `{ type, ...attrs, children }` (ast/node.ts) for
// ESTree types and JSX included, with comments as `Comment` nodes in lists and
// positions in a side table (ast/origin.ts).
import { make, Node, slotsOf, type Slot } from '../ast/node.ts'
import { setOrigin, position, type SourceFile } from '../ast/origin.ts'
import { attachComments, childKeys, isNode } from './comments.ts'
import { ParseError, typescriptEstree, type EsNode, type Parser } from './parser.ts'

export { originOf, position, type Origin, type SourceFile } from '../ast/origin.ts'
export { typescriptEstree, ParseError, type Parser } from './parser.ts'
export { Node }

export interface Program extends Node {
  type: 'Program'
  sourceType: 'module' | 'script'
  body: Node[]
}

export interface ReadOptions {
  sourceType?: 'module' | 'script'
  /** Module URL; also picks the dialect by extension. Default: "input.js". */
  filename?: string
  parser?: Parser
}

export class ReadError extends SyntaxError {
  filename: string
  /** 1-based. */
  line: number
  /** 0-based, as in ESTree `loc`. */
  column: number
  constructor(message: string, file: SourceFile, offset: number) {
    const { line, column } = position(file.text, offset)
    super(`${message} (${file.url}:${line}:${column + 1})`)
    this.name = 'ReadError'
    this.filename = file.url
    this.line = line
    this.column = column
  }
}

const MODULE_DECLARATIONS = new Set([
  'ImportDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
  'ExportAllDeclaration',
])

export function read(source: string, options: ReadOptions = {}): Program {
  const { sourceType = 'module', filename = 'input.js', parser = typescriptEstree } = options
  const file: SourceFile = { url: filename, text: source }

  let parsed
  try {
    parsed = parser.parse(source, { filename })
  } catch (err) {
    if (err instanceof ParseError) throw new ReadError(err.message, file, err.offset)
    throw err
  }
  const { program, comments } = parsed

  if (sourceType === 'script') {
    const decl = (program.body as EsNode[]).find((n) => MODULE_DECLARATIONS.has(n.type))
    if (decl) throw new ReadError(`'${decl.type}' is only allowed in a module`, file, decl.range[0])
  }

  attachComments(program, comments, source)
  const ast = toAst(program, file) as Program
  ast.sourceType = sourceType
  return ast
}

/** `{}` in JSX children: nothing but a holder for comments, which are nodes now. */
const isEmptyJsxContainer = (value: unknown) =>
  isNode(value) && value.type === 'JSXExpressionContainer' && (value.expression as EsNode).type === 'JSXEmptyExpression'

const holdsNodes = (v: unknown) => isNode(v) || (Array.isArray(v) && v.some(isNode))

/** ESTree -> nodes: slots from the table, the rest as attrs; `range` moves to the origin table. */
function toAst(node: EsNode, file: SourceFile): Node {
  const slots = slotsOf(node.type)
  if (!slots) throw new Error(`read: no slots for node type "${node.type}" (add it to ast/slots.ts)`)
  const attrs: Record<string, unknown> = {}
  for (const key of childKeys(node)) {
    if (slots.includes(key)) continue
    if (holdsNodes(node[key])) throw new Error(`read: ${node.type}.${key} holds nodes but is not a slot (ast/slots.ts)`)
    attrs[key] = node[key]
  }
  const isJsx = node.type === 'JSXElement' || node.type === 'JSXFragment'
  const children = slots.map((key): Slot => {
    const value = node[key]
    if (Array.isArray(value)) {
      const items = isJsx && key === 'children' ? value.filter((v) => !isEmptyJsxContainer(v)) : value
      return items.map((v) => (isNode(v) ? toAst(v, file) : null))
    }
    return isNode(value) ? toAst(value, file) : null
  })
  const out = make(node.type, attrs, children)
  setOrigin(out, { file, start: node.range[0], end: node.range[1] })
  return out
}

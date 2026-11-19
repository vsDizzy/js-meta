// Side table: where a node came from. Kept off the node so that the AST stays
// plain data: structural equality and macros don't see positions.

export interface SourceFile {
  /** Module URL (or any name the caller passed as `filename`). */
  url: string
  text: string
}

export interface Origin {
  file: SourceFile
  /** Offsets into `file.text`, end exclusive. */
  start: number
  end: number
}

const origins = new WeakMap<object, Origin>()

export const setOrigin = (node: object, origin: Origin) => void origins.set(node, origin)

/** Undefined for nodes that were not read from source (e.g. built by a macro). */
export const originOf = (node: object): Origin | undefined => origins.get(node)

/** 1-based line, 0-based column (as in ESTree `loc`). */
export function position(text: string, offset: number) {
  let line = 1
  let lineStart = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++
    lineStart = i + 1
  }
  return { line, column: offset - lineStart }
}

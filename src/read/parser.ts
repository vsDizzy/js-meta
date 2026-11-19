// Parser backends. A backend turns source into ESTree; read() takes it from there,
// so swapping TypeScript for another ESTree parser touches only this file.
import { parse as tseParse } from '@typescript-eslint/typescript-estree'

/** An ESTree node as a backend returns it: `range` is required, the rest is ESTree. */
export interface EsNode {
  type: string
  range: [number, number]
  [key: string]: unknown
}

export interface RawComment {
  kind: 'Line' | 'Block'
  value: string
  start: number
  end: number
}

export interface ParseResult {
  /** ESTree Program; every node carries `range`. */
  program: EsNode
  comments: RawComment[]
}

export interface ParseOptions {
  /** Module URL or file name; its extension picks the dialect (.js, .jsx, .ts, .tsx). */
  filename: string
}

export interface Parser {
  name: string
  /** Throws ParseError on a syntax error. */
  parse(source: string, options: ParseOptions): ParseResult
}

export class ParseError extends Error {
  /** Offset into the source. */
  offset: number
  constructor(message: string, offset: number) {
    super(message)
    this.name = 'ParseError'
    this.offset = offset
  }
}

/** "http://x/a/b.tsx?t=1#h" -> "/a/b.tsx"; anything else is used as is. */
const toFilePath = (filename: string) => {
  if (!URL.canParse(filename)) return filename.replace(/[?#].*$/, '')
  return new URL(filename).pathname
}

/** TypeScript 6 via @typescript-eslint/typescript-estree: JS, JSX and TS syntax. */
export const typescriptEstree: Parser = {
  name: 'typescript-estree',
  parse(source, { filename }) {
    let program
    try {
      program = tseParse(source, {
        filePath: toFilePath(filename),
        // Only for unknown extensions; .js/.jsx/.ts/.tsx decide JSX themselves.
        jsx: true,
        range: true,
        comment: true,
      })
    } catch (err) {
      const index = (err as { index?: unknown }).index
      if (typeof index === 'number') throw new ParseError((err as Error).message, index)
      throw err
    }
    const comments = (program.comments ?? []).map(
      (c): RawComment => ({ kind: c.type, value: c.value, start: c.range[0], end: c.range[1] }),
    )
    return { program: program as unknown as EsNode, comments }
  },
}

// Comments at every token gap of the fixtures: wherever the source still
// parses, `read(emit(ast))` equals `ast` and `emit` is a fixed point.
// Statements are checked one at a time (small inputs keep this fast); the gaps
// between two statements are checked with both around them.
import { parse } from '@typescript-eslint/typescript-estree'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { read, ReadError } from '../read/index.ts'
import { emit } from './index.ts'

const FIXTURES = ['all.js', 'all.jsx', 'all.ts']

const INSERTS: [name: string, text: string][] = [
  ['line comment', '// c\n'],
  ['block comment', '/* c */'],
  ['JSDoc cast', '/** @type {T} */'],
]

/** A source and the positions to try in it. */
interface Piece {
  text: string
  gaps: number[]
}

/** Positions right after each token, and the start. */
function gaps(text: string, filePath: string): number[] {
  const { tokens = [] } = parse(text, { filePath, range: true, jsx: true, tokens: true })
  return [0, ...tokens.map((t) => t.range[1])]
}

/** Each top-level statement with all its gaps; each pair of neighbours with the gaps between them. */
function pieces(text: string, filePath: string): Piece[] {
  const body = parse(text, { filePath, range: true, jsx: true }).body
  const out: Piece[] = body.map((s) => {
    const stmt = text.slice(s.range[0], s.range[1])
    return { text: stmt, gaps: gaps(stmt, filePath) }
  })
  for (let i = 1; i < body.length; i++) {
    const [start, mid] = [body[i - 1].range[0], body[i].range[0]]
    const pair = text.slice(start, body[i].range[1])
    // Right after the first statement, and right before the second (on its line).
    out.push({ text: pair, gaps: [body[i - 1].range[1] - start, mid - start] })
  }
  return out
}

/** null if both properties hold (or `src` doesn't parse), else what went wrong. */
function check(src: string, filename: string): string | null {
  let ast
  try {
    ast = read(src, { filename })
  } catch (err) {
    if (err instanceof ReadError) return null
    throw err
  }
  try {
    const code = emit(ast)
    const again = read(code, { filename })
    assert.deepEqual(again, ast, 'read(emit(ast)) must equal ast')
    assert.equal(emit(again), code, 'emit must be a fixed point')
    return null
  } catch (err) {
    return (err as Error).message.split('\n')[0]
  }
}

describe('emit: a comment at every token gap', () => {
  for (const name of FIXTURES) {
    const filename = `fixtures/${name}`
    const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    const all = pieces(text, name)
    for (const [what, insert] of INSERTS) {
      test(`${name}: ${what}`, { timeout: 120_000 }, () => {
        const failures: string[] = []
        for (const piece of all) {
          for (const at of piece.gaps) {
            const src = piece.text.slice(0, at) + insert + piece.text.slice(at)
            const failure = check(src, filename)
            // The text around the gap, enough to find it.
            const near = JSON.stringify(piece.text.slice(Math.max(0, at - 40), at) + insert + piece.text.slice(at, at + 30))
            if (failure) failures.push(`${near}\n    ${failure}`)
          }
        }
        assert.equal(failures.length, 0, `${failures.length} failures:\n  ${failures.join('\n  ')}`)
      })
    }
  }
})

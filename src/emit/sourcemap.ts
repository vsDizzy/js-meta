// Source Map v3 from rendered marks. One segment where a node starts (and where
// its parent's text resumes after it), pointing at the node's origin. A node with
// no origin (built by hand or by a macro) maps to its nearest ancestor that has
// one, like the call site of a macro. Identifiers carry their source name.
import { originOf, type SourceFile } from '../ast/origin.ts'

export interface SourceMap {
  version: 3
  sources: string[]
  sourcesContent: string[]
  names: string[]
  mappings: string
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function vlq(n: number): string {
  let v = n < 0 ? (-n << 1) | 1 : n << 1
  let s = ''
  do {
    let digit = v & 31
    v >>>= 5
    if (v) digit |= 32
    s += B64[digit]
  } while (v)
  return s
}

const lineStarts = new WeakMap<SourceFile, number[]>()

/** 0-based line and column of `offset` in `file`. */
function locate(file: SourceFile, offset: number): [number, number] {
  let starts = lineStarts.get(file)
  if (!starts) {
    starts = [0]
    for (let i = file.text.indexOf('\n'); i >= 0; i = file.text.indexOf('\n', i + 1)) starts.push(i + 1)
    lineStarts.set(file, starts)
  }
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return [lo, offset - starts[lo]]
}

const NAMED = new Set(['Identifier', 'PrivateIdentifier', 'JSXIdentifier'])
const NAME = /^#?[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/u

export class MapBuilder {
  private sources = new Map<SourceFile, number>()
  private names = new Map<string, number>()
  /** Per generated line: [genCol, src, srcLine, srcCol, name?] */
  private lines: number[][][] = []

  /** A Sink for render(). */
  sink = (marks: readonly object[], line: number, column: number, opened: boolean) => {
    for (let i = marks.length - 1; i >= 0; i--) {
      const origin = originOf(marks[i])
      if (!origin) continue
      const node = marks[i] as { type?: string }
      // The source text at the start is the name as written, even after a rename.
      const name = opened && i === marks.length - 1 && NAMED.has(node.type!)
        ? origin.file.text.slice(origin.start).match(NAME)?.[0]
        : undefined
      this.add(line, column, origin.file, origin.start, name)
      return
    }
  }

  private add(line: number, column: number, file: SourceFile, offset: number, name?: string) {
    let src = this.sources.get(file)
    if (src === undefined) this.sources.set(file, (src = this.sources.size))
    const [srcLine, srcCol] = locate(file, offset)
    const segs = (this.lines[line] ??= [])
    const seg = [column, src, srcLine, srcCol]
    if (name !== undefined) {
      let n = this.names.get(name)
      if (n === undefined) this.names.set(name, (n = this.names.size))
      seg.push(n)
    }
    const last = segs.at(-1)
    if (last && last[0] === column) segs[segs.length - 1] = seg // the innermost node wins
    else if (!last || last[1] !== src || last[2] !== srcLine || last[3] !== srcCol || seg.length > 4) segs.push(seg)
  }

  toJSON(): SourceMap {
    const prev = [0, 0, 0, 0] // src, srcLine, srcCol, name: relative across lines
    const mappings = Array.from(this.lines, (segs = []) => {
      let col = 0
      return segs
        .map((s) => {
          let out = vlq(s[0] - col) + vlq(s[1] - prev[0]) + vlq(s[2] - prev[1]) + vlq(s[3] - prev[2])
          col = s[0]
          ;[prev[0], prev[1], prev[2]] = [s[1], s[2], s[3]]
          if (s.length > 4) {
            out += vlq(s[4] - prev[3])
            prev[3] = s[4]
          }
          return out
        })
        .join(',')
    }).join(';')
    const files = [...this.sources.keys()]
    return {
      version: 3,
      sources: files.map((f) => f.url),
      sourcesContent: files.map((f) => f.text),
      names: [...this.names.keys()],
      mappings,
    }
  }
}

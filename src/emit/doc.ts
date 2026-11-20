// Doc IR: what printers return. Plain data, rendered to text in one place:
//   string          text (may contain "\n": copied verbatim, no indentation)
//   Doc[]           concatenation
//   hardline        line break; the next line gets the current indentation
//   indent(doc)     one level deeper for the line breaks inside
//   mark(node, doc) `doc` is the text of `node` (for source maps)
//   aside(doc)      rendered as usual, but not code: `head`/`text` skip it
//                   (leading comments, so `/* c */ {}` still starts with `{`)
// Indentation is written lazily, so blank lines carry no trailing spaces.
// No wrapping yet: `group`/`line` (Wadler) can be added without touching printers.

export type Doc = string | readonly Doc[] | Hardline | Indent | Mark | Aside
interface Hardline {
  readonly kind: 'hardline'
}
interface Indent {
  readonly kind: 'indent'
  readonly doc: Doc
}
interface Mark {
  readonly kind: 'mark'
  readonly node: object
  readonly doc: Doc
}
interface Aside {
  readonly kind: 'aside'
  readonly doc: Doc
}

export const hardline: Hardline = { kind: 'hardline' }
export const indent = (doc: Doc): Indent => ({ kind: 'indent', doc })
export const mark = (node: object, doc: Doc): Mark => ({ kind: 'mark', node, doc })
export const aside = (doc: Doc): Aside => ({ kind: 'aside', doc })

/** `docs` with `sep` between them. */
export function join(sep: Doc, docs: readonly Doc[]): Doc[] {
  const out: Doc[] = []
  docs.forEach((d, i) => {
    if (i) out.push(sep)
    out.push(d)
  })
  return out
}

/**
 * Called before text is written where the set of open marks changed: `opened`
 * is true when a mark starts here, false when text resumes after a mark closed.
 */
export type Sink = (marks: readonly object[], line: number, column: number, opened: boolean) => void

const STEP = '  '

/** Renders `doc` to text; `sink` hears about marks with 0-based line and column. */
export function render(doc: Doc, sink?: Sink): string {
  const out: string[] = []
  const marks: object[] = []
  let line = 0
  let column = 0
  let depth = 0
  let atLineStart = false
  /** null: nothing to report; else whether a mark opened since the last report. */
  let pending: boolean | null = null

  const write = (s: string) => {
    if (!s) return
    if (atLineStart) {
      const pad = STEP.repeat(depth)
      out.push(pad)
      column += pad.length
      atLineStart = false
    }
    if (pending !== null && sink) sink(marks, line, column, pending)
    pending = null
    out.push(s)
    const nl = s.lastIndexOf('\n')
    if (nl < 0) column += s.length
    else {
      for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) line++
      column = s.length - nl - 1
    }
  }

  const go = (d: Doc): void => {
    if (typeof d === 'string') return write(d)
    if (Array.isArray(d)) {
      for (const x of d as readonly Doc[]) go(x)
      return
    }
    const node = d as Hardline | Indent | Mark | Aside
    switch (node.kind) {
      case 'hardline':
        out.push('\n')
        line++
        column = 0
        atLineStart = true
        return
      case 'indent':
        depth++
        go(node.doc)
        depth--
        return
      case 'aside':
        return go(node.doc)
      case 'mark': {
        const before = pending
        const written = out.length
        marks.push(node.node)
        pending = true
        go(node.doc)
        marks.pop()
        // Empty mark: as if it wasn't there. Otherwise the parent resumes.
        pending = out.length === written ? before : false
        return
      }
    }
  }

  go(doc)
  return out.join('')
}

/** The first `n` characters of the text of `doc` (a line break counts as "\n"), asides left out. */
export function head(doc: Doc, n: number): string {
  let s = ''
  const go = (d: Doc): boolean => {
    if (typeof d === 'string') s += d
    else if (Array.isArray(d)) {
      for (const x of d as readonly Doc[]) if (go(x)) return true
    } else {
      const node = d as Hardline | Indent | Mark | Aside
      if (node.kind === 'hardline') s += '\n'
      else if (node.kind !== 'aside' && go(node.doc)) return true
    }
    return s.length >= n
  }
  go(doc)
  return s.slice(0, n)
}

/** All the text of `doc` on one level (for short docs: names, numbers), asides left out. */
export const text = (doc: Doc) => head(doc, Infinity)

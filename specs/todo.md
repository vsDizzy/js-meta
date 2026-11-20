# Todo

Future work, not scheduled. Each item says what is wanted and, where known, how it could be built.

## Comments are code for macros too

**Want:** nothing that works on code skips comments. For a homoiconic macro a comment is the same kind of data as any other node: it can be found, matched, rewritten, generated and removed.

**Where it stands (2026-11-20):**
- Comments in lists are `Comment` nodes and `walk` visits them.
- Comments in non-list positions, block and line, are leading comments of the node after them (its `comments` attribute). `walk` visits those too, and a replacement inherits them.
- `match` and `rule` see comments when the pattern asks for them, `$$a` runs carry their comments, and templates can generate comments.
- A JSDoc cast `/** @type {T} */ (x)` keeps its parentheses.
- Live redefinition ignores comments when it compares forms.

**Still skipped:**
1. **A rule cannot remove or move a comment that is a list sibling before its node.** `walk` replaces only the node, so `/** doc */` before a function stays where it is. A replacement that puts such a comment back in front of its root is not doubled, but one that puts it anywhere else makes a copy. Fix: let a `walk` handler replace the comments before a node (or return a run of list elements for a run).
2. **A template rule that only adds a comment never settles.** `h($$a)` → `/* @__PURE__ */ h($$a)` matches its own output, because a pattern without comments ignores them. Today: a function replacement that passes when the comment is there. Fix: a way to say "no comment here" in a pattern (a predicate, once patterns have them).
3. **Comment matching does not backtrack across nodes.** A repeated comment variable (`/* $c */ … /* $c */`) takes the earliest fit in each place.
4. **A statement with a line comment in its `comments` attribute** (a `js.stmt` root printed on its own) prints as `// note`, then the statement indented as a continuation. Leading comments of a statement could print on their own lines.

## Known gaps in comment round trips

- `class A { @dec /* c */ m() {} }`: a comment after a decorator prints in front of `@`, where it reads back as a class-body comment.
- A JSDoc cast with a line break before the parenthesis (`/** @type {T} */`, new line, `(x).foo()`) is read as a list comment and loses its parentheses. See the decision log for why the cast rule needs the same line.

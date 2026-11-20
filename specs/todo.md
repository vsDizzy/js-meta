# Todo

Future work, not scheduled. Each item says what is wanted and, where known, how it could be built.

## Comments are code for macros too

**Want:** nothing that works on code skips comments. For a homoiconic macro a comment is the same kind of data as any other node: it can be found, matched, rewritten, generated and removed.

**Where it stands (2026-11-20):**
- Comments in lists are `Comment` nodes and `walk` visits them.
- Block comments in non-list positions are leading comments of the node after them (its `comments` attribute). `walk` visits those too (`ctx.key === 'comments'`, `ctx.parent` is the owner), and a replacement inherits them.
- Live redefinition ignores comments when it compares forms.

**Still skipped:**
1. **`match` and `rule` ignore comments.** A pattern cannot say "a call with a `/* @__PURE__ */` in front" or "a function with a JSDoc before it".
2. **Line comments in non-list positions are still hoisted** (`a + // why` then `b` on the next line).
3. **Parentheses are not kept**, so a JSDoc cast `/** @type {T} */ (x)` loses the parentheses that make it a cast.

**How it could be built:**
1. Patterns: keep "comments are ignored" as the default and add an explicit way to ask for them. Options: a comment in the pattern text becomes a requirement (`` js`/* $c */ $call` `` captures the comment node as `c`), or a predicate once patterns have predicates. For a JSDoc before a list element, a pattern over the list (`$$before`, comment, element) already fits the `$$` machinery.
2. Line comments in place: the printer needs a "must break the line after this" Doc, and has to refuse or re-place them after `return`, `throw`, `break`, `continue`, `yield` and before a postfix operator, where a newline changes the meaning.
3. Parentheses: a `parenthesized` attribute would make `a+b` and `(a+b)` different trees. Cheaper: keep them only when a leading comment starts with `* @type` or `* @satisfies`, decided at print time from the AST.

## Known gaps in comment round trips

Found on 2026-11-20, older than leading comments:
- `(/* c */ a), b`: the comment goes into the sequence's list and prints at the start of the statement; neither round-trip property holds.
- `import x, /* c */ * as ns from 'x'`: the ImportDeclaration printer drops a comment between the default and namespace specifiers.

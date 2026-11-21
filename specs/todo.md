# Todo

Future work, not scheduled. Each item says what is wanted and, where known, how it could be built.

## TypeScript modules in the loader (next, high priority)

**Want:** a `.ts` module is a source record like a `.js` one. Decided on 2026-11-21 (see the decision log): TS is erasable syntax; erasure is a sync pass on the AST in the lowering step; ts-code gives a `fetch()` the raw file; libraries stay native.

**To build:**
1. ts-code: transpile only module requests (`request.destination === 'script'` in `match` of `runtime/typescript.js`); a `fetch()` gets the file as it is. Check first that nothing in ts-code (export, hot update) relies on `fetch('.ts')` returning JS, and what destination worker requests have.
2. The erasure pass in `src/loader/`, between macros and `lower`. Start from the rules in `src/match/acceptance.test.ts`; also cover `declare`, overload signatures, `abstract` members, `implements`, `import type` / `type` specifiers, index signatures, `this` parameters, definite `!` on declarations. `enum`, `namespace` with values and parameter properties throw with a clear message. Measure it on a large module: a plain visitor may be needed instead of template rules.
3. `isSource` default: same origin, `.js` / `.mjs` / `.ts`, not under `/node_modules/`.
4. `redefine` and `eval` take TS text for a `.ts` record.

**After it: `.jsx` and `.tsx`.** They need a second pass, JSX lowering, also sync on the AST and before `lower`, because it adds an import (`jsx` / `jsxs` from `react/jsx-runtime`, the source configurable). `.tsx` is then erasure plus this pass. Until it exists `.jsx` / `.tsx` stay native (ts-code transpiles them on import). Fiddly parts: `jsx` or `jsxs` by the number of children, `key` taken out of the props, a spread before `key` falling back to `createElement`. Open: a redefined component does not re-render by itself; that needs something like React Refresh.

**Later:** the async text stage as one hook before `read`, `load(url)` resolving to `{ source, map? }` (today only `RuntimeOptions.fetch`). TS-to-JS with TypeScript, JSON, CSS or a worker call would plug in there.

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

## Rules: what the acceptance tests found awkward

Found on 2026-11-20 while writing `src/match/acceptance.test.ts`.

1. **A rule cannot turn one node into several.** A handler returns one node or null, so "one statement becomes two" (Lua `local function`) has to match the enclosing list with runs before and after, name every kind that has a statement list, and fires once per occurrence (over 100 in one list hits the repeat limit). Fix: let a `walk` handler return an array to splice into the list. The same change lets a rule replace the comments before its node (see the comments section above).
2. **Expanding a node's own children.** `ctx.expand(node)` on the rule's own node re-enters the rule; the optional-chaining rules guard with `env`. Fix: `ctx.expandChildren()`.
3. **"Optional or not" in the sugar.** `?.` is an attribute, so `a.b`, `a[k]` and `a?.b` each need a rule (most of the 11 rules for optional chaining). The core can say it with `p.node`; the sugar has no syntax for an attribute that may vary.
4. **No "stop here" result.** Lisp `quote` is a rule that never fires and calls `ctx.skip()`.
5. **`read` with a `.js` filename accepts TS syntax**, so re-reading as `.js` does not prove the output is plain JS.
6. **Speed.** A rule whose key is only a kind (`$o.name`, operators) is tried at every node of that kind, and a failed try costs about 350-400 ns. A cheap root check before `matchPattern`, and a finer key for member patterns, would cut it.

## Pattern core: left out

- Expanding a child inside the pattern itself (nanopass's `,[e]`); today it is `ctx.expand` in a guard or a replacement function.
- `substitute` on top of `build`.
- Wrapper forms for `interface { $$m }`, `enum { $$m }`, `import { $$s }`, `<$T $$attrs />`, `const $$d`.
- `p.or` and `p.not` in a list work per element: an alternative cannot be a group or a run.
- `ctx.scope` is a snapshot: a name bound by a template is unknown to it (waits on hygiene).
- Icebox (see the decision of 2026-11-21): readers and printers for cljs, Lisp and Lua. Not planned.
- A `pat/` node put into a `js` template through `${}` works only where an expression goes; as a statement it gets wrapped, as a property, class member or JSX child it throws. `coerce` could pass `pat/` nodes through in every role.
- A function replacement that returns `null` passes instead of removing the node (`replace(...) ?? undefined` in `rule`); only a `null` replacement removes. Older than the two-layer work.

## Types from JSDoc

**Want:** a rule can ask for the type of a variable in plain JS, where the type is written in a JSDoc comment. Deferred until a macro needs it (architect's verdict, 2026-11-21).

**Where it stands:** the link is by position and by name only.
- A declaration's JSDoc is a `Comment` sibling before the statement, not on the name: for `/** @type {T} */ export const a = 1` it stands before the `ExportNamedDeclaration`. For a parameter, a class field and an object property it is the sibling right before that element.
- `@param {T} x` in a function's JSDoc is tied to the parameter by name only.
- `scope()` skips type positions, TS annotations included, and a `Binding` has no type.
- `$x: $T` in a pattern checks the `typeAnnotation` slot, so it does not match a JSDoc-typed declaration. It stays that way: a replacement with the same text would print a TS annotation into a `.js` file.

**How:** an analysis beside `scope()`, nothing new in the tree or in the matcher.
1. Parse a comment into tags, each with a type node; lazy, cached by the comment node. `read` of `type _ = T` already gives the nodes annotations use (`Map<string, number>`, `{a: number}[]`, `import('./x.js').Foo`). JSDoc-only forms fail there and need their own handling: `?string`, `string=`, `...number`, `function(string): number`.
2. `typeOf` on the result of `scope()`: for a binding, the type node from its TS annotation, else from JSDoc by the placements above.
3. In rules: `ctx.typeOf(m.x)` in a replacement function or a `p.guard`.

**Check first:** whether typescript-estree can hand over the JSDoc that TypeScript parses itself; then step 1 is not ours to write.

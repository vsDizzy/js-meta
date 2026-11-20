// The core of pattern matching, for any node family: patterns are trees with
// `pat/` nodes (pat.ts), `matchPattern` finds captures, `build` puts them back.
// The `js` sugar (quote/) compiles its `$a` forms into these patterns.
export { p, type RepOptions, type Test } from './pat.ts'
export { matchPattern, commentsBefore, type Captures, type MatchContext } from './match.ts'
export { build } from './build.ts'

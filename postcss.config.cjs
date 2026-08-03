// v2.0.845: Empty PostCSS config.
//
// MATS is a pure TypeScript backend — no CSS processing is needed. But Vite
// (which vitest wraps) always resolves a PostCSS config at startup. Without a
// config in this directory, Vite walks UP the tree looking for one, and the
// sandbox blocks reading the parent package.json at /Users/y.c./package.json
// (EPERM: operation not permitted). Providing an empty config here stops the
// upward search at the project root.
module.exports = {};

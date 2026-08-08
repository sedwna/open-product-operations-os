/**
 * Rules are listed explicitly rather than extended from a shared preset.
 *
 * A preset is a moving target: it changes what this repository considers a defect whenever it is
 * upgraded, which is the opposite of how every other contract here works. Listing them means a rule
 * arrives by decision, and the diff says which.
 *
 * The selection is deliberately about correctness rather than taste. Formatting is not enforced —
 * there is no formatter here and adding one would rewrite the whole tree for no defect caught.
 */

const NODE_GLOBALS = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  queueMicrotask: "readonly",
  structuredClone: "readonly",
  fetch: "readonly",
  crypto: "readonly",
  performance: "readonly",
  globalThis: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  module: "readonly",
  require: "readonly",
  exports: "writable"
};

export default [
  {
    ignores: ["node_modules/**", "site/**", "**/*.min.js", "examples/**"]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: NODE_GLOBALS
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: {
      // Defects, not preferences.
      "no-undef": "error",
      // ignoreRestSiblings: `({ template, ...sheet }) => sheet` names a property in order to leave it
      // behind. The binding is unused on purpose — that is the whole expression.
      "no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }
      ],
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-dupe-else-if": "error",
      "no-duplicate-case": "error",
      "no-duplicate-imports": "error",
      "no-fallthrough": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-constant-binary-expression": "error",
      "no-compare-neg-zero": "error",
      "no-sparse-arrays": "error",
      "no-unsafe-negation": "error",
      "no-unsafe-optional-chaining": "error",
      "use-isnan": "error",
      "valid-typeof": "error",

      // Async correctness. The lease defect this repository just fixed lived in exactly this space.
      "require-atomic-updates": "error",
      "no-async-promise-executor": "error",
      "no-await-in-loop": "off", // Sequential awaits are frequently the point here, not a mistake.
      "no-promise-executor-return": "error",
      "no-return-assign": "error",

      // Shadowing and redeclaration hide which binding a line actually reads.
      "no-shadow-restricted-names": "error",
      "no-redeclare": "error",
      "no-class-assign": "error",
      "no-func-assign": "error",
      "no-import-assign": "error",

      // Language-level guards.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-with": "error",
      "no-var": "error",
      // ignoreReadBeforeAssign: a timer declared up front so the handlers defined above it can clear
      // it, then assigned once below, is assigned exactly once but cannot become a const without
      // reordering the closures that read it.
      "prefer-const": ["error", { destructuring: "all", ignoreReadBeforeAssign: true }],
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-throw-literal": "error"
    }
  },
  {
    // Test files reach for globals the runtime never does.
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: { ...NODE_GLOBALS, test: "readonly", describe: "readonly", it: "readonly", before: "readonly", after: "readonly" }
    }
  }
];

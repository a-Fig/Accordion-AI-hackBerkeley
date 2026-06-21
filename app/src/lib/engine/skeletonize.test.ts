import { describe, it, expect } from "vitest";
import { skeletonize, detectLang } from "$conductors/code-skeleton/skeletonize";
import type { Lang } from "$conductors/code-skeleton/skeletonize";

// ----------------------------------------------------------------------------------------
// detectLang — extension table + content sniffing
// ----------------------------------------------------------------------------------------

describe("detectLang — by extension", () => {
  const cases: Array<[string, Lang]> = [
    ["src/foo.ts", "ts"],
    ["src/Foo.TSX", "ts"],
    ["a.mts", "ts"],
    ["a.cts", "ts"],
    ["b.js", "js"],
    ["b.jsx", "js"],
    ["b.mjs", "js"],
    ["b.cjs", "js"],
    ["App.svelte", "svelte"],
    ["script.py", "python"],
    ["stub.pyi", "python"],
    ["main.rs", "rust"],
    ["server.go", "go"],
    ["Main.java", "java"],
    ["Main.KT", "java"],
    ["build.kts", "java"],
    ["lib.c", "c"],
    ["lib.h", "c"],
    ["lib.cpp", "c"],
    ["lib.cc", "c"],
    ["lib.hpp", "c"],
    ["lib.cxx", "c"],
    ["styles.css", "css"],
    ["styles.scss", "css"],
    ["styles.less", "css"],
    ["package.json", "json"],
  ];
  for (const [path, lang] of cases) {
    it(`${path} → ${lang}`, () => {
      expect(detectLang(path, "")).toBe(lang);
    });
  }

  it("case-insensitive on the extension", () => {
    expect(detectLang("FOO.TS", "")).toBe("ts");
    expect(detectLang("FOO.Py", "")).toBe("python");
  });

  it("ignores dots in directory names", () => {
    expect(detectLang("my.dir/file.go", "")).toBe("go");
  });

  it("unknown extension falls through to a content sniff", () => {
    expect(detectLang("notes.txt", "const x = 1;\nfunction y() {}")).toBe("ts");
  });
});

describe("detectLang — content sniff (no/unknown path)", () => {
  it("python shebang", () => {
    expect(detectLang(undefined, "#!/usr/bin/env python3\nprint('hi')\n")).toBe("python");
  });
  it("python def + colon", () => {
    expect(detectLang(undefined, "def add(a, b):\n    return a + b\n")).toBe("python");
  });
  it("python class + colon", () => {
    expect(detectLang(undefined, "class Foo:\n    pass\n")).toBe("python");
  });
  it("ts/js shapes", () => {
    expect(detectLang(undefined, "import { x } from './x'\nexport const y = () => 1\n")).toBe("ts");
  });
  it("rust fn + let mut", () => {
    expect(detectLang(undefined, "fn main() {\n    let mut n = 0;\n    n += 1;\n}\n")).toBe("rust");
  });
  it("go package + func", () => {
    expect(detectLang(undefined, "package main\n\nfunc main() {\n}\n")).toBe("go");
  });
  it("truly unknown → generic", () => {
    expect(detectLang(undefined, "lorem ipsum dolor sit amet\nconsectetur\n")).toBe("generic");
  });
  it("never throws on empty / weird input", () => {
    expect(detectLang(undefined, "")).toBe("generic");
    expect(detectLang("", "")).toBe("generic");
    // @ts-expect-error exercising the undefined path defensively
    expect(detectLang(undefined, undefined)).toBe("generic");
  });
});

// ----------------------------------------------------------------------------------------
// Shared assertion helpers
// ----------------------------------------------------------------------------------------

function assertSmaller(src: string, lang: Lang) {
  const r = skeletonize(src, lang);
  expect(r.skeleton.length).toBeLessThan(src.length);
  expect(r.elidedLines).toBeGreaterThan(0);
  expect(r.totalLines).toBe(src.split("\n").length);
  return r;
}

function assertDeterministic(src: string, lang: Lang) {
  const a = skeletonize(src, lang);
  const b = skeletonize(src, lang);
  expect(a.skeleton).toBe(b.skeleton);
  expect(a).toEqual(b);
}

// ----------------------------------------------------------------------------------------
// TypeScript
// ----------------------------------------------------------------------------------------

const TS_SAMPLE = `import { readFile } from "node:fs/promises";
import type { Config } from "./config";

export const VERSION = "1.2.3";

/** A widget the loader builds. */
export interface Widget {
  id: string;
  label: string;
  render(): string;
}

export type Mode = "fast" | "slow";

@sealed
export class Loader extends Base implements Runnable {
  private cache: Map<string, Widget> = new Map();

  constructor(private cfg: Config) {
    super();
    const seedLocal = cfg.seed ?? 0;
    this.cache.set("seed", makeWidget(seedLocal));
  }

  async load(path: string): Promise<Widget> {
    const rawText = await readFile(path, "utf8");
    const parsedThing = JSON.parse(rawText);
    return makeWidget(parsedThing.id);
  }

  get size(): number {
    return this.cache.size;
  }
}

export function makeWidget(id: string): Widget {
  const builtWidget = { id, label: id.toUpperCase(), render: () => id };
  return builtWidget;
}
`;

describe("skeletonize ts", () => {
  const r = skeletonize(TS_SAMPLE, "ts");

  it("preserves contract: imports, exports, type/interface/class/function names", () => {
    for (const tok of [
      "import",
      'from "node:fs/promises"',
      "import type { Config }",
      "export const VERSION",
      "interface Widget",
      "render(): string",
      "export type Mode",
      "class Loader extends Base implements Runnable",
      "constructor",
      "async load",
      "get size",
      "export function makeWidget",
      "@sealed",
    ]) {
      expect(r.skeleton).toContain(tok);
    }
  });

  it("keeps the leading JSDoc comment on the interface", () => {
    expect(r.skeleton).toContain("A widget the loader builds.");
  });

  it("elides function/method BODY locals", () => {
    for (const local of ["seedLocal", "rawText", "parsedThing", "builtWidget", "JSON.parse"]) {
      expect(r.skeleton).not.toContain(local);
    }
  });

  it("smaller + elides + accurate totalLines", () => {
    assertSmaller(TS_SAMPLE, "ts");
  });

  it("deterministic", () => {
    assertDeterministic(TS_SAMPLE, "ts");
  });

  it("inline snapshot locks the exact formatting", () => {
    expect(r.skeleton).toMatchInlineSnapshot(`
      "import { readFile } from "node:fs/promises";
      import type { Config } from "./config";

      export const VERSION = "1.2.3";

      /** A widget the loader builds. */
      export interface Widget {
        id: string;
        label: string;
        render(): string;
      }

      export type Mode = "fast" | "slow";

      @sealed
      export class Loader extends Base implements Runnable {
        private cache: Map<string, Widget> = new Map();

        constructor(private cfg: Config) { /* … 3 lines */ }

        async load(path: string): Promise<Widget> { /* … 3 lines */ }

        get size(): number { /* … 1 line */ }
      }

      export function makeWidget(id: string): Widget { /* … 2 lines */ }
      "
    `);
  });
});

// ----------------------------------------------------------------------------------------
// Python
// ----------------------------------------------------------------------------------------

const PY_SAMPLE = `#!/usr/bin/env python3
"""Module docstring describing the file."""
import os
from typing import Optional

API_ROOT = "https://example.test"


def fetch(url: str, retries: int = 3) -> Optional[str]:
    """Fetch a URL with retries."""
    attemptCounter = 0
    while attemptCounter < retries:
        attemptCounter += 1
    return None


class Client:
    """A small HTTP client."""

    def __init__(self, token: str) -> None:
        self.token = token
        secretHeader = {"Authorization": token}
        self._headers = secretHeader

    async def get(
        self,
        path: str,
    ) -> dict:
        composedUrl = API_ROOT + path
        return {"url": composedUrl}


if __name__ == "__main__":
    fetch(API_ROOT)
`;

describe("skeletonize python", () => {
  const r = skeletonize(PY_SAMPLE, "python");

  it("preserves contract: imports, constants, class + def signatures, docstrings", () => {
    for (const tok of [
      "import os",
      "from typing import Optional",
      "API_ROOT =",
      "Module docstring describing the file.",
      "def fetch(url: str, retries: int = 3) -> Optional[str]:",
      "Fetch a URL with retries.",
      "class Client:",
      "A small HTTP client.",
      "def __init__(self, token: str) -> None:",
      "async def get(",
      'if __name__ == "__main__":',
    ]) {
      expect(r.skeleton).toContain(tok);
    }
  });

  it("elides def body locals", () => {
    for (const local of ["attemptCounter", "secretHeader", "composedUrl"]) {
      expect(r.skeleton).not.toContain(local);
    }
  });

  it("uses a python `...` stub for elided bodies", () => {
    expect(r.skeleton).toContain("...");
  });

  it("MINOR B: a tab-indented body yields a tab-indented `...` stub (not 1 space)", () => {
    // Body lines are indented with a real TAB. indentOf counts a tab as width 1, so rebuilding
    // the stub indent from a width with spaces gave a 1-space stub. The stub must reuse the
    // body's actual leading-whitespace string.
    const PY_TAB = "def f(x):\n\tlocalThing = x + 1\n\treturn localThing\n";
    const rt = skeletonize(PY_TAB, "python");
    const stub = rt.skeleton.split("\n").find((l) => l.includes("..."));
    expect(stub).toBeDefined();
    expect(stub!.startsWith("\t")).toBe(true);
  });

  it("smaller + elides", () => {
    assertSmaller(PY_SAMPLE, "python");
  });

  it("deterministic", () => {
    assertDeterministic(PY_SAMPLE, "python");
  });

  it("inline snapshot", () => {
    expect(r.skeleton).toMatchInlineSnapshot(`
      "#!/usr/bin/env python3
      """Module docstring describing the file."""
      import os
      from typing import Optional

      API_ROOT = "https://example.test"


      def fetch(url: str, retries: int = 3) -> Optional[str]:
          """Fetch a URL with retries."""
          ...  # … 4 lines
      class Client:
          """A small HTTP client."""

          def __init__(self, token: str) -> None:
              ...  # … 3 lines
          async def get(
              self,
              path: str,
          ) -> dict:
              ...  # … 2 lines
      if __name__ == "__main__":
          fetch(API_ROOT)
      "
    `);
  });
});

// ----------------------------------------------------------------------------------------
// Svelte
// ----------------------------------------------------------------------------------------

const SVELTE_SAMPLE = `<script lang="ts">
  import { onMount } from "svelte";
  export let title: string;

  let internalCount = 0;

  function bump() {
    internalCount += 1;
    console.log(internalCount);
  }

  onMount(() => {
    bump();
  });
</script>

<main class="wrap">
  <h1>{title}</h1>
  <button on:click={bump}>Inc</button>
  <p>count is shown elsewhere</p>
</main>

<style>
  .wrap {
    padding: 1rem;
    color: red;
  }
  h1 {
    font-size: 2rem;
  }
</style>
`;

describe("skeletonize svelte", () => {
  const r = skeletonize(SVELTE_SAMPLE, "svelte");

  it("keeps script tags + script contract", () => {
    for (const tok of [
      "<script",
      "</script>",
      'import { onMount }',
      "export let title",
      "function bump",
    ]) {
      expect(r.skeleton).toContain(tok);
    }
  });

  it("elides script body locals + template + style bodies", () => {
    expect(r.skeleton).not.toContain("internalCount += 1");
    expect(r.skeleton).not.toContain("padding: 1rem");
    expect(r.skeleton).not.toContain("<h1>{title}</h1>");
  });

  it("collapses template + style to markers", () => {
    expect(r.skeleton).toMatch(/<!-- template/);
    expect(r.skeleton).toMatch(/<style[^>]*>\/\*/);
  });

  it("smaller + elides", () => {
    assertSmaller(SVELTE_SAMPLE, "svelte");
  });

  it("deterministic", () => {
    assertDeterministic(SVELTE_SAMPLE, "svelte");
  });

  it("inline snapshot", () => {
    expect(r.skeleton).toMatchInlineSnapshot(`
      "<script lang="ts">
        import { onMount } from "svelte";
        export let title: string;

        let internalCount = 0;

        function bump() { /* … 2 lines */ }

        onMount(() => { /* … 1 line */ });
      </script>
      <!-- template · 5 lines · 8 elements -->
      <style>/* … 7 lines */</style>"
    `);
  });

  it("MINOR A: keptLines never exceeds totalLines and stays non-negative", () => {
    // Two <script> blocks: the old summing (open tag + sub.keptLines + close tag) over-counts
    // boundary lines, producing keptLines > totalLines — nonsense in the `${totalLines}L →
    // ${keptLines}L` header. Counts must be honest.
    const SVELTE_TWO_SCRIPTS = `<script context="module" lang="ts">
  export const meta = 1;
</script>
<script lang="ts">
  export let title: string;
  function go() {
    title = title + "!";
  }
</script>
<div>{title}</div>`;
    const r2 = skeletonize(SVELTE_TWO_SCRIPTS, "svelte");
    expect(r2.keptLines).toBeGreaterThanOrEqual(0);
    expect(r2.keptLines).toBeLessThanOrEqual(r2.totalLines);
  });
});

// ----------------------------------------------------------------------------------------
// CSS
// ----------------------------------------------------------------------------------------

const CSS_SAMPLE = `@import "reset.css";

.btn {
  color: red;
  padding: 4px 8px;
  border: 1px solid black;
}

.card .title {
  font-weight: 600;
  margin-bottom: 8px;
}

@media (max-width: 600px) {
  .btn {
    padding: 2px;
  }
}
`;

describe("skeletonize css", () => {
  const r = skeletonize(CSS_SAMPLE, "css");

  it("keeps @import + selectors / at-rule headers", () => {
    for (const tok of ['@import "reset.css";', ".btn", ".card .title", "@media (max-width: 600px)"]) {
      expect(r.skeleton).toContain(tok);
    }
  });

  it("collapses rule bodies (declarations elided)", () => {
    for (const decl of ["padding: 4px 8px", "font-weight: 600", "border: 1px solid black"]) {
      expect(r.skeleton).not.toContain(decl);
    }
    expect(r.skeleton).toContain("{ … }");
  });

  it("smaller + elides", () => {
    assertSmaller(CSS_SAMPLE, "css");
  });

  it("deterministic", () => {
    assertDeterministic(CSS_SAMPLE, "css");
  });

  it("inline snapshot", () => {
    expect(r.skeleton).toMatchInlineSnapshot(`
      "@import "reset.css";

      .btn { … }

      .card .title { … }

      @media (max-width: 600px) { … }
      "
    `);
  });
});

// ----------------------------------------------------------------------------------------
// Rust
// ----------------------------------------------------------------------------------------

const RUST_SAMPLE = `use std::collections::HashMap;

pub const LIMIT: usize = 10;

pub struct Cache {
    store: HashMap<String, u32>,
    capacity: usize,
}

impl Cache {
    pub fn new(capacity: usize) -> Self {
        let mut localStore = HashMap::new();
        localStore.insert(String::from("seed"), 0);
        Cache { store: localStore, capacity }
    }

    pub fn get(&self, key: &str) -> Option<u32> {
        let lookedUp = self.store.get(key);
        lookedUp.copied()
    }
}

pub fn helper(n: u32) -> u32 {
    let doubledValue = n * 2;
    doubledValue
}
`;

describe("skeletonize rust", () => {
  const r = skeletonize(RUST_SAMPLE, "rust");

  it("preserves contract: use, const, struct, impl, fn signatures", () => {
    for (const tok of [
      "use std::collections::HashMap;",
      "pub const LIMIT",
      "pub struct Cache",
      "impl Cache",
      "pub fn new(capacity: usize) -> Self",
      "pub fn get(&self, key: &str) -> Option<u32>",
      "pub fn helper(n: u32) -> u32",
    ]) {
      expect(r.skeleton).toContain(tok);
    }
  });

  it("keeps struct fields but elides fn bodies", () => {
    expect(r.skeleton).toContain("store: HashMap<String, u32>");
    for (const local of ["localStore", "lookedUp", "doubledValue"]) {
      expect(r.skeleton).not.toContain(local);
    }
  });

  it("smaller + elides", () => {
    assertSmaller(RUST_SAMPLE, "rust");
  });

  it("deterministic", () => {
    assertDeterministic(RUST_SAMPLE, "rust");
  });

  it("inline snapshot", () => {
    expect(r.skeleton).toMatchInlineSnapshot(`
      "use std::collections::HashMap;

      pub const LIMIT: usize = 10;

      pub struct Cache {
          store: HashMap<String, u32>,
          capacity: usize,
      }

      impl Cache {
          pub fn new(capacity: usize) -> Self { /* … 3 lines */ }

          pub fn get(&self, key: &str) -> Option<u32> { /* … 2 lines */ }
      }

      pub fn helper(n: u32) -> u32 { /* … 2 lines */ }
      "
    `);
  });
});

// ----------------------------------------------------------------------------------------
// Robustness — braces inside strings/comments must not corrupt structure
// ----------------------------------------------------------------------------------------

describe("brace-masking robustness", () => {
  const TRICKY = `import { x } from "./x";

const messyString = "}{ not a real brace }{";
// a comment with a stray } brace { in it

export function afterTheTrap(): number {
  const hiddenLocal = "still ignored";
  return 1;
}

export const KEEP_ME = 42;
`;

  it("keeps declarations after a string/comment containing braces", () => {
    const r = skeletonize(TRICKY, "ts");
    expect(r.skeleton).toContain("import { x }");
    expect(r.skeleton).toContain("const messyString");
    expect(r.skeleton).toContain("export function afterTheTrap(): number");
    expect(r.skeleton).toContain("export const KEEP_ME = 42;");
  });

  it("still elides the body of the function after the trap", () => {
    const r = skeletonize(TRICKY, "ts");
    expect(r.skeleton).not.toContain("hiddenLocal");
  });

  it("python: a brace inside a triple-quoted docstring doesn't break indentation logic", () => {
    const PY = `def f(x):
    """Docstring with { and } braces and a def keyword inside."""
    localOnly = x + 1
    return localOnly
`;
    const r = skeletonize(PY, "python");
    expect(r.skeleton).toContain("def f(x):");
    expect(r.skeleton).toContain("Docstring with { and } braces");
    expect(r.skeleton).not.toContain("localOnly");
  });
});

// ----------------------------------------------------------------------------------------
// Truncation / unbalanced source — a held signature must never die unemitted (BLOCKER 2)
// ----------------------------------------------------------------------------------------

describe("truncated / unbalanced brace source", () => {
  it("BLOCKER 2: a function whose body never closes still keeps the signature", () => {
    const TRUNC = `import { z } from "./z";
export const BEFORE = 1;
export function importantApi(a: number): string {
  const local = a;
  if (local) {
    return "x";`;
    const r = skeletonize(TRUNC, "ts");
    expect(r.skeleton).toContain("import { z }");
    expect(r.skeleton).toContain("BEFORE");
    expect(r.skeleton).toContain("importantApi");
  });
});

// ----------------------------------------------------------------------------------------
// Catastrophic-backtracking / very long line — must stay fast and keep the line (BLOCKER 3)
// ----------------------------------------------------------------------------------------

describe("very long line performance", () => {
  it("BLOCKER 3: a single very long line skeletonizes promptly without throwing or dropping it", () => {
    // A long UNQUOTED call-shaped expression with trailing junk and no semicolon is the
    // catastrophic-backtracking trigger for looksCallable's method-signature regex
    // (`/…\([^;]*\)…$/`). Pre-fix this is O(n²): ~8s for this size, hanging the conductor
    // pass. (A long *string literal* would be masked to spaces and fail fast — it does NOT
    // exercise the bug, so this must be real code, not a quoted blob.)
    //
    // The hang is SYNCHRONOUS, so a vitest test-timeout can't interrupt it (the regex
    // monopolizes the event loop). We measure wall-clock inside the test instead: post-fix
    // runs in <100ms; the 1s ceiling is far below the ~8s pre-fix cost. Not a generous
    // timeout — a tight one that only passes when the work is genuinely fast.
    const long = `render(` + "a".repeat(60000) + `)z`;
    const start = Date.now();
    const r = skeletonize(long, "ts");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    // The line is not a signature → kept verbatim by the default-keep path.
    expect(r.skeleton).toContain("a".repeat(60000));
  });
});

// ----------------------------------------------------------------------------------------
// Degenerate-result guard
// ----------------------------------------------------------------------------------------

describe("degenerate-result guard", () => {
  it("an all-signatures interface file (no bodies) returns sane counts and doesn't crash", () => {
    const ALL_SIGS = `export interface A {
  one(): void;
  two(): number;
  three(x: string): boolean;
}

export type B = string | number;

export declare function ext(a: number): void;
`;
    const r = skeletonize(ALL_SIGS, "ts");
    expect(r.totalLines).toBe(ALL_SIGS.split("\n").length);
    expect(r.keptLines).toBeGreaterThan(0);
    // Contract is fully preserved.
    for (const tok of ["interface A", "one(): void;", "type B =", "declare function ext"]) {
      expect(r.skeleton).toContain(tok);
    }
  });

  it("generic fallback never grows the input and keeps head + tail", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line number ${i} of plain prose text here`);
    const src = lines.join("\n");
    const r = skeletonize(src, "generic");
    expect(r.skeleton.length).toBeLessThan(src.length);
    expect(r.elidedLines).toBeGreaterThan(0);
    expect(r.skeleton).toContain("line number 0 of");
    expect(r.skeleton).toContain("line number 59 of");
    expect(r.skeleton).toContain("lines elided");
  });

  it("a brace file that's all top-level consts keeps EVERY declaration (no head/tail chop)", () => {
    // All top-level consts with no bodies → nothing to elide. For a KNOWN language the
    // degenerate guard must NOT downgrade to the generic head/tail fallback, because that
    // would silently drop the middle declarations. Every C0..C39 must survive.
    const r = skeletonize(
      Array.from({ length: 40 }, (_, i) => `export const C${i} = ${i};`).join("\n"),
      "ts",
    );
    expect(r.totalLines).toBe(40);
    for (let i = 0; i < 40; i++) {
      expect(r.skeleton).toContain(`export const C${i} = ${i};`);
    }
  });

  // BLOCKER 1 regressions: a known-language all-contract file must NEVER be downgraded to the
  // generic head/tail fallback, which chops the middle (fixed head=24/tail=8) and silently
  // drops the middle declarations. For a known lang the structural skeleton is returned as-is.

  it("BLOCKER 1a: a 36-export barrel keeps EVERY re-export (no middle dropped)", () => {
    const src = Array.from(
      { length: 36 },
      (_, i) => `export { Thing${i} } from "./thing${i}";`,
    ).join("\n");
    const r = skeletonize(src, "ts");
    for (let i = 0; i < 36; i++) {
      expect(r.skeleton).toContain(`Thing${i}`);
    }
  });

  it("BLOCKER 1b: a .d.ts of 36 declare-functions keeps EVERY signature", () => {
    // detectLang resolves a .d.ts path to "ts".
    expect(detectLang("x.d.ts", "")).toBe("ts");
    const src = Array.from(
      { length: 36 },
      (_, i) => `export declare function api${i}(x: number): string;`,
    ).join("\n");
    const r = skeletonize(src, "ts");
    for (let i = 0; i < 36; i++) {
      expect(r.skeleton).toContain(`api${i}`);
    }
  });

  it("BLOCKER 1c: a 38-member interface keeps EVERY method signature", () => {
    const members = Array.from({ length: 38 }, (_, i) => `  m${i}(x: number): void;`).join("\n");
    const src = `interface Big {\n${members}\n}`;
    const r = skeletonize(src, "ts");
    for (let i = 0; i < 38; i++) {
      expect(r.skeleton).toContain(`m${i}(x: number): void;`);
    }
  });

  it("empty input is handled", () => {
    const r = skeletonize("", "ts");
    expect(r.totalLines).toBe(0);
    expect(r.skeleton).toBe("");
    expect(r.keptLines).toBe(0);
    expect(r.elidedLines).toBe(0);
  });
});

// ----------------------------------------------------------------------------------------
// Generic
// ----------------------------------------------------------------------------------------

describe("skeletonize generic", () => {
  const src = Array.from({ length: 50 }, (_, i) => `data row ${i}: some value or other content`).join("\n");
  const r = skeletonize(src, "generic");

  it("keeps head + tail, elides middle", () => {
    expect(r.skeleton).toContain("data row 0:");
    expect(r.skeleton).toContain("data row 49:");
    expect(r.skeleton).not.toContain("data row 30:");
  });

  it("smaller + elides + deterministic", () => {
    expect(r.skeleton.length).toBeLessThan(src.length);
    expect(r.elidedLines).toBeGreaterThan(0);
    assertDeterministic(src, "generic");
  });

  it("inline snapshot", () => {
    expect(r.skeleton).toMatchInlineSnapshot(`
      "data row 0: some value or other content
      data row 1: some value or other content
      data row 2: some value or other content
      data row 3: some value or other content
      data row 4: some value or other content
      data row 5: some value or other content
      data row 6: some value or other content
      data row 7: some value or other content
      data row 8: some value or other content
      data row 9: some value or other content
      data row 10: some value or other content
      data row 11: some value or other content
      data row 12: some value or other content
      data row 13: some value or other content
      data row 14: some value or other content
      data row 15: some value or other content
      data row 16: some value or other content
      data row 17: some value or other content
      data row 18: some value or other content
      data row 19: some value or other content
      data row 20: some value or other content
      data row 21: some value or other content
      data row 22: some value or other content
      data row 23: some value or other content
      … ⟨18 lines elided — unfold for full source⟩ …
      data row 42: some value or other content
      data row 43: some value or other content
      data row 44: some value or other content
      data row 45: some value or other content
      data row 46: some value or other content
      data row 47: some value or other content
      data row 48: some value or other content
      data row 49: some value or other content"
    `);
  });
});

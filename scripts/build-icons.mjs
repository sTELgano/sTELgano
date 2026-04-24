// SPDX-License-Identifier: AGPL-3.0-only
//
// Icon sprite assembler for sTELgano v2.
//
// Walks src/client/ for references to icons in three forms:
//   - HTML: href="/icons.svg#<name>"
//   - TS/JS: icon("<name>", ...)
//   - TS/JS: { icon: "<name>" }
//
// Looks up each name in lucide-static and emits public/icons.svg
// containing only the <symbol>s actually referenced. The sprite stays
// minimal — adding pages/components adds icons automatically.
//
// Naming convention: snake_case names (matching v1's HEEX
// `<.icon name="shield_check" />`). lucide-static ships the underlying
// SVGs with kebab-case filenames. The script normalises snake_case →
// kebab-case for the file lookup but keeps snake_case for the symbol id.
//
// Usage in HTML templates:
//   <svg class="size-4"><use href="/icons.svg#shield_check"/></svg>
// Usage in TypeScript:
//   icon("shield_check", "size-4")   →  same href rendered as a string

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIR = join(ROOT, "src/client");
const LUCIDE_DIR = join(ROOT, "node_modules/lucide-static/icons");
const OUT = join(ROOT, "public/icons.svg");

const SCAN_EXTS = new Set([".html", ".ts", ".js", ".mjs"]);

// Three patterns that identify icon references:
const PATTERNS = [
  /href=["']\/icons\.svg#([a-z][a-z0-9_-]*)["']/g, // HTML <use href="/icons.svg#name">
  /\bicon\(["']([a-z][a-z0-9_]+)["']/g, //           TS:  icon("name", ...)
  /\bicon:\s*["']([a-z][a-z0-9_]+)["']/g, //         TS:  { icon: "name" }
];

const SVG_INNER_RE = /<svg\b[^>]*>([\s\S]*?)<\/svg>/;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile() && SCAN_EXTS.has(extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

async function collectReferences() {
  const refs = new Set();
  const files = await walk(SCAN_DIR);
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
      while ((m = re.exec(content)) !== null) refs.add(m[1]);
    }
  }
  return Array.from(refs).sort();
}

async function buildSymbol(snakeName) {
  const kebab = snakeName.replaceAll("_", "-");
  const path = join(LUCIDE_DIR, `${kebab}.svg`);
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return { kind: "missing", name: snakeName };

  const m = raw.match(SVG_INNER_RE);
  if (!m) return { kind: "malformed", name: snakeName };

  const inner = m[1].trim();

  return {
    kind: "ok",
    name: snakeName,
    symbol: `<symbol id="${snakeName}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`,
  };
}

async function build() {
  const names = await collectReferences();
  if (names.length === 0) {
    await writeFile(
      OUT,
      `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" style="display:none"></svg>\n`,
      "utf8",
    );
    console.log("build-icons: 0 icons referenced — empty sprite written");
    return;
  }

  const results = await Promise.all(names.map(buildSymbol));
  const missing = results.filter((r) => r.kind !== "ok");
  if (missing.length > 0) {
    console.error(
      "build-icons: the following icons were referenced but not found in lucide-static:",
    );
    for (const m of missing) console.error(`  - ${m.name}`);
    console.error("(if these are renamed v1 hero-* icons, update the templates to lucide names)");
    process.exit(1);
  }

  const symbols = results.map((r) => r.symbol).join("\n  ");
  const sprite = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  ${symbols}
</svg>
`;

  await writeFile(OUT, sprite, "utf8");
  console.log(`build-icons: ${names.length} icons → public/icons.svg (${sprite.length} bytes)`);
}

build().catch((err) => {
  console.error("build-icons failed:", err);
  process.exit(1);
});

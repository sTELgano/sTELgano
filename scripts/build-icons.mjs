// SPDX-License-Identifier: AGPL-3.0-only
//
// Icon sprite assembler for sTELgano v2.
//
// Walks src/client/templates/ and src/client/pages/ for references of
// the form `href="/icons.svg#<name>"`, looks up each name in
// lucide-static, and emits public/icons.svg containing only the
// <symbol>s actually referenced. The sprite stays minimal — adding
// pages adds icons to the sprite automatically; deleting pages
// removes them on the next build.
//
// Naming convention: templates use snake_case names (matching v1's
// HEEX `<.icon name="shield_check" />`). lucide-static ships the
// underlying SVGs with kebab-case filenames. The script normalises
// snake_case → kebab-case for the file lookup but keeps snake_case
// for the symbol id, so v2 templates can be a near-verbatim port of
// v1.
//
// Usage in templates:
//   <svg class="size-4"><use href="/icons.svg#shield_check"/></svg>

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = [
  join(ROOT, "src/client/templates"),
  join(ROOT, "src/client/pages"),
];
const LUCIDE_DIR = join(ROOT, "node_modules/lucide-static/icons");
const OUT = join(ROOT, "public/icons.svg");

const REF_RE = /href=["']\/icons\.svg#([a-z][a-z0-9_-]*)["']/g;
const SVG_INNER_RE = /<svg\b[^>]*>([\s\S]*?)<\/svg>/;

async function collectReferences() {
  const refs = new Set();
  for (const dir of SCAN_DIRS) {
    const entries = await readdir(dir).catch(() => []);
    for (const file of entries) {
      if (!file.endsWith(".html") && !file.endsWith(".ts")) continue;
      const content = await readFile(join(dir, file), "utf8");
      let m;
      while ((m = REF_RE.exec(content)) !== null) refs.add(m[1]);
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

  // Strip the lucide license comment that comes before <svg> and any
  // leading whitespace from the inner content.
  const inner = m[1].trim();

  // viewBox + presentation attributes are pinned across all lucide
  // icons (24x24, currentColor, stroke 2, round caps/joins). Putting
  // them on the symbol means consumers only need to size the wrapping
  // <svg>: <svg class="size-4"><use href="..."/></svg> works as-is.
  return {
    kind: "ok",
    name: snakeName,
    symbol: `<symbol id="${snakeName}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`,
  };
}

async function build() {
  const names = await collectReferences();
  if (names.length === 0) {
    // Emit an empty (but valid) sprite so the file always exists.
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
  console.log(
    `build-icons: ${names.length} icons → public/icons.svg (${sprite.length} bytes)`,
  );
}

build().catch((err) => {
  console.error("build-icons failed:", err);
  process.exit(1);
});

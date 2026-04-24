// SPDX-License-Identifier: AGPL-3.0-only
//
// Static page assembler for sTELgano v2.
//
// Reads:
//   - src/client/templates/_layout.html  (HTML shell with placeholders)
//   - src/client/pages/*.html            (per-page body fragments)
//
// Each page fragment may declare metadata in a leading HTML comment:
//
//   <!--
//     title: Privacy Policy — sTELgano
//   -->
//
// The layout's {{TITLE}} and {{CONTENT}} placeholders are substituted
// and the result is written to public/<page>.html.
//
// Cloudflare Pages serves clean URLs out of the box: /privacy.html is
// reachable as /privacy. The home page is index.html → /.

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAYOUT_PATH = join(ROOT, "src/client/templates/_layout.html");
const PAGES_DIR = join(ROOT, "src/client/pages");
const OUT_DIR = join(ROOT, "public");

const META_RE = /^\s*<!--([\s\S]*?)-->/;
const META_LINE_RE = /^\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/gm;

function extractMetadata(source) {
  const meta = { title: "sTELgano" };
  const m = source.match(META_RE);
  if (!m) return { meta, body: source };

  const block = m[1];
  let lineMatch;
  while ((lineMatch = META_LINE_RE.exec(block)) !== null) {
    meta[lineMatch[1].toLowerCase()] = lineMatch[2];
  }

  const body = source.slice(m[0].length).replace(/^\s*\n/, "");
  return { meta, body };
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function build() {
  const layout = await readFile(LAYOUT_PATH, "utf8");
  await mkdir(OUT_DIR, { recursive: true });

  const entries = await readdir(PAGES_DIR);
  const pages = entries.filter((f) => f.endsWith(".html"));
  if (pages.length === 0) {
    console.warn("build-html: no pages found in src/client/pages/");
    return;
  }

  for (const file of pages) {
    const source = await readFile(join(PAGES_DIR, file), "utf8");
    const { meta, body } = extractMetadata(source);

    const html = layout
      .replace(/\{\{TITLE\}\}/g, escapeHtml(meta.title))
      .replace(/\{\{CONTENT\}\}/g, body);

    const outFile = join(OUT_DIR, file);
    await writeFile(outFile, html, "utf8");
    console.log(`build-html: ${file} → public/${basename(outFile)} (${html.length} bytes)`);
  }
}

build().catch((err) => {
  console.error("build-html failed:", err);
  process.exit(1);
});

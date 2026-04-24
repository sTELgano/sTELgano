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
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATES_DIR = join(ROOT, "src/client/templates");
const DEFAULT_LAYOUT = "_layout";
const PAGES_DIR = join(ROOT, "src/client/pages");
const OUT_DIR = join(ROOT, "public");

const layoutCache = new Map();
async function loadLayout(name) {
  if (!layoutCache.has(name)) {
    const path = join(TEMPLATES_DIR, `${name}.html`);
    layoutCache.set(name, await readFile(path, "utf8"));
  }
  return layoutCache.get(name);
}

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

async function collectPages(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      pages.push(...(await collectPages(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      pages.push(fullPath);
    }
  }
  return pages;
}

async function build() {
  await mkdir(OUT_DIR, { recursive: true });

  const pagePaths = await collectPages(PAGES_DIR);
  if (pagePaths.length === 0) {
    console.warn("build-html: no pages found in src/client/pages/");
    return;
  }

  for (const sourcePath of pagePaths) {
    const source = await readFile(sourcePath, "utf8");
    const { meta, body } = extractMetadata(source);

    // Page can pick a non-default layout via `layout:` metadata.
    // e.g. `layout: chat` → src/client/templates/_chat_layout.html.
    // Unknown layout names fail loudly.
    const layoutName =
      typeof meta.layout === "string" && meta.layout.trim()
        ? `_${meta.layout.trim()}_layout`
        : DEFAULT_LAYOUT;
    const layout = await loadLayout(layoutName);

    const html = layout
      .replace(/\{\{TITLE\}\}/g, escapeHtml(meta.title))
      .replace(/\{\{CONTENT\}\}/g, body);

    // Mirror the directory structure under PAGES_DIR into OUT_DIR.
    const relPath = relative(PAGES_DIR, sourcePath);
    const outFile = join(OUT_DIR, relPath);
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, html, "utf8");
    console.log(`build-html: ${relPath.split(sep).join("/")} → public/${relPath.split(sep).join("/")} (${html.length} bytes, layout=${layoutName})`);
  }
}

build().catch((err) => {
  console.error("build-html failed:", err);
  process.exit(1);
});

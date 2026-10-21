import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { git } from "./git";

const VIEWPORT = { width: 1280, height: 800 };

function allHtmlFiles(repoDir: string): string[] {
  return git(repoDir, ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.html"])
    .split("\n")
    .filter((f) => f && !f.startsWith("node_modules/"));
}

/**
 * Pages that need screenshots: every changed .html file, plus every page that
 * links a changed .css file.
 */
export function pagesToCapture(repoDir: string, changed: string[]): string[] {
  const pages = new Set<string>();
  const changedCss = changed.filter((f) => f.endsWith(".css"));

  for (const page of allHtmlFiles(repoDir)) {
    if (changed.includes(page)) {
      pages.add(page);
      continue;
    }
    const html = fs.readFileSync(path.join(repoDir, page), "utf8");
    const pageDir = path.posix.dirname(page);
    const usesChangedCss = changedCss.some((css) => {
      const relative = path.posix.relative(pageDir, css);
      return html.includes(relative) || html.includes(`/${css}`);
    });
    if (usesChangedCss) pages.add(page);
  }

  // Only pages that still exist after the change can be screenshotted.
  return [...pages].filter((p) => fs.existsSync(path.join(repoDir, p)));
}

/** Screenshot each page that exists in `rootDir`. Returns the pages captured. */
export async function capturePages(opts: {
  rootDir: string;
  pages: string[];
  outDir: string;
  suffix: "before" | "after";
}): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  const existing = opts.pages.filter((p) => fs.existsSync(path.join(opts.rootDir, p)));
  if (existing.length === 0) return saved;

  fs.mkdirSync(opts.outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    for (const file of existing) {
      const url = pathToFileURL(path.join(opts.rootDir, file)).href;
      // "load" can hang on slow external fonts/images, so give up waiting after 15s.
      await page.goto(url, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const name = `${file.replace(/[\\/]/g, "__").replace(/\.html$/, "")}-${opts.suffix}.png`;
      const target = path.join(opts.outDir, name);
      await page.screenshot({ path: target, fullPage: true });
      saved[file] = name;
    }
  } finally {
    await browser.close();
  }
  return saved;
}

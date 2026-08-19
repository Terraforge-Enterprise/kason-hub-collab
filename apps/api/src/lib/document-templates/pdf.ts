import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";

let browser: Browser | null = null;
let renderCount = 0;
const MAX_RENDERS_PER_BROWSER = 100;
let renderChain: Promise<unknown> = Promise.resolve();
let _cachedExecutablePath: string | null = null;

// Resolve a Chromium binary. Honour PUPPETEER_EXECUTABLE_PATH first (set in
// production / Docker / CI). For dev, probe the canonical install path on
// each OS so the operator doesn't have to set the env var by hand.
function resolveExecutablePath(): string {
  if (_cachedExecutablePath) return _cachedExecutablePath;
  const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && existsSync(explicit)) {
    _cachedExecutablePath = explicit;
    return explicit;
  }
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(
      `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    // Linux (Lightsail, CI, Docker)
    candidates.push(
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    );
  }
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error(
      "No Chromium binary found. Install Chrome/Chromium or set PUPPETEER_EXECUTABLE_PATH " +
        `(probed: ${candidates.filter(Boolean).join(", ")})`,
    );
  }
  _cachedExecutablePath = found;
  return found;
}

async function getBrowser(): Promise<Browser> {
  if (browser && renderCount < MAX_RENDERS_PER_BROWSER) return browser;
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    renderCount = 0;
  }
  browser = await puppeteer.launch({
    executablePath: resolveExecutablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  // Serialize renders to bound memory (one Chrome page at a time)
  const work = renderChain.then(async () => {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      // waitUntil: "load" waits for img/font resources to finish loading
      // before snapshotting to PDF. puppeteer-core 24.x removed
      // "networkidle0/2" from the type union; "load" is the strongest
      // remaining option and is what we need for embedded logos.
      await page.setContent(html, { waitUntil: "load", timeout: 5000 });
      // Print margins come from the document's @page CSS rule (see render.ts).
      // `displayHeaderFooter` plus the tiny header/footer templates below
      // gives every page a page-number stamp at the bottom — without this
      // the last clause of an overflowing T&C section gets chopped at the
      // A4 boundary with no visual "page X of Y" cue. The header is empty
      // (just the date HTML Chromium expects) so only the footer shows.
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate:
          "<div style=\"width:100%;padding:0 18mm;font-family:Arial,Helvetica,sans-serif;font-size:8pt;color:#6b7280;display:flex;justify-content:flex-end;\"><span>Page <span class=\"pageNumber\"></span> of <span class=\"totalPages\"></span></span></div>",
      });
      renderCount += 1;
      return Buffer.from(pdf);
    } catch (err) {
      // Force browser restart on any error
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
        renderCount = 0;
      }
      throw err;
    } finally {
      await page.close().catch(() => {});
    }
  });
  renderChain = work.catch(() => {});
  return work as Promise<Buffer>;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    renderCount = 0;
  }
}

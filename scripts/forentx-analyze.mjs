import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.resolve("tmp/forentx-analysis");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const phoneRaw = process.env.FORENTX_PHONE ?? "";
const password = process.env.FORENTX_PASSWORD ?? "";

if (!phoneRaw || !password) {
  console.error("Missing FORENTX_PHONE or FORENTX_PASSWORD");
  process.exit(1);
}

const normalizedPhone = phoneRaw.replace(/[^\d+]/g, "");
const phoneDigits = normalizedPhone.replace(/^\+/, "");
const countryCode = phoneDigits.startsWith("60") ? "60" : phoneDigits.slice(0, 2);
const localPhone = phoneDigits.startsWith(countryCode) ? phoneDigits.slice(countryCode.length) : phoneDigits;

await fs.mkdir(outDir, { recursive: true });

const puppeteer = await import("puppeteer-core");

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  defaultViewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
page.setDefaultTimeout(30000);
const observedRequests = [];
const observedResponses = [];

page.on("request", (request) => {
  const resourceType = request.resourceType();
  if (!["fetch", "xhr", "document"].includes(resourceType)) return;

  observedRequests.push({
    url: request.url(),
    method: request.method(),
    resourceType,
  });
});

page.on("response", async (response) => {
  const request = response.request();
  if (!["fetch", "xhr", "document"].includes(request.resourceType())) return;

  observedResponses.push({
    url: response.url(),
    status: response.status(),
    method: request.method(),
  });
});

async function saveJson(name, data) {
  await fs.writeFile(path.join(outDir, name), JSON.stringify(data, null, 2));
}

async function saveHtml(name) {
  await fs.writeFile(path.join(outDir, name), await page.content());
}

async function clickByText(tagNames, matcher) {
  const result = await page.evaluate(
    ({ tagNames, matcherSource }) => {
      const tags = new Set(tagNames.map((tag) => tag.toUpperCase()));
      const matcher = new RegExp(matcherSource, "i");
      const elements = Array.from(document.querySelectorAll("*")).filter((node) => tags.has(node.tagName));
      const target = elements.find((node) => matcher.test((node.textContent || "").trim()));
      if (!target) return false;
      target.click();
      return true;
    },
    { tagNames, matcherSource: matcher.source },
  );

  return result;
}

async function clickTab(labelMatcher) {
  return page.evaluate((matcherSource) => {
    const matcher = new RegExp(matcherSource, "i");
    const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
    const target = tabs.find((node) => matcher.test((node.textContent || "").trim()));
    if (!target) return false;
    target.click();
    return true;
  }, labelMatcher.source);
}

async function clickButton(labelMatcher) {
  const buttons = await page.$$("button");

  for (const button of buttons) {
    const details = await page.evaluate((node) => ({
      text: (node.textContent || "").trim(),
      disabled: node.hasAttribute("disabled"),
    }), button);

    if (labelMatcher.test(details.text) && !details.disabled) {
      await button.click();
      return true;
    }
  }

  return false;
}

try {
  await page.goto("https://app.forentx.com", { waitUntil: "networkidle2" });
  await page.screenshot({ path: path.join(outDir, "01-login.png"), fullPage: true });
  await saveHtml("01-login.html");

  await clickTab(/cell phone|phone|手机号|手机/);
  await delay(1000);
  await page.screenshot({ path: path.join(outDir, "02-phone-tab.png"), fullPage: true });
  await saveHtml("02-phone-tab.html");

  const inputs = await page.$$eval("input", (nodes) =>
    nodes.map((node, index) => ({
      index,
      type: node.getAttribute("type"),
      name: node.getAttribute("name"),
      autocomplete: node.getAttribute("autocomplete"),
      placeholder: node.getAttribute("placeholder"),
      valueLength: node.value.length,
    })),
  );
  await saveJson("02-login-inputs.json", inputs);

  const textSnapshot = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  await fs.writeFile(path.join(outDir, "02-login-text.txt"), textSnapshot);

  const usernameInput =
    (await page.$('input[name="phone"]')) ??
    (await page.$('input[type="tel"]')) ??
    (await page.$('#f-form-item-phone input')) ??
    (await page.$('input[type="text"]'));
  if (!usernameInput) {
    throw new Error("Could not find the phone input");
  }
  await usernameInput.click({ clickCount: 3 });
  await usernameInput.type(localPhone, { delay: 30 });

  const passwordInput = await page.$('input[type="password"], input[autocomplete="current-password"]');
  if (!passwordInput) {
    throw new Error("Could not find the password input");
  }
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password, { delay: 30 });

  const filledState = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input")).map((node) => ({
      type: node.getAttribute("type"),
      name: node.getAttribute("name"),
      valueLength: node.value.length,
      valuePreview: node.getAttribute("type") === "password" ? "*".repeat(node.value.length) : node.value,
    }));
    const loginButton = Array.from(document.querySelectorAll("button")).find((node) => /log in/i.test((node.textContent || "").trim()));

    return {
      inputs,
      loginButtonDisabled: loginButton ? loginButton.hasAttribute("disabled") : null,
      loginButtonClasses: loginButton?.className ?? null,
    };
  });
  await saveJson("03-filled-state.json", filledState);
  await page.screenshot({ path: path.join(outDir, "03-filled.png"), fullPage: true });
  await saveHtml("03-filled.html");

  await page.keyboard.press("Enter");
  await delay(2000);

  const authLikeTraffic = observedRequests.some((entry) => /login|auth|sign/i.test(entry.url));
  if (!authLikeTraffic) {
    const submitted = await clickButton(/login|sign in|log in|登入|登录/i);
    if (!submitted) {
      throw new Error("Could not find the submit control");
    }
  }

  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
  await delay(4000);

  await page.screenshot({ path: path.join(outDir, "04-post-submit.png"), fullPage: true });
  await saveHtml("04-post-submit.html");
  await saveJson("04-observed-requests.json", observedRequests);
  await saveJson("04-observed-responses.json", observedResponses);

  const pageSummary = await page.evaluate(() => {
    const navTexts = Array.from(document.querySelectorAll("nav, aside, [role='navigation'] a, [role='menuitem']"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 80);

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 50);

    const buttons = Array.from(document.querySelectorAll("button"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 80);

    return {
      url: location.href,
      title: document.title,
      navTexts,
      headings,
      buttons,
      bodyTextSample: document.body.innerText.slice(0, 5000),
    };
  });

  await saveJson("05-page-summary.json", pageSummary);
  console.log(JSON.stringify({ ok: true, outDir, pageSummary }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(outDir, "99-error.png"), fullPage: true }).catch(() => {});
  await saveHtml("99-error.html").catch(() => {});
  console.error(JSON.stringify({ ok: false, outDir, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}

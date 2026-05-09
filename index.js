const express = require("express");
const puppeteer = require("puppeteer");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const KOT_BASE      = "https://api.kingtime.jp/v1.0";
const KOT_TOKEN     = process.env.KOT_TOKEN;
const KOT_LOGIN_URL = process.env.KOT_LOGIN_URL;
const KOT_USERNAME  = process.env.KOT_USERNAME;
const KOT_PASSWORD  = process.env.KOT_PASSWORD;
const KOT_ADMIN_URL = process.env.KOT_ADMIN_URL;

// ─── KOT API Relay ────────────────────────────────────────────
app.all("/kot/*", async (req, res) => {
  const path = req.params[0];
  const kotUrl = `${KOT_BASE}/${path}`;
  try {
    const response = await fetch(kotUrl, {
      method: req.method,
      headers: {
        "Authorization": `Bearer ${KOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── IP Check ─────────────────────────────────────────────────
app.get("/ip", async (req, res) => {
  const r = await fetch("https://api.ipify.org?format=json");
  const data = await r.json();
  res.json(data);
});
app.get("/debug-page", async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process","--no-zygote"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(KOT_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
    const userSelectors = ['input[name="login_id"]','input[name="loginId"]','input[name="username"]','input[type="text"]'];
    for (const sel of userSelectors) {
      try { await page.waitForSelector(sel, { timeout: 2000 }); await page.type(sel, KOT_USERNAME); break; } catch(e) {}
    }
    await page.type('input[type="password"]', KOT_PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.keyboard.press('Enter')
    ]);

    const adminUrl = page.url(); // use the bot's own session URL after login
console.log("Bot admin URL:", adminUrl);
const paidLeaveUrl = `${adminUrl}?page_id=/setup/day_count_list`;
    await page.goto(paidLeaveUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const url = page.url();
    const html = await page.content();

    res.json({ url, html: html.substring(0, 5000) });
  } catch(e) {
    res.json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});
// ─── Paid Leave Scraper ───────────────────────────────────────
let paidLeaveCache = { data: null, headers: null, updatedAt: null, error: null };

async function scrapePaidLeave() {
  console.log("Starting paid leave scrape...");
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Step 1: Login
    console.log("Logging in...");
    await page.goto(KOT_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });

    const userSelectors = [
      'input[name="login_id"]',
      'input[name="loginId"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[type="text"]'
    ];
    let typed = false;
    for (const sel of userSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 2000 });
        await page.type(sel, KOT_USERNAME);
        typed = true;
        console.log("Username typed using:", sel);
        break;
      } catch(e) {}
    }
    if (!typed) throw new Error("Could not find username field");

    await page.type('input[type="password"]', KOT_PASSWORD);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.keyboard.press('Enter')
    ]);
    console.log("Logged in. URL:", page.url());

    // Step 2: Navigate to paid leave page
    const paidLeaveUrl = `${KOT_ADMIN_URL}?page_id=/setup/day_count_list`;
    console.log("Going to paid leave page...");
    await page.goto(paidLeaveUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait extra and debug
    await new Promise(r => setTimeout(r, 5000));
    console.log("PAGE_URL:", page.url());
    console.log("PAGE_HTML:", (await page.content()).substring(0, 3000));

    try {
      await page.waitForSelector("table", { timeout: 30000 });
    } catch(e) {
      console.log("No table found");
      throw e;
    }

    // Step 3: Scrape headers
    const headers = await page.evaluate(() => {
      const ths = document.querySelectorAll("table thead th, table thead td, table tr:first-child th");
      return Array.from(ths).map(h => h.textContent.trim());
    });
    console.log("Headers:", headers);

    // Step 4: Scrape rows
    const rows = await page.evaluate(() => {
      const trs = document.querySelectorAll("table tbody tr");
      return Array.from(trs).map(tr => {
        const tds = tr.querySelectorAll("td");
        return Array.from(tds).map(td => td.textContent.trim());
      }).filter(r => r.length > 0);
    });
    console.log("Scraped rows:", rows.length);

    paidLeaveCache = {
      headers,
      data: rows,
      updatedAt: new Date().toISOString(),
      error: null
    };

  } catch(e) {
    console.error("Scrape failed:", e.message);
    paidLeaveCache.error = e.message;
  } finally {
    if (browser) await browser.close();
    console.log("Scrape finished");
  }
}

// 7:00 AM JST = 22:00 UTC | 4:00 PM JST = 07:00 UTC
cron.schedule("0 22 * * *", () => scrapePaidLeave());
cron.schedule("0 7 * * *",  () => scrapePaidLeave());

app.get("/paid-leave-data", async (req, res) => {
  const ageMs = paidLeaveCache.updatedAt
    ? Date.now() - new Date(paidLeaveCache.updatedAt).getTime()
    : Infinity;
  const isStale = ageMs > 13 * 60 * 60 * 1000;

  if (isStale) {
    await scrapePaidLeave();
  }
  res.json(paidLeaveCache);
});

// ─── Start Server ─────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => console.log("KOT relay running"));

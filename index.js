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

// ─── Browser Launch Helper ────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
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
}

// ─── Login Helper ─────────────────────────────────────────────
async function loginToKOT(page) {
  await page.goto(KOT_LOGIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  const userSelectors = [
    'input[name="login_id"]',
    'input[name="loginId"]',
    'input[name="username"]',
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

  // Load main admin page to establish session
  await page.goto(KOT_ADMIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  console.log("Admin page loaded");
}

// ─── Debug Page ───────────────────────────────────────────────
app.get("/debug-page", async (req, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await loginToKOT(page);

    // Click Leave management link
    const leaveLink = await page.$('a[href*="day_count_list"]');
    if (!leaveLink) throw new Error("Could not find Leave management link");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      leaveLink.click()
    ]);
    await new Promise(r => setTimeout(r, 5000));

    const url = page.url();
    const html = await page.content();
    res.json({ url, html: html.substring(0, 8000) });
  } catch(e) {
    res.json({ error: e.message });
  } finally {
    if (browser) await browser.close();
  }
});

// ─── Paid Leave Scraper ───────────────────────────────────────
let paidLeaveCache = {
  leaveData: null,
  entitlementData: null,
  updatedAt: null,
  error: null
};

async function scrapePaidLeave() {
  console.log("Starting paid leave scrape...");
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Login
    await loginToKOT(page);

    // ── Scrape Leave Management (day_count_list) ──
    console.log("Navigating to Leave management...");
    const leaveLink = await page.$('a[href*="day_count_list"]');
    if (!leaveLink) throw new Error("Could not find Leave management link");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      leaveLink.click()
    ]);
    await new Promise(r => setTimeout(r, 5000));
    console.log("Leave page URL:", page.url());

    await page.waitForSelector("table", { timeout: 30000 });

    const leaveHeaders = await page.evaluate(() => {
      const ths = document.querySelectorAll("table thead th, table thead td, table tr:first-child th");
      return Array.from(ths).map(h => h.textContent.trim());
    });
    console.log("Leave headers:", leaveHeaders);

    const leaveRows = await page.evaluate(() => {
      const trs = document.querySelectorAll("table tbody tr");
      return Array.from(trs).map(tr => {
        const tds = tr.querySelectorAll("td");
        return Array.from(tds).map(td => td.textContent.trim());
      }).filter(r => r.length > 0);
    });
    console.log("Leave rows scraped:", leaveRows.length);

    // ── Go back to admin page ──
    await page.goto(KOT_ADMIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // ── Scrape Entitlement (assign_paid_holiday_list) ──
    console.log("Navigating to Entitled for Paid leave...");
    const entitleLink = await page.$('a[href*="assign_paid_holiday_list"]');
    let entitleHeaders = [];
    let entitleRows = [];

    if (entitleLink) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
        entitleLink.click()
      ]);
      await new Promise(r => setTimeout(r, 5000));
      console.log("Entitlement page URL:", page.url());

      try {
        await page.waitForSelector("table", { timeout: 30000 });
        entitleHeaders = await page.evaluate(() => {
          const ths = document.querySelectorAll("table thead th, table thead td, table tr:first-child th");
          return Array.from(ths).map(h => h.textContent.trim());
        });
        entitleRows = await page.evaluate(() => {
          const trs = document.querySelectorAll("table tbody tr");
          return Array.from(trs).map(tr => {
            const tds = tr.querySelectorAll("td");
            return Array.from(tds).map(td => td.textContent.trim());
          }).filter(r => r.length > 0);
        });
        console.log("Entitlement rows scraped:", entitleRows.length);
      } catch(e) {
        console.log("No table on entitlement page:", e.message);
      }
    } else {
      console.log("Entitlement link not found");
    }

    paidLeaveCache = {
      leaveData: { headers: leaveHeaders, rows: leaveRows },
      entitlementData: { headers: entitleHeaders, rows: entitleRows },
      updatedAt: new Date().toISOString(),
      error: null
    };

    console.log("Scrape complete!");

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

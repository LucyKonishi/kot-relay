const express = require("express");
const puppeteer = require("puppeteer");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const KOT_BASE = "https://api.kingtime.jp/v1.0";
const KOT_TOKEN = process.env.KOT_TOKEN;
const KOT_LOGIN_URL = process.env.KOT_LOGIN_URL;
const KOT_USERNAME = process.env.KOT_USERNAME;
const KOT_PASSWORD = process.env.KOT_PASSWORD;
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

      // Get the full URL from the link (includes session token)
      const leaveUrl = await page.$eval(
              'a[href*="day_count_list"]',
              a => a.href
            );
          if (!leaveUrl) throw new Error("Could not find Leave management link");
          console.log("Leave URL:", leaveUrl);

      // Navigate directly to the full URL
      await page.goto(leaveUrl, { waitUntil: "networkidle2", timeout: 30000 });
          await new Promise(r => setTimeout(r, 5000));

      const html = await page.content();
          res.send(`<pre>${html.substring(0, 5000)}</pre>`);
    } catch (e) {
          res.status(500).json({ error: e.message });
    } finally {
          if (browser) await browser.close();
    }
});

// ─── Helper: map headers + rows to array of objects ──────────
function mapRowsToObjects(headers, rows) {
    return rows.map(row => {
          const obj = {};
          headers.forEach((header, i) => {
                  if (header) obj[header] = row[i] !== undefined ? row[i] : null;
          });
          return obj;
    });
}

// ─── Helper: find value by multiple possible header names ─────
function findCol(obj, candidates) {
    for (const key of candidates) {
          if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return null;
}

// ─── Helper: scrape table headers (handles multi-row headers) ─
function buildHeaderSelector() {
    // KOT tables often have multi-row <thead>. We grab all th/td in
  // thead plus the first tr, then de-duplicate by position using
  // the LAST header row which contains the actual leaf column names.
  return `
      (() => {
            const table = document.querySelector("table");
                  if (!table) return [];
                        const thead = table.querySelector("thead");
                              if (thead) {
                                      // Use the last row in thead as the definitive header row
                                              const headerRows = Array.from(thead.querySelectorAll("tr"));
                                                      const lastRow = headerRows[headerRows.length - 1];
                                                              return Array.from(lastRow.querySelectorAll("th, td")).map(h => h.textContent.trim());
                                                                    }
                                                                          // Fallback: first <tr> in the table
                                                                                const firstRow = table.querySelector("tr");
                                                                                      if (firstRow) {
                                                                                              return Array.from(firstRow.querySelectorAll("th, td")).map(h => h.textContent.trim());
                                                                                                    }
                                                                                                          return [];
                                                                                                              })()
                                                                                                                `;
}

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
          // Get the full URL from the link (includes session token)
      const leaveUrl = await page.$eval(
              'a[href*="day_count_list"]',
              a => a.href
            );
          if (!leaveUrl) throw new Error("Could not find Leave management link");
          console.log("Leave URL:", leaveUrl);

      // Navigate directly to the full URL
      await page.goto(leaveUrl, { waitUntil: "networkidle2", timeout: 30000 });
          await new Promise(r => setTimeout(r, 5000));
          console.log("Leave page URL:", page.url());

      await page.waitForSelector("table", { timeout: 30000 });

      const leaveHeaders = await page.evaluate(buildHeaderSelector());
          console.log("Leave headers:", leaveHeaders);

      const leaveRows = await page.evaluate(() => {
              const trs = document.querySelectorAll("table tbody tr");
              return Array.from(trs).map(tr => {
                        const tds = tr.querySelectorAll("td");
                        return Array.from(tds).map(td => td.textContent.trim());
              }).filter(r => r.length > 0);
      });
          console.log("Leave rows scraped:", leaveRows.length);

      // Map to named objects and extract key fields
      const leaveMapped = mapRowsToObjects(leaveHeaders, leaveRows);
          const leaveStructured = leaveMapped.map(row => ({
                  raw: row,
                  employeeCode: findCol(row, ["社員コード", "従業員コード", "スタッフコード", "コード", "Code"]),
                  name: findCol(row, ["氏名", "名前", "スタッフ名", "従業員名", "Name"]),
                  paidLeaveRemaining: findCol(row, ["残日数", "有給残日数", "残り日数", "残", "有給残", "Remaining"]),
                  paidLeaveGranted: findCol(row, ["付与日数", "当年付与", "付与", "Granted"]),
                  paidLeaveUsed: findCol(row, ["使用日数", "取得日数", "消化日数", "使用", "Used"]),
          }));

      // Go back to admin page
      await page.goto(KOT_ADMIN_URL, { waitUntil: "networkidle2", timeout: 30000 });
          await new Promise(r => setTimeout(r, 3000));

      // ── Scrape Entitlement (assign_paid_holiday_list) ──
      console.log("Navigating to Entitlement for Paid leave...");
          let entitleHeaders = [];
          let entitleRows = [];
          let entitleStructured = [];

      const entitleUrl = await page.$eval(
              'a[href*="assign_paid_holiday_list"]',
              a => a.href
            );

      if (entitleUrl) {
              await page.goto(entitleUrl, { waitUntil: "networkidle2", timeout: 30000 });
              await new Promise(r => setTimeout(r, 5000));
              console.log("Entitlement page URL:", page.url());

            try {
                      await page.waitForSelector("table", { timeout: 30000 });
                      entitleHeaders = await page.evaluate(buildHeaderSelector());
                      entitleRows = await page.evaluate(() => {
                                  const trs = document.querySelectorAll("table tbody tr");
                                  return Array.from(trs).map(tr => {
                                                const tds = tr.querySelectorAll("td");
                                                return Array.from(tds).map(td => td.textContent.trim());
                                  }).filter(r => r.length > 0);
                      });
                      console.log("Entitlement rows scraped:", entitleRows.length);

                // Map to named objects and extract key fields
                const entitleMapped = mapRowsToObjects(entitleHeaders, entitleRows);
                      entitleStructured = entitleMapped.map(row => ({
                                  raw: row,
                                  employeeCode: findCol(row, ["社員コード", "従業員コード", "スタッフコード", "コード", "Code"]),
                                  name: findCol(row, ["氏名", "名前", "スタッフ名", "従業員名", "Name"]),
                                  grantingDate: findCol(row, ["付与日", "付与年月日", "有給付与日", "Grant Date", "付与日付"]),
                                  grantedDays: findCol(row, ["付与日数", "付与数", "Granted Days"]),
                                  expiryDate: findCol(row, ["有効期限", "期限", "失効日", "Expiry"]),
                      }));
            } catch(e) {
                      console.log("No table on entitlement page:", e.message);
            }
      } else {
              console.log("Entitlement link not found");
      }

      paidLeaveCache = {
              leaveData: {
                        headers: leaveHeaders,
                        rows: leaveRows,
                        structured: leaveStructured,
              },
              entitlementData: {
                        headers: entitleHeaders,
                        rows: entitleRows,
                        structured: entitleStructured,
              },
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

// ── Start Server ──────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => console.log("KOT relay running"));

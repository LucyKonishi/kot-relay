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

const PAID_LEAVE_MAX_AGE_MS = 13 * 60 * 60 * 1000;

let paidLeaveCache = {
  leaveData: null,
  entitlementData: null,
  updatedAt: null,
  error: null
};

// ─── IP Check ─────────────────────────────────────────────────
app.get("/ip", async (req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Enriched KOT Employees Endpoint ──────────────────────────
// IMPORTANT: This route must be BEFORE app.all("/kot/*", ...)
app.get("/kot/employees", async (req, res) => {
  try {
    const response = await fetch(`${KOT_BASE}/employees`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${KOT_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    const employees = await response.json();

    if (!Array.isArray(employees)) {
      return res.status(response.status).json(employees);
    }

    await ensurePaidLeaveCache();

    const paidLeaveMap = buildPaidLeaveMapFromCache();

    const enrichedEmployees = employees.map(emp => {
      const code = normalizeEmployeeCode(emp.code);
      const leave = paidLeaveMap[code] || {};

      return {
        ...emp,

        remainingPaidLeave: leave.remainingPaidLeave ?? null,
        paidLeaveRemaining: leave.remainingPaidLeave ?? null,
        annualPaidLeaveRemaining: leave.remainingPaidLeave ?? null,

        paidLeaveGranted: leave.grantedDays ?? null,
        paidLeaveUsed: leave.usedDays ?? null,
        paidLeaveGrantDate: leave.grantDate || null,
        paidLeaveExpiryDate: leave.expiryDate || null,

        paidLeaveSource: leave.hasRecord ? "KOT_PAID_LEAVE_CACHE" : null
      };
    });

    res.json(enrichedEmployees);

  } catch (err) {
    console.error("Failed enriched /kot/employees:", err.message);

    res.status(500).json({
      error: err.message
    });
  }
});

// ─── Generic KOT API Relay ────────────────────────────────────
// This must come AFTER the custom /kot/employees route.
app.all("/kot/*", async (req, res) => {
  const path = req.params[0];
  const kotUrl = `${KOT_BASE}/${path}`;

  try {
    const response = await fetch(kotUrl, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${KOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body)
    });

    const text = await response.text();

    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (e) {
      res.status(response.status).send(text);
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  if (!KOT_LOGIN_URL || !KOT_USERNAME || !KOT_PASSWORD || !KOT_ADMIN_URL) {
    throw new Error("Missing KOT login environment variables");
  }

  await page.goto(KOT_LOGIN_URL, {
    waitUntil: "networkidle2",
    timeout: 30000
  });

  const userSelectors = [
    'input[name="login_id"]',
    'input[name="loginId"]',
    'input[name="username"]',
    'input[type="text"]'
  ];

  let typed = false;

  for (const sel of userSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 2500 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, KOT_USERNAME);
      typed = true;
      console.log("Username typed using:", sel);
      break;
    } catch (e) {}
  }

  if (!typed) {
    throw new Error("Could not find username field");
  }

  await page.waitForSelector('input[type="password"]', { timeout: 5000 });
  await page.click('input[type="password"]', { clickCount: 3 });
  await page.type('input[type="password"]', KOT_PASSWORD);

  await Promise.all([
    page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: 30000
    }),
    page.keyboard.press("Enter")
  ]);

  console.log("Logged in. URL:", page.url());

  await page.goto(KOT_ADMIN_URL, {
    waitUntil: "networkidle2",
    timeout: 30000
  });

  await wait(3000);
  console.log("Admin page loaded");
}

// ─── Paid Leave Cache Control ─────────────────────────────────
async function ensurePaidLeaveCache() {
  const ageMs = paidLeaveCache.updatedAt
    ? Date.now() - new Date(paidLeaveCache.updatedAt).getTime()
    : Infinity;

  const isStale = ageMs > PAID_LEAVE_MAX_AGE_MS;

  if (isStale || !paidLeaveCache.leaveData) {
    await scrapePaidLeave();
  }

  return paidLeaveCache;
}

// ─── Paid Leave Data Endpoint ─────────────────────────────────
app.get("/paid-leave-data", async (req, res) => {
  try {
    await ensurePaidLeaveCache();
    res.json(paidLeaveCache);
  } catch (err) {
    res.status(500).json({
      error: err.message,
      cache: paidLeaveCache
    });
  }
});

// ─── Debug: raw paid leave cache map ──────────────────────────
app.get("/debug-paid-leave-map", async (req, res) => {
  try {
    await ensurePaidLeaveCache();

    const map = buildPaidLeaveMapFromCache();

    res.json({
      updatedAt: paidLeaveCache.updatedAt,
      error: paidLeaveCache.error,
      count: Object.keys(map).length,
      sample: Object.values(map).slice(0, 20)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug Page ───────────────────────────────────────────────
app.get("/debug-page", async (req, res) => {
  let browser;

  try {
    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await loginToKOT(page);

    const leaveUrl = await findLinkByHrefPart(page, "day_count_list");

    if (!leaveUrl) {
      throw new Error("Could not find Leave management link");
    }

    await page.goto(leaveUrl, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await wait(5000);

    const html = await page.content();

    res.send(`<pre>${escapeHtml(html.substring(0, 10000))}</pre>`);

  } catch (err) {
    res.status(500).json({ error: err.message });

  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

// ─── Paid Leave Scraper ───────────────────────────────────────
async function scrapePaidLeave() {
  console.log("Starting paid leave scrape...");

  let browser;

  try {
    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await loginToKOT(page);

    // ── Scrape Leave Management / day_count_list ──────────────
    console.log("Navigating to Leave management...");

    const leaveUrl = await findLinkByHrefPart(page, "day_count_list");

    if (!leaveUrl) {
      throw new Error("Could not find Leave management link");
    }

    console.log("Leave URL:", leaveUrl);

    await page.goto(leaveUrl, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await wait(5000);

    await tryClickSearchButton(page);
    await wait(3000);

    const leaveExtracted = await extractTargetTableFromPage(page, {
      requiredKeywords: [
        "社員コード",
        "従業員コード",
        "スタッフコード",
        "Employee code",
        "Code"
      ],
      usefulKeywords: [
        "氏名",
        "名前",
        "Name",
        "残日数",
        "有給残",
        "有給残日数",
        "取得日数",
        "使用日数",
        "付与日数",
        "Remaining",
        "Used",
        "Granted"
      ]
    });

    console.log("Leave table index:", leaveExtracted.tableIndex);
    console.log("Leave table score:", leaveExtracted.score);
    console.log("Leave headers:", leaveExtracted.headers);
    console.log("Leave rows scraped:", leaveExtracted.rows.length);

    const leaveStructured = leaveExtracted.objects.map(row => ({
      raw: row,
      employeeCode: findColLoose(row, [
        "社員コード",
        "従業員コード",
        "スタッフコード",
        "コード",
        "Employee code",
        "Code"
      ]),
      name: findColLoose(row, [
        "氏名",
        "名前",
        "スタッフ名",
        "従業員名",
        "Name"
      ]),
      paidLeaveRemaining: findColLoose(row, [
        "残日数",
        "有給残日数",
        "有給残",
        "残り日数",
        "残",
        "Remaining",
        "Remaining days"
      ]),
      paidLeaveGranted: findColLoose(row, [
        "付与日数",
        "付与数",
        "当年付与",
        "付与",
        "Granted",
        "Granted days"
      ]),
      paidLeaveUsed: findColLoose(row, [
        "使用日数",
        "取得日数",
        "消化日数",
        "使用",
        "Used",
        "Used days",
        "Taken",
        "Taken days"
      ])
    }));

    // ── Scrape Entitlement / assign_paid_holiday_list ─────────
    console.log("Navigating to Entitlement for paid leave...");

    await page.goto(KOT_ADMIN_URL, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    await wait(3000);

    let entitleHeaders = [];
    let entitleRows = [];
    let entitleStructured = [];

    const entitleUrl = await findLinkByHrefPart(page, "assign_paid_holiday_list");

    if (entitleUrl) {
      console.log("Entitlement URL:", entitleUrl);

      await page.goto(entitleUrl, {
        waitUntil: "networkidle2",
        timeout: 30000
      });

      await wait(5000);

      await tryClickSearchButton(page);
      await wait(3000);

      const entitlementExtracted = await extractTargetTableFromPage(page, {
        requiredKeywords: [
          "社員コード",
          "従業員コード",
          "スタッフコード",
          "Employee code",
          "Code"
        ],
        usefulKeywords: [
          "氏名",
          "名前",
          "Name",
          "付与日",
          "付与年月日",
          "付与日数",
          "有効期限",
          "失効日",
          "Grant",
          "Granted",
          "Expiry"
        ]
      });

      entitleHeaders = entitlementExtracted.headers;
      entitleRows = entitlementExtracted.rows;

      console.log("Entitlement table index:", entitlementExtracted.tableIndex);
      console.log("Entitlement table score:", entitlementExtracted.score);
      console.log("Entitlement headers:", entitleHeaders);
      console.log("Entitlement rows scraped:", entitleRows.length);

      entitleStructured = entitlementExtracted.objects.map(row => ({
        raw: row,
        employeeCode: findColLoose(row, [
          "社員コード",
          "従業員コード",
          "スタッフコード",
          "コード",
          "Employee code",
          "Code"
        ]),
        name: findColLoose(row, [
          "氏名",
          "名前",
          "スタッフ名",
          "従業員名",
          "Name"
        ]),
        grantingDate: findColLoose(row, [
          "付与日",
          "付与年月日",
          "有給付与日",
          "付与日付",
          "Grant Date",
          "Grant date",
          "Granted date"
        ]),
        grantedDays: findColLoose(row, [
          "付与日数",
          "付与数",
          "Granted Days",
          "Granted days",
          "Granted"
        ]),
        expiryDate: findColLoose(row, [
          "有効期限",
          "期限",
          "失効日",
          "Expiry",
          "Expiry date",
          "Expiration"
        ])
      }));

    } else {
      console.log("Entitlement link not found");
    }

    paidLeaveCache = {
      leaveData: {
        headers: leaveExtracted.headers,
        rows: leaveExtracted.rows,
        structured: leaveStructured,
        tableIndex: leaveExtracted.tableIndex,
        score: leaveExtracted.score,
        rankedTables: leaveExtracted.ranked
      },
      entitlementData: {
        headers: entitleHeaders,
        rows: entitleRows,
        structured: entitleStructured
      },
      updatedAt: new Date().toISOString(),
      error: null
    };

    console.log("Paid leave scrape complete!");

  } catch (err) {
    console.error("Paid leave scrape failed:", err.message);

    paidLeaveCache = {
      ...paidLeaveCache,
      updatedAt: paidLeaveCache.updatedAt,
      error: err.message
    };

  } finally {
    if (browser) {
      await browser.close();
    }

    console.log("Paid leave scrape finished");
  }
}

// ─── Table Extraction Helpers ─────────────────────────────────
async function extractTargetTableFromPage(page, options) {
  const requiredKeywords = options.requiredKeywords || [];
  const usefulKeywords = options.usefulKeywords || [];

  return page.evaluate(({ requiredKeywords, usefulKeywords }) => {
    function clean(v) {
      return String(v || "").replace(/\s+/g, " ").trim();
    }

    function norm(v) {
      return clean(v).toLowerCase();
    }

    function rowCells(tr) {
      return Array.from(tr.querySelectorAll("th, td"))
        .map(td => clean(td.textContent));
    }

    function buildHeaders(table) {
      const theadRows = Array.from(table.querySelectorAll("thead tr"));

      if (theadRows.length > 0) {
        return rowCells(theadRows[theadRows.length - 1]);
      }

      const rows = Array.from(table.querySelectorAll("tr"));

      if (rows.length > 0) {
        return rowCells(rows[0]);
      }

      return [];
    }

    function buildRows(table) {
      const tbodyRows = Array.from(table.querySelectorAll("tbody tr"));

      const rows = tbodyRows.length > 0
        ? tbodyRows
        : Array.from(table.querySelectorAll("tr")).slice(1);

      return rows
        .map(rowCells)
        .filter(r => r.some(c => c !== ""));
    }

    function scoreTable(table) {
      const text = clean(table.textContent);
      const normalizedText = norm(text);

      let score = 0;

      requiredKeywords.forEach(k => {
        if (normalizedText.includes(norm(k))) {
          score += 10;
        }
      });

      usefulKeywords.forEach(k => {
        if (normalizedText.includes(norm(k))) {
          score += 3;
        }
      });

      // Penalize known menu/navigation tables
      if (
        normalizedText.includes("work data daily data monthly data") ||
        normalizedText.includes("schedule schedule management") ||
        normalizedText.includes("confirm attendance data error")
      ) {
        score -= 100;
      }

      return score;
    }

    const tables = Array.from(document.querySelectorAll("table"));

    const ranked = tables
      .map((table, index) => ({
        index,
        table,
        score: scoreTable(table),
        textSample: clean(table.textContent).slice(0, 600)
      }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];

    if (!best || best.score <= 0) {
      return {
        tableIndex: null,
        score: 0,
        headers: [],
        rows: [],
        objects: [],
        ranked: ranked.map(x => ({
          index: x.index,
          score: x.score,
          textSample: x.textSample
        }))
      };
    }

    const headers = buildHeaders(best.table);
    const rows = buildRows(best.table);

    const objects = rows.map(row => {
      const obj = {};

      headers.forEach((h, i) => {
        if (h) {
          obj[h] = row[i] !== undefined ? row[i] : "";
        }
      });

      return obj;
    });

    return {
      tableIndex: best.index,
      score: best.score,
      headers,
      rows,
      objects,
      ranked: ranked.map(x => ({
        index: x.index,
        score: x.score,
        textSample: x.textSample
      }))
    };

  }, {
    requiredKeywords,
    usefulKeywords
  });
}

async function tryClickSearchButton(page) {
  try {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll("button, input[type='submit'], input[type='button'], a")
      );

      const target = candidates.find(el => {
        const text = (
          el.textContent ||
          el.value ||
          el.getAttribute("aria-label") ||
          ""
        ).trim();

        const lower = text.toLowerCase();

        return (
          text.includes("検索") ||
          text.includes("表示") ||
          lower.includes("search") ||
          lower.includes("display")
        );
      });

      if (target) {
        target.click();
        return true;
      }

      return false;
    });

    if (clicked) {
      console.log("Clicked search/display button");
      await wait(3000);
    }

  } catch (err) {
    console.log("Search click skipped:", err.message);
  }
}

async function findLinkByHrefPart(page, hrefPart) {
  try {
    return await page.evaluate(part => {
      const anchors = Array.from(document.querySelectorAll("a"));

      const target = anchors.find(a => {
        const href = a.href || "";
        return href.includes(part);
      });

      return target ? target.href : null;
    }, hrefPart);

  } catch (err) {
    return null;
  }
}

// ─── Paid Leave Map Builder ───────────────────────────────────
function buildPaidLeaveMapFromCache() {
  const map = {};

  const leaveRows =
    paidLeaveCache &&
    paidLeaveCache.leaveData &&
    Array.isArray(paidLeaveCache.leaveData.structured)
      ? paidLeaveCache.leaveData.structured
      : [];

  const entitlementRows =
    paidLeaveCache &&
    paidLeaveCache.entitlementData &&
    Array.isArray(paidLeaveCache.entitlementData.structured)
      ? paidLeaveCache.entitlementData.structured
      : [];

  const entitlementByCode = {};

  entitlementRows.forEach(row => {
    const code = normalizeEmployeeCode(row.employeeCode);

    if (!code) return;

    entitlementByCode[code] = row;
  });

  leaveRows.forEach(row => {
    const code = normalizeEmployeeCode(row.employeeCode);

    if (!code) return;

    const entitlement = entitlementByCode[code] || {};

    const remainingPaidLeave = parseJapaneseNumber(
      row.paidLeaveRemaining ||
      row.remainingPaidLeave ||
      row.remainingDays
    );

    const grantedDays = parseJapaneseNumber(
      entitlement.grantedDays ||
      row.paidLeaveGranted ||
      row.grantedDays
    );

    const usedDays = parseJapaneseNumber(
      row.paidLeaveUsed ||
      row.usedDays ||
      row.takenDays
    );

    const grantDate = normalizeDateText(
      entitlement.grantingDate ||
      row.grantingDate ||
      row.grantDate
    );

    const expiryDate = normalizeDateText(
      entitlement.expiryDate ||
      row.expiryDate
    );

    map[code] = {
      employeeCode: code,
      remainingPaidLeave,
      grantedDays,
      usedDays,
      grantDate,
      expiryDate,
      hasRecord:
        remainingPaidLeave !== null ||
        grantedDays !== null ||
        usedDays !== null ||
        !!grantDate ||
        !!expiryDate
    };
  });

  return map;
}

// ─── Generic Helpers ──────────────────────────────────────────
function findColLoose(obj, candidates) {
  if (!obj || typeof obj !== "object") return "";

  const keys = Object.keys(obj);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeLoose(candidate);

    // Exact match first
    for (const key of keys) {
      if (normalizeLoose(key) === normalizedCandidate) {
        const value = obj[key];

        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      }
    }

    // Partial match second
    for (const key of keys) {
      if (normalizeLoose(key).includes(normalizedCandidate)) {
        const value = obj[key];

        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      }
    }
  }

  return "";
}

function normalizeLoose(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()]/g, "");
}

function normalizeEmployeeCode(value) {
  const s = String(value || "").trim();

  if (!s) return "";

  const noLeadingZeros = s.replace(/^0+/, "");

  return noLeadingZeros || "0";
}

function parseJapaneseNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const s = String(value)
    .replace(/日/g, "")
    .replace(/,/g, "")
    .trim();

  const n = Number(s);

  return isNaN(n) ? null : n;
}

function normalizeDateText(value) {
  if (!value) return "";

  const s = String(value).trim();

  const normalized = s
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace(/年/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "");

  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (!m) return "";

  const y = m[1];
  const mo = String(m[2]).padStart(2, "0");
  const d = String(m[3]).padStart(2, "0");

  return `${y}-${mo}-${d}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Scheduled Scrapes ────────────────────────────────────────
// 7:00 AM JST = 22:00 UTC
// 4:00 PM JST = 07:00 UTC
cron.schedule("0 22 * * *", () => scrapePaidLeave());
cron.schedule("0 7 * * *", () => scrapePaidLeave());

// ─── Start Server ─────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log("KOT relay running");
});

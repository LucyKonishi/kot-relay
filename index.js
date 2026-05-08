const express = require("express");
const app = express();
app.use(express.json());

const KOT_BASE = "https://api.kingtime.jp/v1.0";
const KOT_TOKEN = process.env.KOT_TOKEN;

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

app.listen(process.env.PORT || 3000, () => console.log("KOT relay running"));

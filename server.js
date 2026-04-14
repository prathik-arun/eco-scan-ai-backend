import { createServer } from "node:http";
import admin from "firebase-admin";

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY || "";
const DAILY_BUDGET_KG = 20;

if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    })
  });
}

const firestore = admin.apps.length ? admin.firestore() : null;

const systemPrompt =
  "You estimate the carbon footprint of one personal activity. " +
  "Return strict JSON with keys: kilograms, category, explanation, activity, impactLevel, suggestion. " +
  "kilograms must be a number in kg CO2e. category must be one short label like Transport, Food, Energy, Shopping, Waste, or Others. " +
  "explanation must be under 140 characters. activity must be a short normalized activity label. " +
  "impactLevel must be either High or Low. Mark it High when kilograms is 3 or more. " +
  "suggestion must be a short practical lower-carbon swap when impactLevel is High. If impactLevel is Low, suggestion should be an empty string.";

const smsPromptPrefix =
  "This input is an incoming SMS about a bill, purchase, fuel refill, electricity usage, food order, or payment. " +
  "Infer the real-world activity behind the SMS and estimate its carbon footprint. Respond with JSON only: ";

const server = createServer(async (req, res) => {
  addCors(res);
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/today-summary") {
    try {
      sendJson(res, 200, await getTodaySummary());
    } catch (error) {
      console.error("Today summary failed:", error);
      sendJson(res, 200, emptyTodaySummary());
    }
    return;
  }

  if (
    req.method === "GET" &&
    (requestUrl.pathname === "/today-log-text" || requestUrl.pathname === "/today-log-only-text")
  ) {
    try {
      sendText(res, 200, await getTodayLogText());
    } catch (error) {
      console.error("Today log text failed:", error);
      sendText(res, 200, "No saved logs for today yet.");
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/today-total-text") {
    try {
      sendText(res, 200, await getTodayTotalText());
    } catch (error) {
      console.error("Today total text failed:", error);
      sendText(res, 200, "0");
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/today-impact-text") {
    try {
      sendText(res, 200, await getTodayImpactText());
    } catch (error) {
      console.error("Today impact text failed:", error);
      sendText(res, 200, "Low, good job.");
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/today-tips-text") {
    try {
      sendText(res, 200, await getTodayTipsText());
    } catch (error) {
      console.error("Today tips text failed:", error);
      sendText(res, 200, emptyTipsText());
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/weekly-trends-text") {
    try {
      sendText(res, 200, await getWeeklyTrendsText());
    } catch (error) {
      console.error("Weekly trends text failed:", error);
      sendText(res, 200, emptyWeeklyTrendsText());
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/weekly-trends-page") {
    try {
      sendHtml(res, 200, await getWeeklyTrendsHtml());
    } catch (error) {
      console.error("Weekly trends page failed:", error);
      sendHtml(res, 200, emptyWeeklyTrendsHtml());
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/weekly-chart-pairs") {
    try {
      sendText(res, 200, await getWeeklyChartPairsText());
    } catch (error) {
      console.error("Weekly chart pairs failed:", error);
      sendText(res, 200, "1,0,2,0,3,0,4,0,5,0,6,0,7,0");
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/category-chart-pairs") {
    try {
      sendText(res, 200, await getCategoryChartPairsText());
    } catch (error) {
      console.error("Category chart pairs failed:", error);
      sendText(res, 200, "No data,1");
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/save-manual-entry") {
    try {
      const rawBody = (await readText(req)).trim();
      const parts = rawBody.split("|||");
      const activityText = String(parts[0] || "").trim();
      if (!activityText) {
        sendJson(res, 400, { error: "Missing activityText." });
        return;
      }

      await saveAiResult({
        inputType: String(parts[2] || "type"),
        activityText,
        aiResult: {
          kilograms: Number(parts[3] || 0),
          category: String(parts[4] || "Others"),
          explanation: String(parts[5] || "AI estimated the footprint from the provided input."),
          activity: String(parts[1] || activityText),
          impactLevel: String(parts[6] || inferImpactLevel(Number(parts[3] || 0))),
          suggestion: String(parts[7] || "")
        }
      });

      sendJson(res, 200, { saved: true });
    } catch (error) {
      console.error("Save manual entry failed:", error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown save error." });
    }
    return;
  }

  if (!OPENAI_API_KEY) {
    sendJson(res, 503, { error: "Missing OPENAI_API_KEY on the backend." });
    return;
  }

  try {
    if ((req.method === "POST" || req.method === "GET") && requestUrl.pathname === "/analyze-text") {
      const activityText = req.method === "GET"
        ? (requestUrl.searchParams.get("input") || "").trim()
        : (await readText(req)).trim();

      if (!activityText) {
        sendJson(res, 400, { error: "Text input is empty." });
        return;
      }

      const aiResult = await analyzeText(activityText);
      sendAiResult(res, aiResult);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/ingest-sms") {
      const smsText = (await readText(req)).trim();
      if (!smsText) {
        sendJson(res, 200, { saved: false, reason: "empty" });
        return;
      }

      if (!isLikelyBillSms(smsText)) {
        sendJson(res, 200, { saved: false, reason: "ignored" });
        return;
      }

      const aiResult = await analyzeSmsText(smsText);
      await saveAiResult({
        inputType: "sms",
        activityText: smsText,
        aiResult
      });
      sendJson(res, 200, { saved: true });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/analyze-image") {
      const { buffer, contentType } = await readBuffer(req);
      if (!buffer.length) {
        sendJson(res, 400, { error: "Image input is empty." });
        return;
      }

      const aiResult = await analyzeImage(buffer, normalizeImageContentType(buffer, contentType));
      sendAiResult(res, aiResult);
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    console.error("Request failed:", error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown server error." });
  }
});

server.listen(PORT, () => {
  console.log(`EcoScan AI backend listening on http://localhost:${PORT}`);
});

function addCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendAiResult(res, aiResult) {
  sendJson(res, 200, [
    aiResult.kilograms,
    aiResult.category,
    aiResult.explanation,
    aiResult.activity,
    aiResult.impactLevel,
    aiResult.suggestion
  ]);
}

function readText(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function readBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      resolve({
        buffer: Buffer.concat(chunks),
        contentType: req.headers["content-type"]
      });
    });
    req.on("error", reject);
  });
}

async function analyzeText(activityText) {
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: "Estimate the footprint for this activity and respond with JSON only: " + activityText
      }
    ]
  };

  return requestOpenAi(payload);
}

async function analyzeSmsText(activityText) {
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: smsPromptPrefix + activityText
      }
    ]
  };

  return requestOpenAi(payload);
}

async function analyzeImage(buffer, contentType) {
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Look at the uploaded photo and estimate the carbon footprint. " +
              "The image may be a restaurant bill with multiple items, a grocery/product package, or a direct photo of food or an item. " +
              "If it is a bill or receipt, identify the main items, infer the likely purchase or meal, and estimate the total footprint of that purchase as one logged activity. " +
              "If it is a single product or food item, estimate the footprint of that item. " +
              "Use a short clear activity name, a practical category, and a realistic kg CO2e estimate. Return JSON only."
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${contentType};base64,${buffer.toString("base64")}`
            }
          }
        ]
      }
    ]
  };

  return requestOpenAi(payload);
}

function normalizeImageContentType(buffer, contentType) {
  const rawType = String(contentType || "").toLowerCase().trim();

  if (rawType.startsWith("image/jpeg") || rawType.startsWith("image/jpg")) {
    return "image/jpeg";
  }

  if (rawType.startsWith("image/png")) {
    return "image/png";
  }

  if (rawType.startsWith("image/webp")) {
    return "image/webp";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return "image/jpeg";
}

async function requestOpenAi(payload) {
  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeAiResult(extractJson(content));
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`AI response did not include JSON: ${text}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeAiResult(result) {
  const kilograms = Number(result.kilograms || result.kg || 0);
  const impactLevel = inferImpactLevel(kilograms);
  const suggestion = String(result.suggestion || "");

  return {
    kilograms,
    category: String(result.category || "Others"),
    explanation: String(result.explanation || "AI estimated the footprint from the provided input."),
    activity: String(result.activity || "AI activity"),
    impactLevel,
    suggestion: impactLevel === "High"
      ? (suggestion || "Choose a lower-carbon alternative for this activity.")
      : ""
  };
}

function inferImpactLevel(kilograms) {
  return Number(kilograms || 0) >= 3 ? "High" : "Low";
}

function inferInputType(activityText) {
  return /\b(spoke|said|voice)\b/i.test(activityText) ? "voice" : "type";
}

function isLikelyBillSms(text) {
  const normalized = String(text || "").toLowerCase();
  const keywordRegex =
    /\b(petrol|fuel|diesel|electricity|power bill|restaurant|cafe|dining|swiggy|zomato|uber|ola|invoice|receipt|bill|paid|payment|purchase|purchased|order|ordered|supermarket|grocery|mart|shell|hpcl|bpcl|bharat petroleum|indianoil|ioc|hotel|eat|food|txn|transaction|merchant|upi|debit card|credit card|amazon|flipkart|myntra|blinkit|zepto|bigbasket|instamart|restaurant|lunch|dinner|breakfast|meal)\b/;
  const amountRegex = /\b(rs\.?|inr)\s?\d+|₹\s?\d+|\bcharged\b|\bdebited\b|\bspent\b|\bpaid\b.*\bto\b|\bpayment\b.*\bof\b/;
  return keywordRegex.test(normalized) || amountRegex.test(normalized);
}

function saveAiResultLater(payload) {
  saveAiResult(payload).catch((error) => {
    console.error("Firestore save skipped due to error:", error);
  });
}

async function saveAiResult({ inputType, activityText, aiResult }) {
  if (!firestore) {
    return;
  }

  const now = new Date();
  const dateId = formatDateId(now);
  const dayRef = firestore.collection("dailyLogs").doc(dateId);
  const entryRef = dayRef.collection("entries").doc();

  await firestore.runTransaction(async (transaction) => {
    const daySnap = await transaction.get(dayRef);
    const previousDayTotal = daySnap.exists ? Number(daySnap.data().dayTotalKg || 0) : 0;
    const nextDayTotal = roundToOne(previousDayTotal + aiResult.kilograms);
    const budgetLeftKg = roundToOne(Math.max(0, DAILY_BUDGET_KG - nextDayTotal));
    const updatedAt = admin.firestore.Timestamp.fromDate(now);

    transaction.set(
      dayRef,
      {
        date: dateId,
        dayTotalKg: nextDayTotal,
        budgetLeftKg,
        entryCount: daySnap.exists ? Number(daySnap.data().entryCount || 0) + 1 : 1,
        updatedAt
      },
      { merge: true }
    );

    transaction.set(entryRef, {
      activityText,
      normalizedActivity: aiResult.activity,
      inputType,
      carbonKg: roundToOne(aiResult.kilograms),
      impactLevel: aiResult.impactLevel,
      aiSuggestion: aiResult.suggestion,
      budgetLeftKg,
      category: aiResult.category,
      aiExplanation: aiResult.explanation,
      createdAt: updatedAt
    });
  });
}

async function getTodaySummary() {
  if (!firestore) {
    return emptyTodaySummary();
  }

  const dateId = formatDateId(new Date());
  const dayRef = firestore.collection("dailyLogs").doc(dateId);
  const daySnap = await dayRef.get();
  const entriesSnap = await dayRef.collection("entries").orderBy("createdAt", "asc").get();
  const entries = entriesSnap.docs.map((doc) => doc.data());

  if (!entries.length) {
    return emptyTodaySummary();
  }

  const dayTotalKg = daySnap.exists
    ? Number(daySnap.data().dayTotalKg || 0)
    : roundToOne(entries.reduce((total, entry) => total + Number(entry.carbonKg || 0), 0));

  const logText = entries
    .map((entry) => `- ${entry.activityText || entry.normalizedActivity || "Activity"} - ${Number(entry.carbonKg || 0)} kg CO2`)
    .join("\n");

  const highTips = entries
    .filter((entry) => entry.impactLevel === "High" && entry.aiSuggestion)
    .map((entry) => [
      "------------------------------",
      "TIP CARD",
      `Try: ${entry.aiSuggestion}`,
      `For: ${entry.activityText || entry.normalizedActivity || "Activity"}`,
      "------------------------------"
    ].join("\n"));

  const tipsText = highTips.length ? highTips.join("\n\n") : emptyTipsText();
  const topSource = mostCommon(entries.map((entry) => entry.category).filter(Boolean)) || "Others";

  return [dayTotalKg, logText, tipsText, topSource];
}

async function getTodayLogText() {
  const { entries } = await getTodayEntries();
  if (!entries.length) {
    return "No saved logs for today yet.<br/><br/>Tap Scan, Type, or Voice to add your first activity.";
  }

  const rows = entries.map((entry, index) => {
    const activity = escapeHtml(entry.activityText || entry.normalizedActivity || "Activity");
    const impact = entry.impactLevel || "Low";
    const carbonKg = Number(entry.carbonKg || 0);
    const impactColor = impact === "High" ? "#DD4B39" : "#2563EB";
    const agentLine = entry.inputType === "sms"
      ? `${aiAgentBadgeHtml()} <font color="#5B7364"><i>Detected using AI agent</i></font>`
      : "";

    return [
      `<b>LOG ENTRY ${index + 1}</b>`,
      `<font color="#5B7364">Activity:</font> ${activity}`,
      `Carbon: <font color="${impactColor}"><b>${carbonKg} kg CO2e</b></font>`,
      `Impact: <font color="${impactColor}"><b>${impact}</b></font>`,
      agentLine
    ].filter(Boolean).join("<br/>");
  });

  return rows.join("<br/><br/>------------------------------<br/><br/>");
}

function aiAgentBadgeHtml() {
  return [
    `<span style="display:inline-block;vertical-align:middle;min-width:28px;height:22px;`,
    `line-height:22px;text-align:center;border-radius:8px;padding:0 6px;`,
    `font-weight:700;font-size:11px;font-family:Arial,sans-serif;`,
    `color:#ffffff;background:linear-gradient(135deg,#29d3c2,#3d5afe,#9333ea);`,
    `box-shadow:0 1px 4px rgba(61,90,254,.25);margin-right:6px;">AI ✦</span>`
  ].join("");
}

async function getTodayTipsText() {
  const { entries } = await getTodayEntries();
  const highTips = entries
    .filter((entry) => entry.impactLevel === "High" && entry.aiSuggestion)
    .map((entry) => [
      "------------------------------",
      "TIP CARD",
      `Try: ${entry.aiSuggestion}`,
      `For: ${entry.activityText || entry.normalizedActivity || "Activity"}`,
      "------------------------------"
    ].join("\n"));

  return highTips.length ? highTips.join("\n\n") : emptyTipsText();
}

async function getTodayTotalText() {
  const { dayTotalKg } = await getTodayEntries();
  return String(dayTotalKg);
}

async function getTodayImpactText() {
  const { dayTotalKg } = await getTodayEntries();

  if (dayTotalKg < 10) {
    return "Low impact today, good job.";
  }

  if (dayTotalKg <= 20) {
    return "Mid impact today, could do better.";
  }

  if (!OPENAI_API_KEY) {
    return highImpactFallback(dayTotalKg);
  }

  try {
    const payload = {
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content:
            "Write one short sentence under 18 words about carbon footprint impact. " +
            "Be vivid but factual, easy to understand, and suitable for a mobile app. " +
            "Do not use markdown. Do not mention exact emissions formulas."
        },
        {
          role: "user",
          content:
            `Today's total is ${dayTotalKg} kg CO2e. ` +
            "Give one short comparison sentence such as car distance, electricity use, or tree absorption."
        }
      ]
    };

    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content || "").trim();

    if (!response.ok || !content) {
      return highImpactFallback(dayTotalKg);
    }

    return content.replace(/\s+/g, " ");
  } catch (error) {
    console.error("AI today impact message failed:", error);
    return highImpactFallback(dayTotalKg);
  }
}

async function getWeeklyTrendsText() {
  if (!firestore) {
    return emptyWeeklyTrendsText();
  }

  const dates = getCurrentWeekDateIds();
  const dayRows = [];
  const allEntries = [];

  for (const dateInfo of dates) {
    const dayRef = firestore.collection("dailyLogs").doc(dateInfo.id);
    const daySnap = await dayRef.get();
    const entriesSnap = await dayRef.collection("entries").orderBy("createdAt", "asc").get();
    const entries = entriesSnap.docs.map((doc) => doc.data());
    const total = daySnap.exists
      ? Number(daySnap.data().dayTotalKg || 0)
      : roundToOne(entries.reduce((sum, entry) => sum + Number(entry.carbonKg || 0), 0));

    dayRows.push({ ...dateInfo, total: roundToOne(total), entries });
    allEntries.push(...entries);
  }

  const weekTotal = roundToOne(dayRows.reduce((sum, day) => sum + day.total, 0));
  const activeDays = dayRows.filter((day) => day.total > 0).length;
  const maxDayTotal = Math.max(1, ...dayRows.map((day) => day.total));
  const categoryTotals = new Map();

  for (const entry of allEntries) {
    const category = entry.category || "Others";
    categoryTotals.set(category, roundToOne((categoryTotals.get(category) || 0) + Number(entry.carbonKg || 0)));
  }

  const highTipCount = allEntries.filter((entry) => entry.impactLevel === "High" && entry.aiSuggestion).length;
  const earnedBadges = getEarnedBadges({ allEntries, activeDays, dayRows, categoryTotals, highTipCount });
  const lockedBadges = getLockedBadges(earnedBadges);
  const barRows = dayRows.map((day) => {
    const barLength = Math.max(day.total > 0 ? 1 : 0, Math.round((day.total / maxDayTotal) * 12));
    const bar = barLength > 0 ? "#".repeat(barLength) : ".";
    return `${day.label.padEnd(3)} | ${bar.padEnd(12)} ${day.total} kg`;
  });
  const categoryRows = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, total]) => `${category}: ${total} kg CO2e`);

  return [
    "WEEKLY BAR GRAPH",
    `Total this week: ${weekTotal} kg CO2e`,
    "Low = under 3 kg, Medium = 3-9.9 kg, High = 10+ kg",
    "",
    ...barRows,
    "",
    "BREAKDOWN BY CATEGORY",
    ...(categoryRows.length ? categoryRows : ["No category data yet."]),
    "",
    "BADGES EARNED",
    ...(earnedBadges.length ? earnedBadges.map((badge) => earnedBadgeText(badge)) : ["No badges earned yet. Log your first activity to begin."]),
    "",
    "BADGES TO EARN",
    ...lockedBadges.map((badge) => lockedBadgeText(badge))
  ].join("\n");
}

async function getWeeklyChartPairsText() {
  const trends = await getWeeklyTrendData();
  if (!trends.dayRows.length) {
    return "1,0,2,0,3,0,4,0,5,0,6,0,7,0";
  }

  return trends.dayRows
    .map((day, index) => `${index + 1},${day.total}`)
    .join(",");
}

async function getCategoryChartPairsText() {
  const trends = await getWeeklyTrendData();
  if (!trends.categoryRows.length) {
    return "No data,1";
  }

  return trends.categoryRows
    .map((row) => `${safeChartLabel(row.category)},${row.total}`)
    .join(",");
}

async function getWeeklyTrendsHtml() {
  const trends = await getWeeklyTrendData();
  const dayRows = trends.dayRows.length
    ? trends.dayRows
    : getCurrentWeekDateIds().map((day) => ({ ...day, total: 0 }));
  const maxDayTotal = Math.max(1, ...dayRows.map((day) => Number(day.total || 0)));
  const categories = trends.categoryRows.length
    ? trends.categoryRows
    : [{ category: "No data yet", total: 0 }];
  const maxCategoryTotal = Math.max(1, ...categories.map((row) => Number(row.total || 0)));
  const earnedBadges = getTrendBadges(trends).earned;
  const lockedBadges = getTrendBadges(trends).locked;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0 14px 24px;
      background: #f3f8f4;
      color: #24382f;
      font-family: Georgia, "Times New Roman", serif;
    }
    .hero {
      margin: 0 -14px 18px;
      padding: 22px 20px 20px;
      background: linear-gradient(135deg, #08633f, #0d7f52);
      color: white;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 24px; letter-spacing: .3px; }
    .sub { margin-top: 4px; opacity: .88; font-size: 14px; }
    .card {
      background: white;
      border: 1px solid #dfe8e1;
      border-radius: 14px;
      box-shadow: 0 2px 8px rgba(20, 61, 42, .08);
      padding: 14px;
      margin-bottom: 14px;
    }
    .total {
      text-align: center;
      padding: 8px 0 4px;
    }
    .total .value {
      color: #149b6a;
      font-family: Arial, sans-serif;
      font-size: 34px;
      font-weight: 800;
      line-height: 1;
    }
    .total .label { color: #66756d; font-size: 13px; margin-top: 5px; }
    .bars {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      align-items: end;
      gap: 8px;
      height: 160px;
      padding: 8px 2px 0;
    }
    .bar-wrap {
      height: 126px;
      display: flex;
      align-items: end;
      justify-content: center;
    }
    .bar {
      width: 100%;
      min-height: 4px;
      border-radius: 7px 7px 2px 2px;
      background: #5bc99d;
      position: relative;
    }
    .bar.medium { background: #c57c14; }
    .bar.high { background: #e6464f; }
    .bar span {
      position: absolute;
      top: -18px;
      left: 50%;
      transform: translateX(-50%);
      font-family: Arial, sans-serif;
      font-size: 10px;
      font-weight: 700;
      color: #304138;
      white-space: nowrap;
    }
    .day { text-align: center; color: #6e7a72; font-size: 12px; }
    .legend { color: #7a827c; font-size: 12px; text-align: center; margin-top: 10px; }
    h2 {
      font-size: 15px;
      letter-spacing: 1.3px;
      margin-bottom: 12px;
      color: #3c3d37;
    }
    .cat-row {
      display: grid;
      grid-template-columns: 88px 1fr 54px;
      align-items: center;
      gap: 10px;
      margin: 10px 0;
      font-size: 14px;
    }
    .track {
      height: 12px;
      border-radius: 20px;
      background: #edf0ed;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      border-radius: 20px;
      background: #149b6a;
    }
    .cat-row:nth-child(2) .fill { background: #e6464f; }
    .cat-row:nth-child(3) .fill { background: #c57c14; }
    .kg {
      text-align: right;
      color: #149b6a;
      font-family: Arial, sans-serif;
      font-weight: 800;
      font-size: 13px;
    }
    .badge-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .badge {
      min-height: 78px;
      border-radius: 12px;
      padding: 12px 8px;
      text-align: center;
      background: #e7f7ef;
      border: 1px solid #d2efdf;
      color: #0d6843;
    }
    .badge.locked {
      background: #f1f1ed;
      border-color: #e4e2dc;
      color: #8c8a82;
      opacity: .92;
    }
    .badge .icon { font-size: 23px; line-height: 1.1; }
    .badge .name { margin-top: 6px; font-family: Arial, sans-serif; font-size: 12px; font-weight: 800; }
    .badge .detail { margin-top: 4px; font-size: 11px; line-height: 1.2; }
  </style>
</head>
<body>
  <section class="hero">
    <h1>Weekly Trends</h1>
    <p class="sub">${escapeHtml(getWeekRangeText(dayRows))}</p>
  </section>

  <section class="card total">
    <div class="value">${formatKg(trends.weekTotal)} kg CO2e</div>
    <p class="label">Weekly total from saved AI logs</p>
  </section>

  <section class="card">
    <h2>WEEKLY BAR GRAPH</h2>
    <div class="bars">
      ${dayRows.map((day) => weeklyBarHtml(day, maxDayTotal)).join("")}
    </div>
    <p class="legend">Green = under 3 kg/day · Orange = 3-9.9 kg · Red = 10+ kg</p>
  </section>

  <section class="card">
    <h2>BREAKDOWN BY CATEGORY</h2>
    ${categories.map((row) => categoryRowHtml(row, maxCategoryTotal)).join("")}
  </section>

  <section class="card">
    <h2>BADGES EARNED</h2>
    <div class="badge-grid">
      ${earnedBadges.map((badge) => badgeHtml(badge, false)).join("")}
    </div>
  </section>

  <section class="card">
    <h2>BADGES TO EARN</h2>
    <div class="badge-grid">
      ${lockedBadges.map((badge) => badgeHtml(badge, true)).join("")}
    </div>
  </section>
</body>
</html>`;
}

async function getWeeklyTrendData() {
  if (!firestore) {
    return { dayRows: [], categoryRows: [], weekTotal: 0, activeDays: 0, highTipCount: 0 };
  }

  const dates = getCurrentWeekDateIds();
  const dayRows = [];
  const allEntries = [];
  const categoryTotals = new Map();

  for (const dateInfo of dates) {
    const dayRef = firestore.collection("dailyLogs").doc(dateInfo.id);
    const daySnap = await dayRef.get();
    const entriesSnap = await dayRef.collection("entries").orderBy("createdAt", "asc").get();
    const entries = entriesSnap.docs.map((doc) => doc.data());
    const total = daySnap.exists
      ? Number(daySnap.data().dayTotalKg || 0)
      : roundToOne(entries.reduce((sum, entry) => sum + Number(entry.carbonKg || 0), 0));

    for (const entry of entries) {
      const category = entry.category || "Others";
      categoryTotals.set(category, roundToOne((categoryTotals.get(category) || 0) + Number(entry.carbonKg || 0)));
    }
    allEntries.push(...entries);

    dayRows.push({ ...dateInfo, total: roundToOne(total) });
  }

  const categoryRows = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, total]) => ({ category, total }));

  return {
    dayRows,
    categoryRows,
    weekTotal: roundToOne(dayRows.reduce((sum, day) => sum + day.total, 0)),
    activeDays: dayRows.filter((day) => day.total > 0).length,
    highTipCount: allEntries.filter((entry) => entry.impactLevel === "High" && entry.aiSuggestion).length
  };
}

function getTrendBadges(trends) {
  const earned = [];
  const locked = [];
  const badgeRules = [
    {
      name: "First Footprint",
      icon: "🌱",
      detail: "Logged your first carbon activity.",
      earned: trends.weekTotal > 0
    },
    {
      name: "Carbon Detective",
      icon: "🔎",
      detail: "Tracked 3 different categories.",
      earned: trends.categoryRows.length >= 3
    },
    {
      name: "Swap Seeker",
      icon: "💡",
      detail: "Unlocked an AI swap suggestion.",
      earned: trends.highTipCount > 0
    },
    {
      name: "Habit Builder",
      icon: "📅",
      detail: "Log activities on 3 days this week.",
      earned: trends.activeDays >= 3
    },
    {
      name: "Light Day",
      icon: "🍃",
      detail: "Keep one day at 3 kg CO2e or less.",
      earned: trends.dayRows.some((day) => day.total > 0 && day.total <= 3)
    },
    {
      name: "Category Master",
      icon: "🏅",
      detail: "Track 5 different categories.",
      earned: trends.categoryRows.length >= 5
    }
  ];

  for (const badge of badgeRules) {
    (badge.earned ? earned : locked).push(badge);
  }

  return {
    earned: earned.length ? earned : [{ name: "Start Logging", icon: "🌿", detail: "Log your first activity to earn badges." }],
    locked
  };
}

function weeklyBarHtml(day, maxDayTotal) {
  const total = Number(day.total || 0);
  const height = Math.max(total > 0 ? 8 : 3, Math.round((total / maxDayTotal) * 116));
  const impactClass = total >= 10 ? "high" : total >= 3 ? "medium" : "";
  return `
    <div>
      <div class="bar-wrap">
        <div class="bar ${impactClass}" style="height:${height}px"><span>${formatKg(total)}</span></div>
      </div>
      <div class="day">${escapeHtml(day.label)}</div>
    </div>`;
}

function categoryRowHtml(row, maxCategoryTotal) {
  const total = Number(row.total || 0);
  const width = Math.max(total > 0 ? 8 : 3, Math.round((total / maxCategoryTotal) * 100));
  return `
    <div class="cat-row">
      <div>${escapeHtml(row.category)}</div>
      <div class="track"><div class="fill" style="width:${width}%"></div></div>
      <div class="kg">${formatKg(total)} kg</div>
    </div>`;
}

function badgeHtml(badge, locked) {
  return `
    <div class="badge ${locked ? "locked" : ""}">
      <div class="icon">${escapeHtml(badge.icon)}</div>
      <div class="name">${locked ? "Locked: " : ""}${escapeHtml(badge.name)}</div>
      <div class="detail">${escapeHtml(badge.detail)}</div>
    </div>`;
}

function getWeekRangeText(dayRows) {
  if (!dayRows.length) {
    return "This week";
  }

  return `${dayRows[0].id} to ${dayRows[dayRows.length - 1].id}`;
}

function formatKg(value) {
  return String(roundToOne(Number(value || 0))).replace(/\.0$/, "");
}

async function getTodayEntries() {
  if (!firestore) {
    return { entries: [], dayTotalKg: 0 };
  }

  const dateId = formatDateId(new Date());
  const dayRef = firestore.collection("dailyLogs").doc(dateId);
  const daySnap = await dayRef.get();
  const entriesSnap = await dayRef.collection("entries").orderBy("createdAt", "asc").get();
  const entries = entriesSnap.docs.map((doc) => doc.data());
  const dayTotalKg = daySnap.exists
    ? Number(daySnap.data().dayTotalKg || 0)
    : roundToOne(entries.reduce((total, entry) => total + Number(entry.carbonKg || 0), 0));

  return { entries, dayTotalKg };
}

function emptyTodaySummary() {
  return [0, "No saved logs for today yet.", emptyTipsText(), "Others"];
}

function highImpactFallback(dayTotalKg) {
  const carKm = Math.max(1, Math.round(dayTotalKg * 4));
  return `High impact today. That's roughly like driving a petrol car for ${carKm} km.`;
}

function emptyTipsText() {
  return "No high-impact AI tips yet.\nLog a high-carbon activity and your personalized swap cards will appear here.";
}

function emptyWeeklyTrendsText() {
  return [
    "BADGES EARNED",
    "No badges earned yet.",
    "",
    "BADGES TO EARN",
    lockedBadgeText({ name: "First Footprint", detail: "Log your first activity." }),
    lockedBadgeText({ name: "Habit Builder", detail: "Log activities on 3 days this week." }),
    lockedBadgeText({ name: "Carbon Detective", detail: "Track 3 different categories." })
  ].join("\n");
}

function emptyWeeklyTrendsHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      margin: 0;
      padding: 24px 14px;
      background: #f3f8f4;
      color: #204e37;
      font-family: Arial, sans-serif;
    }
    .card {
      background: white;
      border: 1px solid #dfe8e1;
      border-radius: 14px;
      padding: 16px;
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0; line-height: 1.5; color: #5b7364; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Weekly Trends</h1>
    <p>No saved weekly data yet. Add a few logs and the chart will appear here.</p>
  </div>
</body>
</html>`;
}

function getCurrentWeekDateIds() {
  const todayId = formatDateId(new Date());
  const today = new Date(`${todayId}T00:00:00.000Z`);
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - mondayOffset + index);
    const id = date.toISOString().slice(0, 10);
    return { id, label: labels[date.getUTCDay()] };
  });
}

function getEarnedBadges({ allEntries, activeDays, dayRows, categoryTotals, highTipCount }) {
  const earned = [];
  const lowDay = dayRows.some((day) => day.total > 0 && day.total <= 3);

  if (allEntries.length >= 1) {
    earned.push({ name: "First Footprint", detail: "Logged your first carbon activity." });
  }
  if (activeDays >= 3) {
    earned.push({ name: "Habit Builder", detail: "Logged on 3 days this week." });
  }
  if (lowDay) {
    earned.push({ name: "Light Day", detail: "Kept one day at 3 kg CO2e or less." });
  }
  if (categoryTotals.size >= 3) {
    earned.push({ name: "Carbon Detective", detail: "Tracked 3 different categories." });
  }
  if (highTipCount >= 1) {
    earned.push({ name: "Swap Seeker", detail: "Unlocked an AI swap suggestion." });
  }

  return earned;
}

function getLockedBadges(earnedBadges) {
  const earnedNames = new Set(earnedBadges.map((badge) => badge.name));
  const allBadges = [
    { name: "First Footprint", detail: "Log your first carbon activity." },
    { name: "Habit Builder", detail: "Log activities on 3 days this week." },
    { name: "Light Day", detail: "Keep any day at 3 kg CO2e or less." },
    { name: "Carbon Detective", detail: "Track 3 different categories." },
    { name: "Swap Seeker", detail: "Create 1 high-impact AI tip." },
    { name: "Low Carbon Streak", detail: "Keep 3 logged days below 5 kg each." },
    { name: "Category Master", detail: "Track 5 different categories." }
  ];

  return allBadges.filter((badge) => !earnedNames.has(badge.name));
}

function categoryColor(category) {
  const colors = {
    Transport: "#DD4B39",
    Food: "#F59E0B",
    Energy: "#2563EB",
    Shopping: "#7C3AED",
    Waste: "#64748B",
    Others: "#168357"
  };
  return colors[category] || "#168357";
}

function safeChartLabel(value) {
  return String(value).replace(/,/g, " ").slice(0, 18);
}

function earnedBadgeText(badge) {
  return [
    `UNLOCKED BADGE: ${badge.name}`,
    `  ${badge.detail}`
  ].join("\n");
}

function lockedBadgeText(badge) {
  return [
    `LOCKED BADGE: ${badge.name}`,
    `  ${badge.detail}`
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  let winner = "";
  let winnerCount = 0;
  for (const [value, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = value;
      winnerCount = count;
    }
  }
  return winner;
}

function formatDateId(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function roundToOne(value) {
  return Math.round(value * 10) / 10;
}

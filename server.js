import { createServer } from "node:http";
import admin from "firebase-admin";

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
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
const trendImageCache = new Map();

const systemPrompt =
  "You estimate the carbon footprint of one personal activity. " +
  "Return strict JSON with keys: kilograms, category, explanation, activity, impactLevel, suggestion. " +
  "kilograms must be a number in kg CO2e. category must be one short label like Transport, Food, Energy, Shopping, Waste, or Mixed. " +
  "explanation must be under 140 characters. activity must be a short normalized activity label. " +
  "impactLevel must be either High or Low. Mark it High when kilograms is 3 or more. " +
  "suggestion must be a short practical lower-carbon swap when impactLevel is High. If impactLevel is Low, suggestion should be an empty string.";

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

  if (req.method === "GET" && requestUrl.pathname === "/weekly-trends-image") {
    try {
      const imageType = requestUrl.searchParams.get("type") === "category" ? "category" : "bar";
      const image = await getWeeklyTrendsImage(imageType);
      sendImage(res, 200, image);
    } catch (error) {
      console.error("Weekly trends image failed:", error);
      sendText(res, 500, "Trend image generation failed.");
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
      saveAiResultLater({
        inputType: inferInputType(activityText),
        activityText,
        aiResult
      });
      sendAiResult(res, aiResult);
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/analyze-image") {
      const { buffer, contentType } = await readBuffer(req);
      if (!buffer.length) {
        sendJson(res, 400, { error: "Image input is empty." });
        return;
      }

      const aiResult = await analyzeImage(buffer, contentType || "image/jpeg");
      saveAiResultLater({
        inputType: "scan",
        activityText: aiResult.activity,
        aiResult
      });
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

function sendImage(res, status, imageBuffer) {
  res.writeHead(status, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=600"
  });
  res.end(imageBuffer);
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
            text: "Look at the uploaded photo and estimate the carbon footprint of the main logged activity or purchase. Return JSON only."
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
  const impactLevel = kilograms >= 3 ? "High" : "Low";
  const suggestion = String(result.suggestion || "");

  return {
    kilograms,
    category: String(result.category || "Mixed"),
    explanation: String(result.explanation || "AI estimated the footprint from the provided input."),
    activity: String(result.activity || "AI activity"),
    impactLevel,
    suggestion: impactLevel === "High"
      ? (suggestion || "Choose a lower-carbon alternative for this activity.")
      : ""
  };
}

function inferInputType(activityText) {
  return /\b(spoke|said|voice)\b/i.test(activityText) ? "voice" : "type";
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
  const topSource = mostCommon(entries.map((entry) => entry.category).filter(Boolean)) || "Mixed";

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

    return [
      `<b>LOG ENTRY ${index + 1}</b>`,
      `<font color="#5B7364">Activity:</font> ${activity}`,
      `Carbon: <font color="${impactColor}"><b>${carbonKg} kg CO2e</b></font>`,
      `Impact: <font color="${impactColor}"><b>${impact}</b></font>`
    ].join("<br/>");
  });

  return rows.join("<br/><br/>------------------------------<br/><br/>");
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
    const category = entry.category || "Mixed";
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

async function getWeeklyTrendsImage(type) {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY for image generation.");
  }

  const trends = await getWeeklyTrendData();
  const cacheKey = JSON.stringify({
    type,
    days: trends.dayRows.map((day) => [day.id, day.total]),
    categories: trends.categoryRows
  });

  if (trendImageCache.has(cacheKey)) {
    return trendImageCache.get(cacheKey);
  }

  const prompt = type === "category"
    ? buildCategoryImagePrompt(trends)
    : buildBarGraphImagePrompt(trends);

  const image = await requestOpenAiImage(prompt);
  trendImageCache.set(cacheKey, image);
  return image;
}

async function getWeeklyTrendData() {
  if (!firestore) {
    return { dayRows: [], categoryRows: [], weekTotal: 0 };
  }

  const dates = getCurrentWeekDateIds();
  const dayRows = [];
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
      const category = entry.category || "Mixed";
      categoryTotals.set(category, roundToOne((categoryTotals.get(category) || 0) + Number(entry.carbonKg || 0)));
    }

    dayRows.push({ ...dateInfo, total: roundToOne(total) });
  }

  const categoryRows = [...categoryTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, total]) => ({ category, total }));

  return {
    dayRows,
    categoryRows,
    weekTotal: roundToOne(dayRows.reduce((sum, day) => sum + day.total, 0))
  };
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
  return [0, "No saved logs for today yet.", emptyTipsText(), "Mixed"];
}

function emptyTipsText() {
  return "No high-impact AI tips yet.\nLog a high-carbon activity and your personalized swap cards will appear here.";
}

function emptyWeeklyTrendsText() {
  return [
    "WEEKLY BAR GRAPH",
    "No weekly data yet.",
    "",
    "BREAKDOWN BY CATEGORY",
    "No category data yet.",
    "",
    "BADGES EARNED",
    "No badges earned yet.",
    "",
    "BADGES TO EARN",
    lockedBadgeText({ name: "First Footprint", detail: "Log your first activity." }),
    lockedBadgeText({ name: "Habit Builder", detail: "Log activities on 3 days this week." }),
    lockedBadgeText({ name: "Carbon Detective", detail: "Track 3 different categories." })
  ].join("\n");
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

function buildBarGraphImagePrompt({ dayRows, weekTotal }) {
  const data = dayRows.map((day) => `${day.label}: ${day.total} kg CO2e`).join(", ");
  return [
    "Create a polished mobile app dashboard image for an eco carbon tracker.",
    "The image must be a clean, attractive weekly bar graph card.",
    "Use a dark forest-green background, rounded white cards, green/orange/red bars, modern typography, and clear labels.",
    "Do not include tiny unreadable text. Make the bars and numbers large.",
    `Weekly total: ${weekTotal} kg CO2e.`,
    `Daily data: ${data}.`,
    "Portrait mobile ratio. No logos, no people, no extra UI buttons."
  ].join(" ");
}

function buildCategoryImagePrompt({ categoryRows }) {
  const data = categoryRows.length
    ? categoryRows.map((row) => `${row.category}: ${row.total} kg CO2e`).join(", ")
    : "No category data yet.";
  return [
    "Create a polished mobile app dashboard image for an eco carbon tracker.",
    "The image must show a category breakdown card with colorful horizontal bars or donut-style sections.",
    "Use a dark forest-green background, rounded white cards, and attractive category colors.",
    "Make category names and kg CO2e numbers large and readable.",
    `Category data: ${data}.`,
    "Portrait mobile ratio. No logos, no people, no extra UI buttons."
  ].join(" ");
}

async function requestOpenAiImage(prompt) {
  const response = await fetch(`${OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size: "1024x1024"
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Image response did not include b64_json.");
  }

  return Buffer.from(b64, "base64");
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

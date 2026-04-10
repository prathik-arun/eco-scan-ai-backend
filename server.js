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

function emptyTodaySummary() {
  return [0, "No saved logs for today yet.", emptyTipsText(), "Mixed"];
}

function emptyTipsText() {
  return "No high-impact AI tips yet.\nLog a high-carbon activity and your personalized swap cards will appear here.";
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

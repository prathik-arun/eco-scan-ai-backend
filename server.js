import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const systemPrompt =
  "You estimate the carbon footprint of one personal activity. " +
  "Return strict JSON with keys: kilograms, category, explanation, activity, impactLevel, suggestion. " +
  "kilograms must be a number in kg CO2e. category must be one short label like Transport, Food, Energy, Shopping, Waste, or Mixed. " +
  "explanation must be under 140 characters. activity must be a short normalized activity label. " +
  "impactLevel must be either High or Low. Mark it High when the footprint is meaningfully above a low-impact alternative for the same task. " +
  "suggestion must be a short practical swap. If impactLevel is Low, suggestion should be an empty string.";

const server = createServer(async (req, res) => {
  addCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!OPENAI_API_KEY) {
    sendJson(res, 503, { error: "Missing OPENAI_API_KEY on the backend." });
    return;
  }

  try {
    if (req.method === "POST" && req.url === "/analyze-text") {
      const textBody = (await readText(req)).trim();
      if (!textBody) {
        sendJson(res, 400, { error: "Text input is empty." });
        return;
      }

      const aiResult = await analyzeText(textBody);
      sendJson(res, 200, [
        aiResult.kilograms,
        aiResult.category,
        aiResult.explanation,
        aiResult.activity,
        aiResult.impactLevel,
        aiResult.suggestion
      ]);
      return;
    }

    if (req.method === "POST" && req.url === "/analyze-image") {
      const { buffer, contentType } = await readBuffer(req);
      if (!buffer.length) {
        sendJson(res, 400, { error: "Image input is empty." });
        return;
      }

      const aiResult = await analyzeImage(buffer, contentType || "image/jpeg");
      sendJson(res, 200, [
        aiResult.kilograms,
        aiResult.category,
        aiResult.explanation,
        aiResult.activity,
        aiResult.impactLevel,
        aiResult.suggestion
      ]);
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
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
        content:
          "Estimate the footprint for this activity and respond with JSON only: " +
          activityText
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
  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  const content = data?.choices?.[0]?.message?.content || "";
  return normalizeAiResult(extractJson(content));
}

async function analyzeImage(buffer, contentType) {
  const base64Image = buffer.toString("base64");
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
              "Look at the uploaded photo and estimate the carbon footprint of the main logged activity or purchase. Return JSON only."
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${contentType};base64,${base64Image}`
            }
          }
        ]
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
  return {
    kilograms: Number(result.kilograms || result.kg || 0),
    category: String(result.category || "Mixed"),
    explanation: String(result.explanation || "AI estimated the footprint from the provided input."),
    activity: String(result.activity || "AI activity"),
    impactLevel: String(result.impactLevel || inferImpactLevel(Number(result.kilograms || result.kg || 0))),
    suggestion: String(result.suggestion || "")
  };
}

function inferImpactLevel(kilograms) {
  return kilograms >= 3 ? "High" : "Low";
}

# EcoScan AI Carbon Backend

This backend is the bridge between MIT App Inventor and a real AI model.

## What it does

- `POST /analyze-text`
  - Accepts plain text from typed input or speech-to-text
  - Returns a JSON array in this exact order:
    - `[kilograms, category, explanation, activity]`

- `POST /analyze-image`
  - Accepts the raw photo file uploaded from MIT App Inventor
  - Uses a multimodal model to inspect the image
  - Returns the same JSON array shape

## Setup

1. In a terminal:

```bash
cd "/Users/prathik/Documents/New project/EcoScanAICarbonBackend"
export OPENAI_API_KEY="YOUR_KEY"
export OPENAI_MODEL="gpt-4.1-mini"
node server.js
```

2. Deploy this backend to a public URL.
   Render, Railway, Fly.io, or any Node host will work.

3. In MIT App Inventor, open the blocks for `Screen1` and change:

- `global apiBaseUrl`

from:

- `https://YOUR-BACKEND-URL`

to your deployed backend base URL, for example:

- `https://your-eco-backend.onrender.com`

## Notes

- `Voice` in the app already converts speech to text first, then sends that text to `/analyze-text`.
- `Scan` uploads the actual photo file to `/analyze-image`.
- If the AI backend URL is not set, the app will show an alert instead of pretending the AI is working.

export const runtime = "nodejs";

const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const MAX_TEXT = 500;

export async function POST(req: Request) {
  const key = process.env.XAI_API_KEY;
  if (!key) return Response.json({ error: "XAI_API_KEY not set" }, { status: 500 });

  let text: unknown;
  try {
    ({ text } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return Response.json({ error: "Expected non-empty `text`" }, { status: 400 });
  }

  const res = await fetch(XAI_TTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: text.trim().slice(0, MAX_TEXT),
      voice_id: "eve",
      language: "en",
      output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 },
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text();
    console.error("xAI TTS error", res.status, detail);
    return Response.json({ error: `xAI TTS ${res.status}` }, { status: 502 });
  }

  return new Response(res.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}

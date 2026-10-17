export const runtime = "nodejs";

const PERCEPTRON_URL = "https://api.perceptron.inc/v1/chat/completions";
const MAX_IMAGE_CHARS = 1_000_000;

const PROMPT =
  "You guide a blind pedestrian using their phone's forward-facing camera. " +
  "In one or two short sentences, state the most important obstacles, hazards, crossings, steps, " +
  "or open path directly ahead, with rough direction (left, ahead, right) and distance. " +
  "No preamble. If the path is clear, say 'Path clear.'";

export async function POST(req: Request) {
  const key = process.env.PERCEPTRON_API_KEY;
  if (!key) return Response.json({ error: "PERCEPTRON_API_KEY not set" }, { status: 500 });

  let image: unknown;
  try {
    ({ image } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof image !== "string" || !image.startsWith("data:image/jpeg;base64,")) {
    return Response.json({ error: "Expected a JPEG data URL in `image`" }, { status: 400 });
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return Response.json({ error: "Image too large" }, { status: 413 });
  }

  const res = await fetch(PERCEPTRON_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "perceptron-mk1.5",
      reasoning_effort: "none",
      max_completion_tokens: 80,
      temperature: 0.2,
      messages: [
        { role: "system", content: PROMPT },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image } },
            { type: "text", text: "What is ahead?" },
          ],
        },
      ],
    }),
    signal: req.signal,
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Perceptron error", res.status, detail);
    return Response.json({ error: `Perceptron ${res.status}` }, { status: 502 });
  }

  const data = await res.json();
  const text: string = (data?.choices?.[0]?.message?.content ?? "").trim();
  return Response.json({ text });
}

// Builds the Perceptron chat-completions request for one narration step.
// Shared by server.js and any offline evaluation script so both send the same thing.
// Deciding whether a reply is worth showing lives in public/filter.js (runs in the browser).

const MAX_SAID = 5;

const SYSTEM_PROMPT = `You are the eyes of a blind person walking with a phone camera pointed ahead.
Your words are their only warning, so speak only when it matters.

Focus on what is directly in front of them: the center of the frame and the ground they are about to walk on. Ignore things far away or at the edges of the frame, unless they are moving toward the person.

Report only, in this priority order:
1. Hazards: anything moving toward them quickly (cars, bikes, people); stairs; curbs and drop-offs; potholes and uneven ground; obstacles in the walking path at foot, body or head height.
2. Navigation cues: doors, crosswalks, intersections, elevators, turns in a hallway or path.
3. Large readable text: building names, room names or numbers, major signs. Quote the text exactly. Skip text you cannot read clearly.

Be certain:
- Report only what you clearly see. If you are unsure what something is, leave it out.
- Say "door" only when you see an actual door, or a narrow door-sized frame in a wall. Wide openings, archways, hallways, open areas and gaps between buildings are not doors; call them "opening" or "hallway" only if that helps them walk.

Style:
- At most 12 words, on one line. Short fragments, hazard first.
- Position as left, ahead or right. Add "close" when it is within about two steps.
- Never give distances or step counts, except for stairs.
- Stairs: always say whether they go up or down from where the person stands. Up: you see the vertical front face of each step rising toward you, and they would climb. Down: you see step tops and edges dropping away, with lower ground beyond, and they would descend.
- Stairs count: always include a cautious minimum. Count only step edges you can clearly see, and round down. If they are hard to count, give a lower round number such as 3 or 5. Saying too few is safer than too many.
- If a sign lists several rooms or names, give them in one alert, e.g. Sign: rooms 71A, 71B, 71F, arrow right.
- Ignore colors, decor, weather, lighting and anything else that doesn't help them walk safely.

"Already said" lists what you told the person recently. Report what in this frame is important and not already covered there. A different place with its own hazards, cues or text is new and must be reported. The same thing again, in other words or with a different stair count, is not new; except a hazard that is now close when it was not before.

If nothing new and important is visible, reply exactly: n/a

Examples:
Stairs going up ahead, at least 3 steps.
Bike approaching fast from the left.
Curb close ahead.
Door on right, sign reads "Room 214".
n/a`;

const isImageDataUrl = (v) => typeof v === 'string' && v.startsWith('data:image/');

// body: { image, prevImage?, prevDtMs?, said?: string[] }  ->  payload, or throws on bad input.
function buildPayload(body, model) {
  if (!isImageDataUrl(body.image)) throw new Error('Expected { image: "data:image/..." }');

  // Two frames as a short clip lets the model judge motion; fall back to a single image.
  const dt = Math.round(Number(body.prevDtMs));
  const clip = isImageDataUrl(body.prevImage) && dt > 0 && dt <= 10000;
  const media = clip
    ? { type: 'video_frames', video_frames: { frames: [
        { image_url: { url: body.prevImage }, timestamp_ms: 0 },
        { image_url: { url: body.image }, timestamp_ms: dt },
      ] } }
    : { type: 'image_url', image_url: { url: body.image } };

  const said = cleanSaid(body.said);
  const text = [
    clip && `These are two frames ${dt} ms apart; the last is now. Compare them to tell what is moving toward the person.`,
    said.length ? `Already said (oldest first):\n${said.map((s) => `- ${s}`).join('\n')}` : 'Already said: nothing yet.',
    said.length ? 'What is new and important now?' : 'What is important now?',
  ].filter(Boolean).join('\n\n');

  // `max_completion_tokens` is Perceptron's output cap (`max_tokens` is not in its schema).
  // Reasoning off: it adds latency and is not needed here. Low temperature cuts rewordings
  // of the same scene that would read as "new". Not streamed: replies are a few words.
  return {
    model,
    stream: false,
    reasoning_effort: 'none',
    temperature: 0.2,
    max_completion_tokens: 40,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [media, { type: 'text', text }] },
    ],
  };
}

function cleanSaid(said) {
  return (Array.isArray(said) ? said : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(-MAX_SAID)
    .map((s) => s.trim().slice(0, 200));
}

module.exports = { SYSTEM_PROMPT, MAX_SAID, buildPayload };

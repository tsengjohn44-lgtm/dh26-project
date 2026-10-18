// filter.js (repeat/n-a rules, stair count and label) and prompt.js (request payloads), in plain Node.
// No API calls. The cases are the ones AGENTS.md section 8 says must hold, plus label and refine rules.
const path = require('path');
const F = require(path.join(__dirname, '..', '..', 'public', 'filter.js'));
const P = require(path.join(__dirname, '..', '..', 'prompt.js'));
let pass = 0, total = 0; const check = (n, c, d) => { total++; pass += !!c; console.log(`${c ? '✓' : '✗'} ${n}${c ? '' : '   ' + d}`); };
const reason = (reply, said, opts) => F.classifyReply(reply, said, opts).reason;

// ---- classifyReply: n/a and repeats ----
check('"n/a" → n/a', reason('n/a', []) === 'n/a', reason('n/a', []));
check('"N/A." and "No change." → n/a', reason('N/A.', []) === 'n/a' && reason('No change.', []) === 'n/a', '');
check('empty reply → n/a', reason('   ', []) === 'n/a', reason('   ', []));
check('stairs up after stairs down → new', reason('Stairs up ahead, at least 5 steps.', ['Stairs down ahead, at least 10 steps.']) === 'new', '');
check('same stairs, different count → repeat', reason('Stairs going down ahead, at least 8 steps.', ['Stairs going down ahead, at least 6 steps.']) === 'repeat', '');
check('stairs became "close" → new', reason('Stairs going down close ahead, at least 6 steps.', ['Stairs going down ahead, at least 6 steps.']) === 'new', '');
check('Room 214 → Room 215 → new', reason('Door ahead, sign reads "Room 215".', ['Door ahead, sign reads "Room 214".']) === 'new', '');
check('"Curb ahead." after "Curb ahead, crosswalk beyond it." → repeat', reason('Curb ahead.', ['Curb ahead, crosswalk beyond it.']) === 'repeat', '');
check('surrounding quotes stripped', F.classifyReply('"Door ahead."', []).text === 'Door ahead.', F.classifyReply('"Door ahead."', []).text);
check('unrelated alert → new', reason('Crosswalk ahead.', ['Stairs going down ahead, at least 6 steps.']) === 'new', '');

// ---- stair count discount (× 0.75, floor, min 1) ----
check('cautiousStairCount: 3 → 2 steps', F.cautiousStairCount('Stairs going up ahead, at least 3 steps.') === 'Stairs going up ahead, at least 2 steps.', F.cautiousStairCount('Stairs going up ahead, at least 3 steps.'));
check('cautiousStairCount: 1 → 1 step (minimum, singular)', F.cautiousStairCount('Stairs up, at least 1 step.') === 'Stairs up, at least 1 step.', F.cautiousStairCount('Stairs up, at least 1 step.'));
check('cautiousStairCount: 2 → "1 step" (plural fixed)', /at least 1 step\.$/.test(F.cautiousStairCount('Stairs up, at least 2 steps.')), F.cautiousStairCount('Stairs up, at least 2 steps.'));
check('cautiousStairCount: non-stair text untouched', F.cautiousStairCount('Room 12 ahead.') === 'Room 12 ahead.', '');
check('classifyReply applies the discount to new alerts', F.classifyReply('Stairs going down ahead, at least 8 steps.', []).text.includes('at least 6 steps'), F.classifyReply('Stairs going down ahead, at least 8 steps.', []).text);

// ---- hazard labels ----
check('hazardLabel parses each label', ['Trip hazard: x', 'Drop-off: x', 'Head hazard: x', 'Moving hazard: x', 'Obstacle: x'].map(F.hazardLabel).join() === 'trip,drop,head,moving,obstacle', '');
check('hazardLabel: no label → null', F.hazardLabel('Door ahead.') === null, '');
check('fixStairLabel: stairs down labelled Trip hazard → Drop-off', F.fixStairLabel('Trip hazard: stairs going down ahead.') === 'Drop-off: stairs going down ahead.', F.fixStairLabel('Trip hazard: stairs going down ahead.'));
check('fixStairLabel: stairs up labelled Drop-off → Trip hazard', F.fixStairLabel('Drop-off: stairs going up ahead.') === 'Trip hazard: stairs going up ahead.', F.fixStairLabel('Drop-off: stairs going up ahead.'));
check('fixStairLabel: correct label untouched', F.fixStairLabel('Drop-off: stairs going down ahead.') === 'Drop-off: stairs going down ahead.', '');
check('fixStairLabel: unclear direction untouched', F.fixStairLabel('Trip hazard: stairs ahead.') === 'Trip hazard: stairs ahead.', '');
check('different hazards with the same label → new', reason('Trip hazard: step close ahead.', ['Trip hazard: curb close ahead.']) === 'new', '');
check('same labelled hazard again → repeat', reason('Trip hazard: curb close ahead.', ['Trip hazard: curb close ahead.']) === 'repeat', '');
check('escalation: label added to an earlier plain alert → new', reason('Trip hazard: curb close ahead.', ['Curb close ahead.']) === 'new', '');
check('bare label alert repeats only an equally bare one', reason('Trip hazard: step ahead.', ['Trip hazard: step ahead.']) === 'repeat' && reason('Trip hazard: step ahead.', ['Trip hazard: curb ahead.']) === 'new', '');

// ---- refine (slow reply in Fast + Low) ----
check('refine: new direction word → new (correction)', reason('Sign reads "Rooms 71A-71G", arrow right.', ['Sign reads "Rooms 71A-71G", arrow left.'], { refine: true }) === 'new', '');
check('refine: identical restatement → repeat', reason('Sign reads "Rooms 71A-71G", arrow left.', ['Sign reads "Rooms 71A-71G", arrow left.'], { refine: true }) === 'repeat', '');

// ---- viewChange ----
const img = (f) => Array.from({ length: 24 * 18 }, (_, i) => f(i % 24, Math.floor(i / 24)));
const grad = img((x, y) => x * 8 + y * 2);
check('viewChange: same image → 0', Math.abs(F.viewChange(grad, grad)) < 1e-9, F.viewChange(grad, grad));
check('viewChange: brighter copy (exposure) → ~0', F.viewChange(grad, grad.map((v) => v * 1.3 + 20)) < 0.01, F.viewChange(grad, grad.map((v) => v * 1.3 + 20)));
check('viewChange: unrelated pattern → > 0.5', F.viewChange(grad, img((x, y) => (y * 13 + x * x) % 97 * 2)) > 0.5, F.viewChange(grad, img((x, y) => (y * 13 + x * x) % 97 * 2)));
check('viewChange: two flat dark frames → same view (0)', F.viewChange(img(() => 5), img(() => 7)) === 0, '');
check('viewChange: flat vs patterned → 1', F.viewChange(img(() => 5), grad) === 1, '');

// ---- buildPayload ----
const IMG = 'data:image/jpeg;base64,AAAA';
const p0 = P.buildPayload({ image: IMG }, 'm');
check('payload: reasoning none, cap 40, temperature 0.2, not streamed', p0.reasoning_effort === 'none' && p0.max_completion_tokens === 40 && p0.temperature === 0.2 && p0.stream === false, JSON.stringify({ ...p0, messages: undefined }));
check('payload: no max_tokens field (not in Perceptron schema)', !('max_tokens' in p0), '');
const pl = P.buildPayload({ image: IMG, reasoning: 'low' }, 'm'), ph = P.buildPayload({ image: IMG, reasoning: 'high' }, 'm');
check('payload: low/high → budget 2048', pl.max_completion_tokens === P.REASONING_BUDGET && ph.max_completion_tokens === P.REASONING_BUDGET && P.REASONING_BUDGET === 2048, '');
check('payload: "think briefly" only for low', pl.messages[0].content.endsWith(P.BRIEF_REASONING) && !ph.messages[0].content.includes(P.BRIEF_REASONING), '');
check('payload: unknown reasoning → none', P.buildPayload({ image: IMG, reasoning: 'max' }, 'm').reasoning_effort === 'none', '');
check('payload: style classic → CLASSIC_PROMPT, default → SYSTEM_PROMPT', P.buildPayload({ image: IMG, style: 'classic' }, 'm').messages[0].content === P.CLASSIC_PROMPT && p0.messages[0].content === P.SYSTEM_PROMPT, '');
const said = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', '', 42];
const userText = P.buildPayload({ image: IMG, said }, 'm').messages[1].content[1].text;
check('payload: "Already said" keeps the last 5 valid alerts, oldest first', /- a2\n- a3\n- a4\n- a5\n- a6/.test(userText) && !userText.includes('- a1'), userText);
check('payload: nothing said → "Already said: nothing yet."', p0.messages[1].content[1].text.includes('Already said: nothing yet.'), '');
let threw = false; try { P.buildPayload({ image: 'http://x' }, 'm'); } catch { threw = true; }
check('payload: non-data-URL image → throws (server answers 400)', threw, '');

// ---- sensor paragraph ----
check('cleanSensor: valid reading rounded', JSON.stringify(P.cleanSensor({ distanceM: 0.4234, heightM: 1 })) === '{"d":0.42,"h":1}', JSON.stringify(P.cleanSensor({ distanceM: 0.4234, heightM: 1 })));
check('cleanSensor: out-of-bounds → null', [{ distanceM: 0.01, heightM: 1 }, { distanceM: 5, heightM: 1 }, { distanceM: 1, heightM: 4 }, null, 'x'].every((s) => P.cleanSensor(s) === null), '');
check('sensor paragraph added to the user message, never says to speak the number', P.buildPayload({ image: IMG, sensor: { distanceM: 0.6, heightM: 1 } }, 'm').messages[1].content[1].text.includes('Never say the distance'), '');
check('no sensor → no sensor paragraph', !p0.messages[1].content[1].text.includes('distance sensor'), '');

console.log(`${pass}/${total}`);

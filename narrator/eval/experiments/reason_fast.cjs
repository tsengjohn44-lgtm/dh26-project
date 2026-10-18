const fs = require('fs');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const imgs = process.argv.slice(4);
const med = (a) => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; };
const BRIEF = '\n\nThink briefly: at most 3 short sentences of reasoning, then answer.';
const variants = [
  ['low (current)', { effort: 'low', cap: 2048 }],
  ['low + "think briefly"', { effort: 'low', cap: 2048, brief: true }],
  ['low + brief + cap 400', { effort: 'low', cap: 400, brief: true }],
  ['high + "think briefly"', { effort: 'high', cap: 2048, brief: true }],
];
(async () => {
  for (const [label, v] of variants) {
    const ms = [], tok = []; let empty = 0; const answers = [];
    for (const f of imgs) for (let i = 0; i < 2; i++) {
      const p = buildPayload({ image: 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64'), reasoning: v.effort }, 'perceptron-mk1.5');
      p.max_completion_tokens = v.cap;
      if (v.brief) p.messages[0].content += BRIEF;
      const t0 = performance.now();
      const j = await (await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(p) })).json();
      ms.push(performance.now() - t0); tok.push(j.usage?.completion_tokens ?? 0);
      const c = j.choices?.[0]; if (!c?.message?.content) empty++;
      if (i === 0) answers.push(`${f.split('/').pop()}: ${c?.message?.content || `(empty, ${c?.finish_reason})`}`);
    }
    console.log(`== ${label}: median ${Math.round(med(ms))} ms, max ${Math.round(Math.max(...ms))} ms, median ${med(tok)} tokens (max ${Math.max(...tok)}), empty ${empty}/${ms.length}`);
    answers.forEach((a) => console.log('   ' + a.replace(/\n/g, ' ')));
  }
})();

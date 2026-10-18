const fs = require('fs');
const { buildPayload } = require(process.argv[2]);
const KEY = fs.readFileSync(process.argv[3], 'utf8').match(/PERCEPTRON_API_KEY\s*=\s*["']?([^"'\s]+)/)[1];
const imgs = process.argv.slice(4);
const med = (a) => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1]; };
(async () => {
  for (const effort of ['none', 'low', 'high']) {
    const ms = [], tok = []; let empty = 0;
    for (const f of imgs) for (let i = 0; i < 2; i++) {
      const p = buildPayload({ image: 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64') }, 'perceptron-mk1.5');
      p.reasoning_effort = effort; if (effort !== 'none') p.max_completion_tokens = 2048;
      const t0 = performance.now();
      const j = await (await fetch('https://api.perceptron.inc/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(p) })).json();
      ms.push(performance.now() - t0); tok.push(j.usage?.completion_tokens ?? 0);
      const c = j.choices?.[0];
      if (!c?.message?.content) empty++;
      if (i === 0) console.log(`  ${effort.padEnd(4)} ${f.split('/').pop().padEnd(18)} ${String(Math.round(ms.at(-1))).padStart(5)} ms  ${String(tok.at(-1)).padStart(4)} out-tokens  reasoning ${(c?.message?.reasoning_content || '').length} chars  → ${c?.message?.content}`);
    }
    console.log(`== ${effort}: median ${Math.round(med(ms))} ms, max ${Math.round(Math.max(...ms))} ms, median ${med(tok)} output tokens (max ${Math.max(...tok)}), empty answers ${empty}/${ms.length}\n`);
  }
})();

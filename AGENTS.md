# Notes for AI agents
Phone web app that describes surroundings aloud for blind users. DubHacks '26, Community Kitchen track.

## Stack
- Next.js (App Router) + TypeScript, mobile-first, deployed on Vercel (HTTPS needed for phone camera)
- Vision: Perceptron Mk1.5, https://api.perceptron.inc/v1/chat/completions (PERCEPTRON_API_KEY)
- Speech: xAI Grok TTS (XAI_API_KEY)
- Keys live only in .env.local and server routes (app/api/*). Never call these APIs from the browser.

## Commands
- Dev: npm run dev
- Check: npx tsc --noEmit && npm run lint
- Deploy: npx vercel --prod

## Conventions
- Spoken output: 1–2 short sentences, using left/right/ahead and rough distances.
- Accessibility first: one large tap target, screen-reader labels, nothing conveyed by color alone.
- Keep changes small. Ask before adding big dependencies.

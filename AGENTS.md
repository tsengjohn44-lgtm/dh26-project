# Notes for AI agents
Phone web app that describes surroundings aloud for blind users. DubHacks '26, Community Kitchen track.

## Stack
- Next.js (App Router) + TypeScript, mobile-first, deployed on Vercel (HTTPS needed for phone camera)
- Vision: Perceptron Mk1.5, https://api.perceptron.inc/v1/chat/completions (PERCEPTRON_API_KEY)
- Speech: xAI Grok TTS (XAI_API_KEY)
- Keys live only in .env.local and server routes (app/api/*). Never call these APIs from the browser.

## Commands
- Dev: npm run dev
- Phone on LAN: npm run dev:https (self-signed HTTPS so the camera works)
- Keys: copy .env.example to .env.local
- Check: npx tsc --noEmit && npm run lint
- Deploy: npx vercel --prod

## Conventions
- Spoken output: 1–2 short sentences, using left/right/ahead and rough distances.
- Accessibility first: one large tap target, screen-reader labels, nothing conveyed by color alone.
- Keep changes small. Ask before adding big dependencies.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

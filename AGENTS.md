# Notes for AI agents
- DubHacks '26 project. Stack: Next.js (App Router) + TypeScript. APIs: Perceptron Mk1.5 (vision), xAI Grok TTS.
- Keep changes small and focused. Ask before adding big dependencies.
- Never commit API keys. Keep them in .env.
- Run/test commands: `npm run dev` (localhost), `npm run dev:https` (phone on LAN; camera needs HTTPS), `npm run build` (type-check + build). Keys go in `.env.local` (see `.env.example`).

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

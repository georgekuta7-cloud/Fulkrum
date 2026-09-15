# Fulkrum

Fulkrum is a supervisor-style multi-agent workspace: you chat with the Head AI, approve a plan, and then route work to Scout and Forge.

After approval, the current worker slice runs Scout first, hands its findings to Forge, and then asks Head AI to prepare a review checkpoint. With no provider key configured this flow runs in explicit demo mode; with keys configured, each role uses its selected server-side provider.

## Run it

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`. `npm run dev` starts both the Vite UI and the local API bridge.

Run the backend safety checks with:

```powershell
npm test
npm run lint
npm run build
```

## Add provider APIs

Copy `.env.example` to `.env.local`, then add the keys for the providers you want to use:

```powershell
Copy-Item .env.example .env.local
```

Supported server-side keys:

- `XAI_API_KEY` for Grok
- `OPENAI_API_KEY` for OpenAI
- `ANTHROPIC_API_KEY` for Anthropic
- `GOOGLE_API_KEY` for Gemini
- `DEEPSEEK_API_KEY` for DeepSeek
- `GLM_API_KEY` or `ZAI_API_KEY` for GLM/Z.ai
- `KIMI_API_KEY` or `MOONSHOT_API_KEY` for Kimi/Moonshot

Custom OpenAI-compatible providers can be added or removed from **Workspace settings** in the control room. Fulkrum stores the provider definition locally, while the API key remains an environment variable on the server.

Restart `npm run dev` after changing `.env.local`. The routing drawer shows which providers are connected. When the selected provider has no key, Fulkrum stays usable in clearly labeled demo mode.

Runs, chat messages, provider definitions, and audit events are persisted locally in `data/fulkrum.sqlite` by default. Override the location with `FULKRUM_DB_PATH`.

Each run exposes a permission mode: `Guided` pauses consequential actions, `Selective` allows low-risk work while guarding risky actions, and `Autopilot` stays within the approved plan and configured boundaries. The server-side tool broker now provides workspace listing, file reads, text search, file writes, allowlisted shell commands, and HTTP requests. Every call is audited; blocked actions create an approval event and can be approved once from the control room.

Role routing is saved in the project settings and restored after refresh. The server also exposes `POST /api/providers/:id/test` for a non-chat provider connectivity check; it reports missing keys or upstream status without returning secrets.

API keys are read only by the server modules; they are never placed in the browser bundle or returned by the status endpoint.

import { stitch } from '@google/stitch-sdk'
import { writeFileSync } from 'fs'

const KEY = process.env.STITCH_API_KEY
if (!KEY) { console.error('Set STITCH_API_KEY'); process.exit(1) }

const prompts = [
  {
    name: 'chat-view',
    prompt: `A dark-themed AI agent orchestration dashboard called "Fulkrum". 
Layout: Fixed header bar at top with brand name, project path, spend counter ($0.42/$2.00), and settings icon.
Left sidebar (64px wide) with vertical icon navigation: Chat, Artifacts, Approvals, Settings. Green dot at bottom for daemon status.
Main content area with:
1. Pipeline tracker bar showing agent flow: Head AI (done, green check) → Scout (done, green dot) → Forge (active, pulsing purple dot, "Step 4/8") → Debugger (dimmed, queued). Connected by animated dashed lines. Right side shows plan hash #7f8a9e01 and progress 50%.
2. Agent switcher dock: Head AI (active, purple dot, "Sonnet 3.5"), Scout ("4o-mini"), Forge (green dot), + add button.
3. Chat stream (8 columns): User message bubble (right-aligned, rounded), Agent message with avatar (left-aligned), Plan card with checklist tasks (some done with strikethrough, one active with pulsing dot), Approval card with command preview and Approve/Deny buttons.
4. Right drawer (4 columns): "Active Artifacts" with tabs Diffs/Logs/Security, code diff viewer with green/red lines, telemetry accordion.
5. Floating prompt bar at bottom: "Steer: Head AI" dropdown, @ mention button, attach button, textarea placeholder "Direct Head AI...", voice button, purple send button.

Style: Dark mode (#09090b background), purple primary (#a78bfa), green tertiary (#34d399), Geist font, Material Design 3. Rounded corners, subtle shadows, glassmorphism header.`,
  },
  {
    name: 'ecosystem-view',
    prompt: `A dark-themed marketplace/ecosystem page called "Ecosystem & Blueprints" for an AI agent platform.
Layout: Same fixed header and sidebar as the chat view.
Main content:
1. Breadcrumb: Ecosystem / Blueprints & Tooling / Daemon Local
2. Title: "Ecosystem & Blueprints" with subtitle about curated agent team topologies.
3. Search bar with Ctrl+K hint and "Register Local Manifest" button.
4. Filter pills: All Items (34), Team Blueprints (12), Skill Packs (14), Sandbox Plugins (8). "Verified Only" toggle and sort dropdown.
5. Featured blueprint hero card: "Fullstack Autonomous Refactor Swarm" with badges (Featured, Signed, v2.4.0, SHA), 4-node topology pipeline (Head AI/Coordinator, Scout/AST, Forge/Synthesizer, Debugger/Test Runner), security ribbon (Network: None, FS Mount: ./src, Memory: 512MB, Seccomp: Strict), deployment specs sidebar with sparkline chart showing 99.4% success rate, "Apply Blueprint" and "Preview" buttons.
6. Manifest preview panel showing YAML code with syntax highlighting.
7. 3-column card grid: mix of Team Blueprints (with cast composition), Skill Packs (with included assets), Sandbox Plugins (with security info). Each has install/configure buttons.
8. Footer banner about local-first storage.

Style: Dark mode (#09090b), purple primary (#a78bfa), green tertiary (#34d399), Geist font, Material Design 3. Glassmorphism effects, subtle glows, rounded cards.`,
  },
  {
    name: 'settings-view',
    prompt: `A dark-themed settings drawer/panel for an AI agent platform called "Fulkrum".
Layout: Slide-in drawer from right side (580px wide) over dimmed backdrop.
Content sections with icons:
1. Storage: Database size (12.4 MB + 2.1 MB WAL), Backups (3, newest 2h ago), Anchors (12 in file), Retention (30 days), Last verify (intact). Buttons: "Verify audit log", "Back up now".
2. Execution: Docker engine status (v24.0.7), image pin status, running containers count.
3. Providers: List of AI providers (OpenAI, Anthropic, Google) with status dots, model names, key source (stored/env), test/edit/remove buttons. Add provider form with name, base URL, model, API key fields.
4. Settings groups: Bridge, Storage, Limits, Providers, Budgets, Skills & marketplace, Security. Each with toggle switches and input fields.
5. Standing grants: List of allowed tools with scope and usage count. Add grant form.
6. Learnings: List of facts learned from runs. Forget button per fact.
7. Spend: Total cost, calls, by-model breakdown table.
8. Appearance: Theme toggle (Dark/Light), keyboard shortcuts hint.

Style: Dark mode, purple primary (#a78bfa), Geist font, Material Design 3. Clean sections with dividers, monospace for values.`,
  },
]

async function main() {
  console.log('Creating Stitch project...')
  const project = await stitch.createProject('Fulkrum UI Design')
  console.log('Project:', project.id)

  for (const { name, prompt } of prompts) {
    console.log(`\nGenerating: ${name}...`)
    const screen = await project.generate(prompt)
    console.log(`  Screen ID: ${screen.id}`)
    
    const html = await screen.getHtml()
    const image = await screen.getImage()
    console.log(`  HTML: ${html}`)
    console.log(`  Image: ${image}`)
    
    // Fetch and save the HTML
    try {
      const res = await fetch(html)
      const text = await res.text()
      writeFileSync(`design-preview/stitch-${name}.html`, text)
      console.log(`  Saved: design-preview/stitch-${name}.html`)
    } catch (e) {
      console.log(`  Could not fetch HTML: ${e}`)
    }
  }

  console.log('\nDone! Screens saved to design-preview/')
}

main().catch((e) => { console.error(e); process.exit(1) })

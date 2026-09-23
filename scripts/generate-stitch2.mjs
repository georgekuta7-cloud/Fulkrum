import { stitch } from '@google/stitch-sdk'
import { writeFileSync } from 'fs'

const KEY = process.env.STITCH_API_KEY
if (!KEY) { console.error('Set STITCH_API_KEY'); process.exit(1) }

async function main() {
  const project = await stitch.createProject('Fulkrum Views')
  console.log('Project:', project.id)

  console.log('Generating ecosystem-view...')
  const s1 = await project.generate('Dark marketplace page for AI agent tools. Featured blueprint card with pipeline visualization. Grid of 3 cards for skills and plugins. Search bar and filter pills at top. Purple primary, dark background, modern UI.')
  console.log('Screen:', s1.id)
  const h1 = await s1.getHtml()
  const r1 = await fetch(h1)
  writeFileSync('design-preview/stitch-ecosystem-view.html', await r1.text())
  console.log('Saved ecosystem-view')

  console.log('Generating settings-view...')
  const s2 = await project.generate('Dark settings drawer panel with sections for Storage, Providers, and Spend. Clean list layout with toggle switches and buttons. Purple primary, dark background, modern UI.')
  console.log('Screen:', s2.id)
  const h2 = await s2.getHtml()
  const r2 = await fetch(h2)
  writeFileSync('design-preview/stitch-settings-view.html', await r2.text())
  console.log('Saved settings-view')

  console.log('Done!')
}

main().catch((e) => { console.error(e.message || e); process.exit(1) })

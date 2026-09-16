#!/usr/bin/env node
/**
 * Launcher: one process that serves the API and, when it has been built, the UI.
 *
 * This is what `npm start` runs, and what a linked install exposes as `fulkrum`.
 * The working directory is the workspace, the way `git` treats it: run it inside a
 * project and that project is what the agents may touch. The UI is served from the
 * install rather than from the working directory, so running it anywhere still
 * gives you the interface.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(packageRoot, 'server', 'index.mjs')
// A .env.local next to your project wins over one next to the code.
const envFile = [path.join(process.cwd(), '.env.local'), path.join(packageRoot, '.env.local')].find((candidate) => existsSync(candidate))

const env = { ...process.env }
if (!env.FULKRUM_SERVE_UI && existsSync(path.join(packageRoot, 'dist', 'index.html'))) {
  env.FULKRUM_SERVE_UI = '1'
  env.FULKRUM_DIST_DIR = env.FULKRUM_DIST_DIR || path.join(packageRoot, 'dist')
}
if (!env.FULKRUM_WORKSPACE_ROOT) env.FULKRUM_WORKSPACE_ROOT = process.cwd()

const child = spawn(process.execPath, [...(envFile ? [`--env-file=${envFile}`] : []), entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0))

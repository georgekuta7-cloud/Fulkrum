import { parseSetting, settingByName, settings as allSettings } from './config.mjs'

/**
 * Settings changed from inside the app.
 *
 * Every tunable used to live in the environment only: each change needed a
 * terminal and a restart. Values saved through the settings API live in the
 * database instead, and are written through to `process.env` for this process
 * — which is why every module must read its settings at use time, never cache
 * them at import. An explicitly set environment variable still wins over a
 * saved value, so operators and CI keep the final word; the API reports which
 * source each effective value came from.
 */

// What the process started with, before any live change. Source attribution
// compares against this: a value present at boot came from the operator.
const bootEnv = { ...process.env }

/**
 * Settings that only take effect at boot. Everything else applies the moment
 * it is saved. The restart set is deliberately conservative: the port and
 * origins the bridge already bound, the files it already opened, the
 * workspace its running agents stand in, and the sandbox already built.
 * Changing those under live work would be a new class of bug, not a feature.
 */
export const RESTART_REQUIRED = new Set([
  'FULKRUM_API_PORT',
  'FULKRUM_ALLOWED_ORIGINS',
  'FULKRUM_SERVE_UI',
  'FULKRUM_DIST_DIR',
  'FULKRUM_DB_PATH',
  'FULKRUM_DATA_DIR',
  'FULKRUM_WORKSPACE_ROOT',
  'FULKRUM_ANCHOR_FILE',
  'FULKRUM_WAL_AUTOCHECKPOINT',
  'FULKRUM_PRICE_FILE',
  'FULKRUM_CONTAINER_ENGINE',
  'FULKRUM_CONTAINER_CLI',
  'FULKRUM_RUNNER_IMAGE',
  'FULKRUM_RUNNER_USER',
  'FULKRUM_RUNNER_USERNS',
  'FULKRUM_RUNNER_NOFILE',
  'FULKRUM_CONTAINER_MEMORY',
  'FULKRUM_CONTAINER_CPUS',
  'FULKRUM_CONTAINER_PIDS',
  'FULKRUM_EXEC_TIMEOUT_MS',
  'FULKRUM_ENGINE_RETRY_MS',
])

const bootValue = (name) => {
  const raw = bootEnv[name]
  return raw !== undefined && String(raw).trim() !== '' ? String(raw) : null
}

function currentValue(name) {
  const raw = process.env[name]
  return raw !== undefined && String(raw).trim() !== '' ? String(raw) : null
}

function entryFor(store, setting) {
  const boot = bootValue(setting.name)
  const saved = store.getAppSetting(setting.name)
  const current = currentValue(setting.name)
  // The runtime value is whatever the process sees: a live change, a boot
  // variable, or a saved row, in that order. Attribution answers the
  // different question of who owns it: the operator (env at boot), the app
  // (a saved row), or nobody (a default).
  const raw = current ?? (saved ? saved.value : undefined)
  const parsed = raw === undefined ? { value: setting.default } : parseSetting(setting, raw)
  return {
    name: setting.name,
    group: setting.group,
    kind: setting.kind,
    description: setting.description,
    choices: setting.choices ?? null,
    default: setting.default,
    value: parsed.value,
    source: boot !== null ? 'env' : saved ? 'db' : current !== null ? 'env' : 'default',
    restartRequired: RESTART_REQUIRED.has(setting.name),
    problem: parsed.problem ?? null,
  }
}

/** Every known setting with its effective value, source, and restart flag. */
export function listSettings(store) {
  return allSettings.map((setting) => entryFor(store, setting))
}

/**
 * Save one setting: validate first, then persist and apply to this process.
 *
 * An environment variable set at boot always wins, so saving over one is
 * refused outright rather than creating a value that looks managed but never
 * takes effect. Unset it where it is set to hand control to the app.
 */
export function saveSetting(store, name, raw) {
  const setting = settingByName(name)
  if (!setting) throw new Error(`Unknown setting: ${name ?? '(missing)'}`)
  if (bootValue(name) !== null) {
    throw new Error(`${name} is set in the environment, which always wins. Unset it there to manage it from the app.`)
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return resetSetting(store, name)
  }
  const parsed = parseSetting(setting, String(raw))
  if (parsed.problem) throw new Error(parsed.problem)
  store.setAppSetting(name, String(raw).trim())
  process.env[name] = String(raw).trim()
  return entryFor(store, setting)
}

/** Forget a saved setting: the boot environment or the default takes over again. */
export function resetSetting(store, name) {
  const setting = settingByName(name)
  if (!setting) throw new Error(`Unknown setting: ${name ?? '(missing)'}`)
  store.deleteAppSetting(name)
  const boot = bootValue(name)
  if (boot !== null) process.env[name] = boot
  else delete process.env[name]
  return entryFor(store, setting)
}

/**
 * Apply saved values to a fresh process. Runs once at boot, before anything
 * that reads settings is constructed: a saved value only fills a variable the
 * environment left empty, so the environment always wins.
 */
/**
 * @param {any} store
 * @param {{ log?: (message: string) => void }} [options]
 */
export function applySavedSettings(store, { log = () => {} } = {}) {
  let applied = 0
  for (const { key, value } of store.listAppSettings()) {
    if (!settingByName(key)) {
      log(`[fulkrum] ignoring saved setting for unknown name: ${key}`)
      continue
    }
    if (bootValue(key) === null && (process.env[key] === undefined || String(process.env[key]).trim() === '')) {
      process.env[key] = value
      applied += 1
    }
  }
  return applied
}

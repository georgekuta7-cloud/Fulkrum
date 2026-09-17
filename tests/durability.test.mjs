import assert from 'node:assert/strict'
import { rm, utimes } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { backupIfStale, restoreBackup } from '../server/backup.mjs'
import { FulkrumStore } from '../server/store.mjs'
import { withTempDirectory } from './helpers.mjs'

test('a transaction refuses an async function instead of committing half of it', async () => {
  await withTempDirectory(async (directory) => {
    const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
    try {
      const project = store.createProject({ name: 'tx' })
      assert.throws(
        () => store.transaction(async () => {
          store.createRun({ projectId: project.id })
        }),
        /synchronous/,
        'async work must not slip past COMMIT',
      )
      assert.equal(store.listRuns({ projectId: project.id }).length, 0, 'the partial write is rolled back')
    } finally {
      store.close()
    }
  })
})

test('chain verification is cached by head, and any new event invalidates it', async () => {
  await withTempDirectory(async (directory) => {
    const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
    try {
      const project = store.createProject({ name: 'cache' })
      const run = store.createRun({ projectId: project.id })
      store.appendEvent({ runId: run.id, type: 'note.one', payload: {} })
      const first = store.verifyEventChain(run.id)
      const second = store.verifyEventChain(run.id)
      assert.equal(first.ok, true)
      assert.equal(second, first, 'an unchanged head returns the cached verdict, not a recompute')
      store.appendEvent({ runId: run.id, type: 'note.two', payload: {} })
      const third = store.verifyEventChain(run.id)
      assert.notEqual(third, first, 'a new head recomputes')
      assert.equal(third.ok, true)
      assert.equal(third.total, 2)
    } finally {
      store.close()
    }
  })
})

test('backups happen when stale, not when fresh, and never when disabled', async () => {
  await withTempDirectory(async (directory) => {
    const store = new FulkrumStore(path.join(directory, 'fulkrum.sqlite'))
    try {
      assert.equal(backupIfStale(store, { intervalHours: 0 }), null, 'zero disables backups')
      const first = backupIfStale(store, { intervalHours: 24 })
      assert.ok(first?.path, 'nothing backed up yet, so back up now')
      assert.equal(backupIfStale(store, { intervalHours: 24 }), null, 'a fresh copy is left alone')
      // Age the copy past the window: the next tick must back up again.
      const old = new Date(Date.now() - 25 * 3_600_000)
      await utimes(first.path, old, old)
      const second = backupIfStale(store, { intervalHours: 24 })
      assert.ok(second?.path, 'a stale copy is replaced')
      assert.notEqual(second.path, first.path)
    } finally {
      store.close()
    }
  })
})

test('a backup restores into place and verifies, and refusals hold', async () => {
  await withTempDirectory(async (directory) => {
    const liveDb = path.join(directory, 'live.sqlite')
    const store = new FulkrumStore(liveDb)
    const project = store.createProject({ name: 'restore me' })
    const run = store.createRun({ projectId: project.id })
    store.appendEvent({ runId: run.id, type: 'note.keep', payload: { n: 1 } })
    store.recordAuditCheckpoint(run.id, { source: 'test' })
    const copy = store.backup()
    assert.ok(copy.anchorPath, 'the fixture anchors so the round trip is honest')
    store.close()

    // The disaster: everything is gone.
    await rm(liveDb, { force: true })
    await rm(`${liveDb}-wal`, { force: true })
    await rm(`${liveDb}-shm`, { force: true })
    await rm(store.anchorFile, { force: true })

    const restored = restoreBackup({ backupPath: copy.path, anchorPath: copy.anchorPath, targetDbPath: liveDb, force: true })
    assert.equal(restored.result.ok, true, 'the restored chains verify')
    assert.equal(restored.result.runs, 1)

    const reopened = new FulkrumStore(liveDb)
    try {
      assert.equal(reopened.getProject(project.id).project.name, 'restore me')
    } finally {
      reopened.close()
    }

    // And the guards: no silent overwrites, no missing files.
    assert.throws(() => restoreBackup({ backupPath: copy.path, targetDbPath: liveDb }), /without --force/)
    assert.throws(() => restoreBackup({ backupPath: path.join(directory, 'nope.sqlite'), targetDbPath: path.join(directory, 'x.sqlite'), force: true }), /not found/)
  })
})

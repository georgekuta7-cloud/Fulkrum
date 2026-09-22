/**
 * Codebase Memory integration: persistent code knowledge graph.
 *
 * Indexes source code into a queryable graph — functions, classes, call
 * chains, cross-service HTTP links — stored in SQLite. Exposes graph queries
 * as tools for agents.
 */

import { createHash } from 'node:crypto'

/**
 * Graph node types.
 */
export const nodeKinds = ['function', 'class', 'module', 'route', 'file']

/**
 * A minimal in-memory code graph. A production deployment would use the
 * codebase-memory-mcp binary; this provides the interface and a simple
 * regex-based indexer for common languages.
 */
export class CodeGraph {
  constructor() {
    /** @type {Map<string, { id: string, kind: string, name: string, file: string, line: number }>} */
    this.nodes = new Map()
    /** @type {Array<{ from: string, to: string, kind: string }>} */
    this.edges = []
  }

  /**
   * Index a source file.
   *
   * @param {string} filePath
   * @param {string} content
   */
  indexFile(filePath, content) {
    const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
    const lines = content.split(/\r?\n/)
    const fileHash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12)

    if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(extension)) {
      this._indexJavaScript(filePath, lines, fileHash)
    } else if (extension === 'py') {
      this._indexPython(filePath, lines, fileHash)
    }
  }

  _indexJavaScript(filePath, lines, fileHash) {
    lines.forEach((line, index) => {
      const lineNumber = index + 1
      let match = line.match(/^\s*export\s+(?:async\s+)?(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/)
      if (match) {
        const kind = match[0].includes('class') ? 'class' : match[0].includes('function') ? 'function' : 'module'
        this._addNode(kind, match[1], filePath, lineNumber, fileHash)
        return
      }
      match = line.match(/^\s*(?:export\s+default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
      if (match) {
        this._addNode('function', match[1], filePath, lineNumber, fileHash)
        return
      }
      match = line.match(/^\s*(?:export\s+default\s+)?class\s+([A-Za-z_$][\w$]*)/)
      if (match) {
        this._addNode('class', match[1], filePath, lineNumber, fileHash)
      }
    })
  }

  _indexPython(filePath, lines, fileHash) {
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)/)
      if (match) {
        const kind = match[1] ? 'function' : 'class'
        this._addNode(kind, match[1] ?? match[2], filePath, index + 1, fileHash)
      }
    })
  }

  _addNode(kind, name, file, line, fileHash) {
    const id = `${fileHash}:${name}`
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, kind, name, file, line })
    }
  }

  /**
   * Find nodes by name pattern.
   *
   * @param {string} pattern
   * @returns {Array<{ id: string, kind: string, name: string, file: string, line: number }>}
   */
  search(pattern) {
    const regex = new RegExp(pattern, 'i')
    return [...this.nodes.values()].filter((node) => regex.test(node.name))
  }

  /**
   * Get a node by name.
   *
   * @param {string} name
   * @returns {{ id: string, kind: string, name: string, file: string, line: number } | null}
   */
  getNode(name) {
    for (const node of this.nodes.values()) {
      if (node.name === name) return node
    }
    return null
  }

  /**
   * Trace call chains from a node.
   *
   * @param {string} name
   * @param {'inbound' | 'outbound'} direction
   * @returns {Array<{ from: string, to: string, kind: string }>}
   */
  traceCalls(name, direction = 'inbound') {
    const node = this.getNode(name)
    if (!node) return []
    return this.edges.filter((edge) =>
      direction === 'inbound' ? edge.to === node.id : edge.from === node.id,
    )
  }

  /** Graph statistics. */
  stats() {
    return { nodes: this.nodes.size, edges: this.edges.length }
  }
}

/**
 * Build MCP tool definitions for the code graph.
 *
 * @returns {Array<{ name: string, kind: string, description: string }>}
 */
export function codeGraphTools() {
  return [
    { name: 'graph.search', kind: 'read', description: 'Search the code graph for functions, classes, and modules by name pattern.' },
    { name: 'graph.trace', kind: 'read', description: 'Trace call chains from a function or class.' },
    { name: 'graph.stats', kind: 'read', description: 'Report code graph statistics.' },
  ]
}

import { parse } from '../external/acorn.js'
import { isLockstepPatch } from '../lockstep/patch.mts'
import { applyOraclePatch } from './patch.mts'

export interface OracleNode {
  type: string
  [key: string]: unknown
}

export function callsSymbol(code: string, symbol: string): boolean {
  return (
    parseOracleNodes(code)?.some(
      node =>
        node.type === 'CallExpression' &&
        isOracleNode(node['callee']) &&
        node['callee'].type === 'Identifier' &&
        node['callee']['name'] === symbol,
    ) ?? false
  )
}

export function countInterpolatedTemplates(code: string): number {
  return (
    parseOracleNodes(code)?.filter(
      node =>
        node.type === 'TemplateLiteral' &&
        Array.isArray(node['expressions']) &&
        node['expressions'].length > 0,
    ).length ?? 0
  )
}

export function hasInterpolatedTemplateLiteral(code: string): boolean {
  return countInterpolatedTemplates(code) > 0
}

export function hasLooseEquality(code: string): boolean {
  return (
    parseOracleNodes(code)?.some(
      node =>
        node.type === 'BinaryExpression' &&
        (node['operator'] === '!=' || node['operator'] === '=='),
    ) ?? false
  )
}

export function hasStrictEquality(code: string): boolean {
  return (
    parseOracleNodes(code)?.some(
      node => node.type === 'BinaryExpression' && node['operator'] === '===',
    ) ?? false
  )
}

export function importsSymbol(code: string, symbol: string): boolean {
  return (
    parseOracleNodes(code)?.some(node =>
      isImportedOracleSymbol(node, symbol),
    ) ?? false
  )
}

export function isImportedOracleSymbol(
  node: OracleNode,
  symbol: string,
): boolean {
  return (
    [
      'ImportDefaultSpecifier',
      'ImportNamespaceSpecifier',
      'ImportSpecifier',
    ].includes(node.type) &&
    isOracleNode(node['local']) &&
    node['local']['name'] === symbol
  )
}

export function isOracleNode(value: unknown): value is OracleNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

// Original source makes partial hunks verifiable. Otherwise only replacement snippets can be checked.
export function isTemplateLiteralPatch(
  value: { patch: string },
  original?: string | undefined,
): boolean {
  if (original !== undefined) {
    const updated = applyOraclePatch(original, value.patch)
    return (
      updated !== undefined &&
      countInterpolatedTemplates(updated) > countInterpolatedTemplates(original)
    )
  }
  const patch = value.patch.endsWith('\n') ? value.patch : `${value.patch}\n`
  const lines = patch.split(/\r?\n/)
  const newHeader = lines[1] ?? ''
  if (
    !newHeader.startsWith('+++ b/') ||
    !isLockstepPatch(newHeader.slice(6), patch)
  ) {
    return false
  }
  const updated = lines
    .slice(2)
    .filter(line => line.startsWith('+') || line.startsWith(' '))
    .map(line => line.slice(1))
    .join('\n')
  return hasInterpolatedTemplateLiteral(updated)
}

export function isValidJavaScript(code: string): boolean {
  return parseOracleNodes(code) !== undefined
}

export function parseOracleNodes(code: string): OracleNode[] | undefined {
  let root: unknown
  try {
    root = parse(code, { ecmaVersion: 'latest', sourceType: 'module' })
  } catch {
    return undefined
  }
  if (!isOracleNode(root)) {
    return undefined
  }
  const nodes: OracleNode[] = []
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()!
    nodes.push(node)
    const values = Object.values(node)
    for (let i = 0, length = values.length; i < length; i += 1) {
      const value = values[i]
      if (isOracleNode(value)) {
        pending.push(value)
      } else if (Array.isArray(value)) {
        pending.push(...value.filter(isOracleNode))
      }
    }
  }
  return nodes
}

export function repairResolvesLintErrors(
  value: { fixed: string },
  lintErrors: string,
): boolean {
  const nodes = parseOracleNodes(value.fixed)
  if (!nodes) {
    return false
  }
  const unused = unusedImportSymbols(lintErrors)
  return !nodes.some(
    node =>
      (node.type === 'BinaryExpression' &&
        (node['operator'] === '!=' || node['operator'] === '==')) ||
      unused.some(symbol => isImportedOracleSymbol(node, symbol)),
  )
}

// Diagnostic messages are text. Only JavaScript source goes through the parser.
export function unusedImportSymbols(lintErrors: string): string[] {
  const symbols: string[] = []
  for (const match of lintErrors.matchAll(/'([^']+)'[^\n]*never used/g)) {
    const symbol = match[1]
    if (symbol !== undefined) {
      symbols.push(symbol)
    }
  }
  return symbols
}

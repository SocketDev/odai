/**
 * @file General verify oracles for the generate-and-verify code-generation
 *   scenarios. Each oracle is deliberately broader than the scenario rubric it
 *   backs: the rubric scores one exact answer, the oracle accepts any answer of
 *   the right SHAPE so the verify loop keeps a well-formed generation rather
 *   than a memorized string.
 */

export function hasBalancedBraces(code: string): boolean {
  let depth = 0
  for (let i = 0, { length } = code; i < length; i += 1) {
    const char = code[i]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth < 0) {
        return false
      }
    }
  }
  return depth === 0
}

export function hasLooseEquality(code: string): boolean {
  return /(?<![=!])==(?!=)/.test(code) || /!=(?!=)/.test(code)
}

export function importsSymbol(code: string, symbol: string): boolean {
  const escaped = symbol.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')
  return new RegExp(`import[^\\n]*\\b${escaped}\\b`).test(code)
}

/**
 * A well-formed unified diff (an `@@` hunk header plus `+`/`-` lines) whose
 * added lines introduce a template literal (a backtick followed by a `${`
 * interpolation).
 */
export function isTemplateLiteralPatch(value: { patch: string }): boolean {
  const lines = value.patch.split('\n')
  const hasHunkHeader = lines.some(line => line.includes('@@'))
  const hasAdditionLine = lines.some(line => line.startsWith('+'))
  const hasRemovalLine = lines.some(line => line.startsWith('-'))
  const addedTemplateLiteral = lines.some(line => {
    if (!line.startsWith('+')) {
      return false
    }
    const backtick = line.indexOf('`')
    return backtick !== -1 && line.indexOf('${', backtick) !== -1
  })
  return (
    hasHunkHeader && hasAdditionLine && hasRemovalLine && addedTemplateLiteral
  )
}

/**
 * Confirm the reported lint errors are resolved generally — derived from the
 * lint-error text, not the scenario asserts: the fixed source has balanced
 * braces, uses no loose `==`/`!=`, and no longer imports any symbol the lint
 * errors flagged as an unused import.
 */
export function repairResolvesLintErrors(
  value: { fixed: string },
  lintErrors: string,
): boolean {
  const { fixed } = value
  if (!hasBalancedBraces(fixed)) {
    return false
  }
  if (hasLooseEquality(fixed)) {
    return false
  }
  for (const symbol of unusedImportSymbols(lintErrors)) {
    if (importsSymbol(fixed, symbol)) {
      return false
    }
  }
  return true
}

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

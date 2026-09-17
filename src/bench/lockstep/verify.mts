import type { LockstepAnalysis, LockstepInput } from '../../lockstep/schema.mts'
import { validateLockstepAnalysis } from '../../lockstep/validate.mts'
import { applyOraclePatch } from '../patch.mts'
import { isOracleNode, parseOracleNodes } from '../verify-oracles.mts'
import type { OracleNode } from '../verify-oracles.mts'

export function isLockstepCall(
  value: unknown,
  count: number,
): value is OracleNode & { arguments: unknown[] } {
  return (
    isOracleNode(value) &&
    value.type === 'CallExpression' &&
    Array.isArray(value['arguments']) &&
    value['arguments'].length === count
  )
}

export function lockstepAssertion(
  statement: unknown,
  value: string,
  expect: string,
  expected: number,
): boolean {
  if (!isOracleNode(statement) || statement.type !== 'ExpressionStatement') {
    return false
  }
  const call = statement['expression']
  if (
    !isLockstepCall(call, 1) ||
    !lockstepLiteral(call['arguments'][0], expected)
  ) {
    return false
  }
  const member = call['callee']
  if (
    !isOracleNode(member) ||
    member.type !== 'MemberExpression' ||
    member['computed'] !== false ||
    !lockstepIdentifier(member['property'], 'toBe')
  ) {
    return false
  }
  const assertion = member['object']
  return (
    isLockstepCall(assertion, 1) &&
    lockstepIdentifier(assertion['callee'], expect) &&
    lockstepIdentifier(assertion['arguments'][0], value)
  )
}

export function lockstepExportValue(
  body: OracleNode[],
  expected: number,
): boolean {
  if (body.length !== 1 || body[0]?.type !== 'ExportNamedDeclaration') {
    return false
  }
  const declaration = body[0]['declaration']
  if (
    !isOracleNode(declaration) ||
    declaration.type !== 'VariableDeclaration' ||
    declaration['kind'] !== 'const' ||
    !Array.isArray(declaration['declarations']) ||
    declaration['declarations'].length !== 1
  ) {
    return false
  }
  const binding: unknown = declaration['declarations'][0]
  return (
    isOracleNode(binding) &&
    lockstepIdentifier(binding['id'], 'value') &&
    lockstepLiteral(binding['init'], expected)
  )
}

export function lockstepIdentifier(value: unknown, name: string): boolean {
  return (
    isOracleNode(value) && value.type === 'Identifier' && value['name'] === name
  )
}

export function lockstepImportedName(
  body: OracleNode[],
  source: string,
  imported: string,
): string | undefined {
  for (let index = 0, length = body.length; index < length; index += 1) {
    const node = body[index]!
    if (
      node.type !== 'ImportDeclaration' ||
      !lockstepLiteral(node['source'], source) ||
      !Array.isArray(node['specifiers'])
    ) {
      continue
    }
    for (const specifier of node['specifiers']) {
      if (
        isOracleNode(specifier) &&
        specifier.type === 'ImportSpecifier' &&
        lockstepIdentifier(specifier['imported'], imported) &&
        isOracleNode(specifier['local']) &&
        typeof specifier['local']['name'] === 'string'
      ) {
        return specifier['local']['name']
      }
    }
  }
  return undefined
}

export function lockstepLiteral(value: unknown, expected: unknown): boolean {
  return (
    isOracleNode(value) &&
    value.type === 'Literal' &&
    value['value'] === expected
  )
}

export function lockstepProgram(code: string): OracleNode[] | undefined {
  const program = parseOracleNodes(code)?.find(node => node.type === 'Program')
  const body = program?.['body']
  return Array.isArray(body) && body.every(isOracleNode) ? body : undefined
}

export function lockstepRegression(
  body: OracleNode[],
  expected: number,
): boolean {
  const value = lockstepImportedName(
    body,
    '../../src/parser/value.mts',
    'value',
  )
  const expect = lockstepImportedName(body, 'vitest', 'expect')
  const test = lockstepImportedName(body, 'vitest', 'test')
  if (!value || !expect || !test) {
    return false
  }
  let assertions = 0
  for (let index = 0, length = body.length; index < length; index += 1) {
    const statement = body[index]!
    if (statement.type === 'ImportDeclaration') {
      continue
    }
    const statements = lockstepTestStatements(statement, test)
    if (
      !statements ||
      !statements.every(item =>
        lockstepAssertion(item, value, expect, expected),
      )
    ) {
      return false
    }
    assertions += statements.length
  }
  return assertions > 0
}

export function lockstepTestStatements(
  statement: OracleNode,
  test: string,
): unknown[] | undefined {
  if (statement.type !== 'ExpressionStatement') {
    return undefined
  }
  const call = statement['expression']
  if (
    !isOracleNode(call) ||
    call.type !== 'CallExpression' ||
    !lockstepIdentifier(call['callee'], test) ||
    !Array.isArray(call['arguments']) ||
    call['arguments'].length !== 2
  ) {
    return undefined
  }
  const callback: unknown = call['arguments'][1]
  if (
    !isOracleNode(callback) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(
      callback.type,
    ) ||
    !Array.isArray(callback['params']) ||
    callback['params'].length !== 0 ||
    callback['generator'] === true ||
    !isOracleNode(callback['body'])
  ) {
    return undefined
  }
  const statements: unknown = callback['body']['body']
  return Array.isArray(statements) ? statements : undefined
}

export function verifyLockstepEvaluation(
  input: LockstepInput,
  analysis: LockstepAnalysis,
): boolean {
  const validated = validateLockstepAnalysis(input, analysis)
  if (validated.verdict !== 'port' || validated.patches.length !== 2) {
    return false
  }
  return (['local', 'test'] as const).every(side => {
    const evidence = input.evidence.find(item => item.side === side)
    const patch = validated.patches.find(item => item.path === evidence?.path)
    const expectedPath =
      side === 'local' ? 'src/parser/value.mts' : 'test/parser/value.test.mts'
    if (
      !evidence ||
      !patch ||
      evidence.path !== expectedPath ||
      evidence.startLine !== 1
    ) {
      return false
    }
    const changed = applyOraclePatch(evidence.text, patch.patch)
    const body = changed === undefined ? undefined : lockstepProgram(changed)
    return (
      body !== undefined &&
      (side === 'local'
        ? lockstepExportValue(body, 8)
        : lockstepRegression(body, 8))
    )
  })
}

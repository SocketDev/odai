import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'

import type {
  KevDecisionRequest,
  KevModelCard,
  KevQuestion,
  KevResponse,
} from '../kev.mts'

const MAX_OPTIONS = 255

export function assertProbability(
  value: unknown,
  label: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new TypeError(`Kev ${label} must be a finite number from 0 to 1.`)
  }
}

export function assertSameKeys(expected: string[], actual: string[]): void {
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    throw new TypeError('Kev answer keys do not match the requested options.')
  }
}

export function parseDecision(
  value: unknown,
  question: KevQuestion,
): KevDecision {
  if (!isPlainObject(value) || value['type'] !== question.type) {
    throw new TypeError('Kev answer type does not match its question.')
  }
  if (question.type === 'noul') {
    assertProbability(value['noul'], 'noul')
    return { noul: value['noul'], type: 'noul' }
  }
  const probabilities = parseDistribution(value['probabilities'])
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria)
    assertSameKeys(keys, Object.keys(probabilities))
    const choice = value['choice']
    if (typeof choice !== 'string' || !keys.includes(choice)) {
      throw new TypeError('Kev choice must match one requested option.')
    }
    const highestProbability = keys.reduce((best, key) =>
      (probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best,
    )
    if (choice !== highestProbability) {
      throw new TypeError('Kev choice does not match its highest probability.')
    }
    assertProbability(value['confidence'], 'confidence')
    return {
      choice,
      confidence: value['confidence'],
      probabilities,
      type: 'choice',
    }
  }
  const keys = question.criteria.map((_criterion, index) => String(index))
  assertSameKeys(keys, Object.keys(probabilities))
  if (
    typeof value['score'] !== 'number' ||
    value['score'] < 0 ||
    value['score'] > keys.length - 1 ||
    Math.abs(
      value['score'] -
        keys.reduce(
          (total, key, index) => total + index * (probabilities[key] ?? 0),
          0,
        ),
    ) >= 0.02
  ) {
    throw new TypeError(
      'Kev score is outside the requested range or does not match its probabilities.',
    )
  }
  assertProbability(value['confidence'], 'confidence')
  if (!isPlainObject(value['legend'])) {
    throw new TypeError('Kev score answer must contain a legend object.')
  }
  const legend: Record<string, string> = Object.create(null)
  for (const [key, label] of Object.entries(value['legend'])) {
    if (typeof label !== 'string') {
      throw new TypeError('Kev score legend values must be strings.')
    }
    legend[key] = label
  }
  assertSameKeys(keys, Object.keys(legend))
  return {
    confidence: value['confidence'],
    legend,
    probabilities,
    score: value['score'],
    type: 'score',
  }
}

export function parseDistribution(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) {
    throw new TypeError('Kev answer probabilities must be an object.')
  }
  const result: Record<string, number> = Object.create(null)
  let total = 0
  for (const [key, probability] of Object.entries(value)) {
    assertProbability(probability, `probability "${key}"`)
    result[key] = probability
    total += probability
  }
  if (Object.keys(result).length === 0 || Math.abs(total - 1) >= 0.02) {
    throw new TypeError('Kev answer probabilities must sum to 1 within 0.02.')
  }
  return result
}

export function parseKevResponse(
  value: unknown,
  questions: KevDecisionRequest['questions'],
): KevResponse {
  if (!isPlainObject(value) || !isPlainObject(value['answers'])) {
    throw new TypeError('Kev response must contain an answers object.')
  }
  const answerEntries = Object.entries(value['answers'])
  if (
    answerEntries.length !== Object.keys(questions).length ||
    answerEntries.some(([name]) => !Object.hasOwn(questions, name))
  ) {
    throw new TypeError('Kev response question names do not match the request.')
  }
  const answers: KevResponse['answers'] = Object.create(null)
  for (const [name, answer] of answerEntries) {
    const question = questions[name]
    if (question === undefined) {
      throw new TypeError(
        'Kev response question names do not match the request.',
      )
    }
    answers[name] = parseDecision(answer, question)
  }
  if (typeof value['model'] !== 'string') {
    throw new TypeError('Kev response model must be a string.')
  }
  return {
    __proto__: null,
    answers,
    model: value['model'],
    truncated: value['truncated'] === true,
  }
}

export function parseModelCards(value: unknown): KevModelCard[] {
  if (!isPlainObject(value) || !Array.isArray(value['models'])) {
    throw new TypeError('Kev model response must contain a models array.')
  }
  return value['models'].map((card: unknown) => {
    if (
      !isPlainObject(card) ||
      typeof card['name'] !== 'string' ||
      typeof card['run'] !== 'string' ||
      typeof card['base'] !== 'string' ||
      typeof card['device'] !== 'string' ||
      typeof card['backend'] !== 'string' ||
      typeof card['dtype'] !== 'string' ||
      typeof card['temperature'] !== 'number' ||
      !Number.isFinite(card['temperature']) ||
      card['temperature'] <= 0
    ) {
      throw new TypeError(
        'Kev model card has an invalid identity or runtime field.',
      )
    }
    return {
      __proto__: null,
      base: card['base'],
      backend: card['backend'],
      device: card['device'],
      dtype: card['dtype'],
      name: card['name'],
      run: card['run'],
      temperature: card['temperature'],
    }
  })
}

export function validateDecisionRequest(request: KevDecisionRequest): void {
  if (
    !isPlainObject(request) ||
    !('state' in request) ||
    !isPlainObject(request.questions)
  ) {
    throw new TypeError(
      'Kev request needs a JSON state and a questions object.',
    )
  }
  const entries = Object.entries(request.questions)
  if (entries.length === 0) {
    throw new RangeError('Kev request needs at least one question.')
  }
  for (const [name, question] of entries) {
    validateQuestion(name, question)
  }

  function validateQuestion(name: string, question: unknown): void {
    if (name.trim() === '' || !isPlainObject(question)) {
      throw new TypeError(
        'Kev question names must be non-empty and questions must be objects.',
      )
    }
    const type = question['type']
    if (type !== 'choice' && type !== 'noul' && type !== 'score') {
      throw new TypeError(`Kev question "${name}" has an unsupported type.`)
    }
    const criteria = question['criteria']
    const count =
      type === 'noul'
        ? 2
        : Array.isArray(criteria)
          ? criteria.length
          : isPlainObject(criteria)
            ? Object.keys(criteria).length
            : 0
    if (count < 1 || count > MAX_OPTIONS) {
      throw new RangeError(
        `Kev question "${name}" needs between 1 and ${MAX_OPTIONS} options.`,
      )
    }
  }
}

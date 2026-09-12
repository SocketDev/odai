import process from 'node:process'

export function getCacheArgs(): string[] {
  return process.argv.slice(2).filter(argument => argument !== '--json')
}

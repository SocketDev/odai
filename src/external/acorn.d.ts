export function parse(
  code: string,
  options: {
    ecmaVersion: number | 'latest'
    sourceType: 'module' | 'script'
  },
): unknown

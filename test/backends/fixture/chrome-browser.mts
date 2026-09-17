import type {
  BrowserContextLike,
  ChromiumLauncherLike,
  PageLike,
} from '../../../src/backends/chrome-page.mts'

export interface FakeBrowser {
  closed: boolean
  exposed: Map<string, (arg: never) => unknown>
  gotoUrls: string[]
  launcher: ChromiumLauncherLike
  launches: Array<{ options: Record<string, unknown>; userDataDir: string }>
}

// This fake executes serialized page functions against a supplied model factory.
export function createFakeBrowser(languageModel: unknown): FakeBrowser {
  const fake: FakeBrowser = {
    closed: false,
    exposed: new Map(),
    gotoUrls: [],
    launcher: {
      async launchPersistentContext(
        userDataDir: string,
        options: object,
      ): Promise<BrowserContextLike> {
        fake.launches.push({
          options: options as Record<string, unknown>,
          userDataDir,
        })
        const page: PageLike = {
          async evaluate<T>(
            fn: unknown,
            arg?: unknown | undefined,
          ): Promise<T> {
            const holder = globalThis as Record<string, unknown>
            const previousModel = holder['LanguageModel']
            const previousBindings = new Map<string, unknown>()
            holder['LanguageModel'] = languageModel
            for (const [name, callback] of fake.exposed) {
              previousBindings.set(name, holder[name])
              holder[name] = async (bindingArg: never) => callback(bindingArg)
            }
            try {
              return (await (fn as (value: unknown) => unknown)(arg)) as T
            } finally {
              holder['LanguageModel'] = previousModel
              for (const [name, previous] of previousBindings) {
                holder[name] = previous
              }
            }
          },
          async exposeFunction(
            name: string,
            callback: (arg: never) => unknown,
          ): Promise<void> {
            fake.exposed.set(name, callback)
          },
          async goto(url: string): Promise<void> {
            fake.gotoUrls.push(url)
          },
        }
        return {
          async close(): Promise<void> {
            fake.closed = true
          },
          async newPage(): Promise<PageLike> {
            return page
          },
        }
      },
    },
    launches: [],
  }
  return fake
}

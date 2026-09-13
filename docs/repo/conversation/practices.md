# Persistent conversations

Use a conversation when later requests need earlier messages. Ordinary task helpers keep each request isolated.

```js
import { createOdaiConversation } from '@socketsecurity/odai/node'

const conversation = await createOdaiConversation({
  backend: 'chrome-builtin',
  systemPrompt:
    'Help maintain this project. Preserve decisions from earlier turns.',
  maxTurns: 32,
  maxCharacters: 32768,
})

try {
  await conversation.prompt(
    'Our test fixtures must remain outside the checkout.',
  )
  const answer = await conversation.prompt('Where should the next fixture go?')
  console.log(answer)
} finally {
  conversation.destroy()
}
```

In a browser, import `createBuiltinConversation` from `@socketsecurity/odai` to use the built-in model.
Use `createConversation(factory, options)` with a custom provider.
The first prompt creates the provider session. Creating the conversation object does not start generation.

## Save and restore messages

`messages()` returns a copy of committed messages. Choose your own storage and retain the message order.
The library does not write conversation text to disk.

```js
const messages = conversation.messages()
const restored = await createOdaiConversation({
  backend: 'chrome-builtin',
  initialPrompts: messages,
})
```

The transcript contains the initial system instructions and completed user and assistant turns.
Do not supply the same system instructions again when restoring that transcript.
Partial output, cancelled turns, and failed structured responses do not enter committed history.

`reset()` restores the original initial messages. `reset([])` clears all messages, including the system instructions.
Both forms cancel active and queued work. `destroy()` also prevents future requests and is safe to repeat.
Separate conversations have separate histories.

## Stream and validate output

```js
const result = await conversation.promptStreaming('Explain the next change.', {
  abortSignal: controller.signal,
  onChunk({ raw }) {
    preview.textContent = raw
  },
})
```

Streaming callbacks receive provisional text. The completed response is committed after generation succeeds.
An abort rejects the operation and prevents its result from appearing in later context.

`promptStructured()` accepts a schema with a `parse(value)` method.
Only a response that passes that schema becomes a completed turn.
Corrective attempts use committed history and discard the failed attempt's native state.

## Bound retained context

The defaults are 32 turns and 32,768 UTF-16 code units. Set `maxTurns` and `maxCharacters` for the application.
The library rejects excess context instead of silently removing earlier messages.
These text limits are separate from a model's token window.
`contextStatus()` reports available native usage and window information.
A reported native overflow rejects the turn and discards the uncertain session.

Calls within one conversation run in order. Cancellation invalidates the active session before another turn continues.
The next request rebuilds native state from committed messages.
This recovery also applies after generation fails or the response fails validation.

## Provide a session factory

A factory declares `contextMode: 'native'` only when its sessions retain submitted messages and generated responses.
Native sessions must provide `contextStatus()` and report overflow.
Chrome adapters provide this contract and forward cancellation to native generation.
The library does not infer retained history from a `clone()` method.

Factories with `contextMode: 'replay'`, or no declared mode, receive the full committed transcript for each new request.
The replay path creates a fresh session for each attempt. It works with the existing simulator and stateless adapters.
It preserves conversation behavior while avoiding dependence on provider-owned history.

## Verify the public API

```sh
pnpm run perf:context --api odai --pairs 5 --output bench/results/conversation.json
pnpm run perf:context --api native --pairs 5 --output bench/results/context.json
pnpm run check:package
```

The public API comparison checks the same recall tasks with native history and full transcript replay.
Each replay receives the exact completed native transcript. The order alternates between modes.
The public API timing includes lazy session creation. The direct Chrome baseline reports creation separately.
These are different timing boundaries and must remain labeled in reports.

Packed-package checks cover browser and Node imports, transcript restore, streaming, and reset with deterministic providers.
Unit tests cover cancellation, ordering, validation, bounds, and disposal without a model download.
Live recall checks measure the installed model on a small fixture. They do not establish general reasoning reliability.

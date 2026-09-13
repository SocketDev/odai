import type { StreamPayload } from './types.mts'

export class StreamQueue {
  private readonly buffered: StreamPayload[] = []
  private readonly pending: Array<(payload: StreamPayload) => void> = []
  private terminal: StreamPayload | undefined

  close(payload: StreamPayload): void {
    this.terminal = payload
    this.buffered.length = 0
    for (const resolve of this.pending.splice(0)) {
      resolve(payload)
    }
  }

  next(): Promise<StreamPayload> {
    const payload = this.buffered.shift() ?? this.terminal
    if (payload !== undefined) {
      return Promise.resolve(payload)
    }
    return new Promise(resolve => {
      this.pending.push(resolve)
    })
  }

  push(payload: StreamPayload): void {
    if (this.terminal !== undefined) {
      return
    }
    const resolve = this.pending.shift()
    if (resolve === undefined) {
      this.buffered.push(payload)
    } else {
      resolve(payload)
    }
    if (payload.done === true || payload.error !== undefined) {
      this.terminal = payload
      for (const waiter of this.pending.splice(0)) {
        waiter(payload)
      }
    }
  }
}

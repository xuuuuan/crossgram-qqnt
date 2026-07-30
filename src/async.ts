export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private waiters: Array<(value: IteratorResult<T>) => void> = []
  private ended = false

  constructor(private readonly dropIfFullAt?: number) {}

  push(value: T, dropIfFull = false): boolean {
    if (this.ended) return false
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return true
    }
    if (dropIfFull && this.dropIfFullAt !== undefined && this.values.length >= this.dropIfFullAt) return false
    this.values.push(value)
    return true
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
      return: async () => {
        this.close()
        return { value: undefined, done: true }
      },
    }
  }
}

export function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

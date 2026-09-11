import type { StemProvider } from './types'

let stemProvider: StemProvider | null = null

export function setStemProvider(provider: StemProvider | null): void {
  stemProvider = provider
}

export function getStemProvider(): StemProvider | null {
  return stemProvider
}

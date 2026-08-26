import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadOrCreateLocalSessionSeed } from '../../src/server/local-session-store'

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'up-icloud-local-session-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('loadOrCreateLocalSessionSeed', () => {
  it('creates a restricted seed once and reuses it', () => {
    withTemporaryDirectory((directory) => {
      const path = join(directory, 'data', 'local-session-seed')
      const seed = 'A'.repeat(43)
      const random = vi.fn(() => seed)

      expect(loadOrCreateLocalSessionSeed(path, random)).toBe(seed)
      expect(loadOrCreateLocalSessionSeed(path, () => 'B'.repeat(43))).toBe(seed)
      expect(random).toHaveBeenCalledTimes(1)
      expect(readFileSync(path, 'utf8')).toBe(`${seed}\n`)
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
      expect(lstatSync(join(directory, 'data')).mode & 0o777).toBe(0o700)
    })
  })

  it('refuses malformed files and symbolic links', () => {
    withTemporaryDirectory((directory) => {
      const dataDirectory = join(directory, 'data')
      const malformedPath = join(dataDirectory, 'malformed-seed')
      const targetPath = join(dataDirectory, 'target-seed')
      const linkPath = join(dataDirectory, 'linked-seed')
      mkdirSync(dataDirectory)
      writeFileSync(malformedPath, 'not-a-seed\n')
      writeFileSync(targetPath, `${'A'.repeat(43)}\n`)
      symlinkSync(targetPath, linkPath)

      expect(() => loadOrCreateLocalSessionSeed(malformedPath)).toThrow('Local session seed file is invalid')
      expect(() => loadOrCreateLocalSessionSeed(linkPath)).toThrow('small regular file')
    })
  })
})

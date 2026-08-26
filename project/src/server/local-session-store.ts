import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

const LOCAL_SESSION_SEED_PATTERN = /^[A-Za-z0-9_-]{43}$/

function validateSeed(value: string): string {
  const seed = value.trim()
  if (!LOCAL_SESSION_SEED_PATTERN.test(seed)) {
    throw new Error('Local session seed file is invalid')
  }
  return seed
}

function readSeed(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > 256) {
    throw new Error('Local session seed path must be a small regular file')
  }
  chmodSync(path, 0o600)
  return validateSeed(readFileSync(path, 'utf8'))
}

export function loadOrCreateLocalSessionSeed(
  path: string,
  random: () => string = () => randomBytes(32).toString('base64url'),
): string {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)

  try {
    return readSeed(path)
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
  }

  const seed = validateSeed(random())
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${seed}\n`, { encoding: 'utf8' })
  } finally {
    closeSync(descriptor)
  }
  chmodSync(path, 0o600)
  return seed
}

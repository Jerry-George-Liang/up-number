import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadLanTlsMaterial } from '../../src/server/lan-tls'

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'up-icloud-lan-tls-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('LAN TLS material', () => {
  it('rejects private keys readable by other users', () => {
    withTemporaryDirectory((directory) => {
      const certPath = join(directory, 'cert.pem')
      const keyPath = join(directory, 'key.pem')
      writeFileSync(certPath, 'synthetic certificate')
      writeFileSync(keyPath, 'synthetic private key')
      chmodSync(keyPath, 0o644)

      expect(() => loadLanTlsMaterial('192.168.50.218', certPath, keyPath)).toThrow(
        expect.objectContaining({ code: 'LAN_TLS_KEY_PERMISSIONS_INVALID' }),
      )
    })
  })

  it('rejects symbolic-link certificate paths', () => {
    withTemporaryDirectory((directory) => {
      const targetPath = join(directory, 'target.pem')
      const certPath = join(directory, 'cert.pem')
      const keyPath = join(directory, 'key.pem')
      writeFileSync(targetPath, 'synthetic certificate')
      symlinkSync(targetPath, certPath)
      writeFileSync(keyPath, 'synthetic private key', { mode: 0o600 })

      expect(() => loadLanTlsMaterial('192.168.50.218', certPath, keyPath)).toThrow(
        expect.objectContaining({ code: 'LAN_TLS_FILE_INVALID' }),
      )
    })
  })
})

import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { AppError } from '../shared/errors'

const MAX_TLS_FILE_SIZE = 64 * 1024

export interface LanTlsMaterial {
  cert: Buffer
  key: Buffer
}

function readTlsFile(path: string, kind: 'certificate' | 'private key'): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_TLS_FILE_SIZE) {
    throw new AppError('LAN_TLS_FILE_INVALID', `局域网 TLS ${kind}文件必须是小型普通文件。`, {
      statusCode: 500,
    })
  }
  if (kind === 'private key' && (stat.mode & 0o077) !== 0) {
    throw new AppError('LAN_TLS_KEY_PERMISSIONS_INVALID', '局域网 TLS 私钥只能由当前用户读取。', {
      statusCode: 500,
    })
  }
  return readFileSync(path)
}

export function loadLanTlsMaterial(host: string, certPath: string, keyPath: string): LanTlsMaterial {
  try {
    const cert = readTlsFile(certPath, 'certificate')
    const key = readTlsFile(keyPath, 'private key')
    const certificate = new X509Certificate(cert)
    if (!certificate.checkIP(host)) {
      throw new AppError('LAN_TLS_HOST_MISMATCH', '局域网 TLS 证书不包含当前局域网 IP。', {
        statusCode: 500,
      })
    }
    const now = Date.now()
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
      throw new AppError('LAN_TLS_CERTIFICATE_EXPIRED', '局域网 TLS 证书尚未生效或已经过期。', {
        statusCode: 500,
      })
    }
    const privatePublicKey = createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' })
    const certificatePublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' })
    if (!privatePublicKey.equals(certificatePublicKey)) {
      throw new AppError('LAN_TLS_KEY_MISMATCH', '局域网 TLS 证书与私钥不匹配。', {
        statusCode: 500,
      })
    }
    return { cert, key }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('LAN_TLS_MATERIAL_INVALID', '无法读取或解析局域网 TLS 证书。', {
      statusCode: 500,
      cause: error,
    })
  }
}

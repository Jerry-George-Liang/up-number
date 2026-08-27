import type { FastifyInstance } from 'fastify'
import type { TeamWorkflowService } from '../team/workflow'
import { AppError } from '../../shared/errors'

function codesFrom(body: unknown): string[] {
  const codes = body && typeof body === 'object' && Array.isArray((body as { cardCodes?: unknown }).cardCodes)
    ? (body as { cardCodes: unknown[] }).cardCodes
    : []
  const normalized = [...new Set(codes.filter((code): code is string => typeof code === 'string').map((code) => code.trim()).filter(Boolean))]
  if (normalized.length === 0 || normalized.length > 2000) {
    throw new AppError('TEAM_CODES_INVALID', '请输入 1 到 2000 个有效兑换码。', { statusCode: 400 })
  }
  return normalized
}

export function registerTeamRoutes(app: FastifyInstance, workflow: TeamWorkflowService): void {
  app.get('/local-api/team/workflow', async () => workflow.state())
  app.post('/local-api/team/workflow', async (_request, reply) => reply.code(202).send(workflow.start()))
  app.post('/local-api/team/redeem', async (request) => {
    const body = request.body as { cardCodes?: unknown; format?: unknown }
    const cardCodes = codesFrom(body)
    const format = body?.format === 'cpa' ? 'cpa' : 'sub2api'
    const results = []
    for (const cardCode of cardCodes) {
      const preview = await workflow.preview(cardCode, format)
      const details = preview && typeof preview === 'object' && 'preview' in preview
        ? (preview as { preview?: { can_fulfill?: boolean; can_redeem_remaining?: boolean } }).preview
        : undefined
      if (details?.can_fulfill === false || details?.can_redeem_remaining === false) {
        results.push({ cardCode, preview, order: null })
        continue
      }
      results.push({ cardCode, preview, order: await workflow.createOrder(cardCode, format) })
    }
    return { results }
  })
  app.post('/local-api/team/history', async (request) => workflow.history(codesFrom(request.body)))
  app.post('/local-api/team/health-check', async (request) => workflow.healthCheck(codesFrom(request.body)))
  app.post('/local-api/team/reclaim', async (request) => {
    const body = request.body as { cardCodes?: unknown; mode?: unknown; queryOnly?: unknown }
    return workflow.reclaim(codesFrom(body), body?.mode === 'all' ? 'all' : '401', body?.queryOnly === true)
  })
  app.post('/local-api/team/download', async (request, reply) => {
    const body = request.body as { orderNo?: unknown; token?: unknown }
    if (typeof body?.orderNo !== 'string' || !body.orderNo.trim() || typeof body?.token !== 'string' || !body.token) {
      throw new AppError('TEAM_DOWNLOAD_INVALID', '下载参数无效。', { statusCode: 400 })
    }
    const response = await workflow.download(body.orderNo.trim(), body.token)
    if (!response.ok) throw new AppError('TEAM_DOWNLOAD_FAILED', `下载失败（HTTP ${response.status}）。`, { statusCode: response.status })
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
    const disposition = response.headers.get('content-disposition') ?? `attachment; filename="${body.orderNo.trim()}.bin"`
    return reply.type(contentType).header('Content-Disposition', disposition).send(Buffer.from(await response.arrayBuffer()))
  })
}

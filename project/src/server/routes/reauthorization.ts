import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT,
  ReauthorizeTaskInputSchema,
  type PublicTask,
  type ReauthorizationAccountPage,
  type ReauthorizationAccountSummary,
  type ReauthorizationHostingState,
  ReauthorizationProxyModeSchema,
} from '../../shared/contracts'

const listQuerySchema = z
  .object({
    scope: z.literal('error').optional(),
    search: z.string().trim().max(200).default(''),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    maxUsage7dPercent: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(DEFAULT_REAUTHORIZATION_MAX_7D_USED_PERCENT),
    importedWithinDays: z.coerce.number().int().min(1).max(365).optional(),
    supplier: z.string().trim().min(1).max(200).optional(),
    importedAfter: z.iso.datetime().optional(),
    importedBefore: z.iso.datetime().optional(),
    includeExcluded: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  })
  .strict()
const accountParamsSchema = z.object({ accountId: z.coerce.number().int().positive() }).strict()
const accountHostingExclusionSchema = z.object({ excluded: z.boolean() }).strict()
const accountDispositionSchema = z.object({
  note: z.string().trim().max(80),
  excluded: z.boolean(),
}).strict()
const bulkDispositionSchema = accountDispositionSchema.extend({
  accountIds: z.array(z.number().int().positive()).min(1).max(1000),
}).strict()
const hostingInputSchema = listQuerySchema
  .pick({ search: true, maxUsage7dPercent: true, importedWithinDays: true })
  .extend({
    proxyMode: ReauthorizationProxyModeSchema.default('existing'),
    accountIds: z.array(z.number().int().positive()).min(1).max(1000).optional(),
  })
  .strict()

export interface ReauthorizationRoutesAdapter {
  listAccounts(input: {
    search: string
    page: number
    pageSize: number
    maxUsage7dPercent: number
    importedWithinDays?: number
    supplier?: string
    importedAfter?: string
    importedBefore?: string
    includeExcluded: boolean
  }): Promise<ReauthorizationAccountPage>
  getAccount(accountId: number, maxUsage7dPercent: number): Promise<ReauthorizationAccountSummary>
  startTask(input: unknown): PublicTask
  getHostingState(): ReauthorizationHostingState
  startHosting(input: z.infer<typeof hostingInputSchema>): Promise<ReauthorizationHostingState>
  stopHosting(): ReauthorizationHostingState
  skipCurrentHosting(): ReauthorizationHostingState
  setAccountHostingExcluded(accountId: number, excluded: boolean): { accountId: number; excluded: boolean }
  setAccountDisposition(accountId: number, note: string, excluded: boolean): Promise<ReauthorizationAccountSummary>
  setBulkAccountDisposition(accountIds: number[], note: string, excluded: boolean): Promise<{
    updated: ReauthorizationAccountSummary[]
    failed: Array<{ accountId: number; message: string }>
  }>
}

export function registerReauthorizationRoutes(
  app: FastifyInstance,
  adapter: ReauthorizationRoutesAdapter,
): void {
  app.get('/local-api/reauthorization/accounts', async (request) => {
    const query = listQuerySchema.parse(request.query)
    return adapter.listAccounts({
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
      maxUsage7dPercent: query.maxUsage7dPercent,
      ...(query.importedWithinDays === undefined
        ? {}
        : { importedWithinDays: query.importedWithinDays }),
      ...(query.supplier ? { supplier: query.supplier } : {}),
      ...(query.importedAfter ? { importedAfter: query.importedAfter } : {}),
      ...(query.importedBefore ? { importedBefore: query.importedBefore } : {}),
      includeExcluded: query.includeExcluded,
    })
  })

  app.get('/local-api/reauthorization/accounts/:accountId', async (request) => {
    const { accountId } = accountParamsSchema.parse(request.params)
    const query = listQuerySchema.pick({ maxUsage7dPercent: true }).parse(request.query)
    return adapter.getAccount(accountId, query.maxUsage7dPercent)
  })

  app.put('/local-api/reauthorization/accounts/:accountId/hosting-exclusion', async (request) => {
    const { accountId } = accountParamsSchema.parse(request.params)
    const { excluded } = accountHostingExclusionSchema.parse(request.body)
    return adapter.setAccountHostingExcluded(accountId, excluded)
  })

  app.put('/local-api/reauthorization/accounts/:accountId/disposition', async (request) => {
    const { accountId } = accountParamsSchema.parse(request.params)
    const { note, excluded } = accountDispositionSchema.parse(request.body)
    return adapter.setAccountDisposition(accountId, note, excluded)
  })

  app.put('/local-api/reauthorization/accounts/disposition', async (request) => {
    const { accountIds, note, excluded } = bulkDispositionSchema.parse(request.body)
    return adapter.setBulkAccountDisposition([...new Set(accountIds)], note, excluded)
  })

  app.post('/local-api/reauthorization/tasks', async (request, reply) => {
    const input = ReauthorizeTaskInputSchema.parse(request.body)
    return reply.code(202).send(adapter.startTask(input))
  })

  app.get('/local-api/reauthorization/hosting', async () => adapter.getHostingState())

  app.post('/local-api/reauthorization/hosting', async (request, reply) => {
    const input = hostingInputSchema.parse(request.body)
    return reply.code(202).send(await adapter.startHosting(input))
  })

  app.delete('/local-api/reauthorization/hosting', async () => adapter.stopHosting())
  app.post('/local-api/reauthorization/hosting/skip', async () => adapter.skipCurrentHosting())
}

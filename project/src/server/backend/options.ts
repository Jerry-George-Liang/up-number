import { z } from 'zod'
import type {
  CreateTaskInput,
  CreateTaskSelection,
  GroupOption,
  OptionsSnapshot,
  ProxyOption,
  SubscriptionOption,
} from '../../shared/contracts'
import { isSubscriptionAvailable } from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import type { BackendRequester } from './client'

const idSchema = z.number().int().positive()
const nameSchema = z.string().trim().min(1).max(300)

const rawOptionSchema = z
  .object({
    id: idSchema,
    name: nameSchema.optional(),
    label: nameSchema.optional(),
    status: z.string().optional(),
    enabled: z.boolean().optional(),
    is_active: z.boolean().optional(),
    node_count: z.number().int().nonnegative().optional(),
    healthy_node_count: z.number().int().nonnegative().optional(),
  })
  .passthrough()

const rawSupplierSchema = z.object({ name: nameSchema }).passthrough()

const rawProxyDetailSchema = z
  .object({
    id: idSchema,
    name: nameSchema.optional(),
    label: nameSchema.optional(),
    server: z.string().trim().min(1).nullish(),
    proxy_url: z.string().trim().min(1).nullish(),
    protocol: z.string().trim().min(1).nullish(),
    scheme: z.string().trim().min(1).nullish(),
    host: z.string().trim().min(1).nullish(),
    port: z.number().int().positive().max(65_535).nullish(),
    username: z.string().nullish(),
    password: z.string().nullish(),
  })
  .passthrough()

const rawProxyMachineSchema = z
  .object({
    id: idSchema,
    name: nameSchema.optional(),
    status: z.string().optional(),
    proxy_id: idSchema.nullish(),
    current_proxy_id: idSchema.nullish(),
    protocol: z.string().trim().min(1).optional(),
    host: z.string().trim().min(1).optional(),
    port: z.number().int().positive().max(65_535).optional(),
    username: z.string().nullish(),
    password: z.string().nullish(),
    endpoint: z.string().trim().min(1).nullish(),
    base_url: z.string().trim().min(1).nullish(),
  })
  .passthrough()

const assignmentSchema = z
  .object({
    proxy_id: idSchema.optional(),
    id: idSchema.optional(),
    proxy_name: nameSchema.optional(),
    name: nameSchema.optional(),
    proxy: rawOptionSchema.optional(),
  })
  .passthrough()

export type ProxyAssignmentRequest =
  | { mode: 'random_fixed'; affinity_key: string }
  | { mode: 'dynamic'; subscription_id: number; affinity_key: string }

export interface ProxyAssignmentResult {
  proxyId: number
  proxyName?: string
}

export interface RawProxyDetail {
  id: number
  name: string
  server?: string
  proxyUrl?: string
  protocol?: string
  host?: string
  port?: number
  username?: string
  password?: string
}

export interface RawProxyMachineDetail extends RawProxyDetail {
  proxyId?: number
}

function collection(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key]
  }
  return []
}

function optionStatus(value: z.infer<typeof rawOptionSchema>): string | undefined {
  if (value.status) return value.status
  if (value.enabled !== undefined) return value.enabled ? 'active' : 'disabled'
  if (value.is_active !== undefined) return value.is_active ? 'active' : 'disabled'
  return undefined
}

function normalizeOptions<T extends ProxyOption | SubscriptionOption | GroupOption>(
  payload: unknown,
  keys: string[],
  label: string,
): T[] {
  const values = collection(payload, keys)
  const normalized = values.map((value) => {
    const parsed = rawOptionSchema.safeParse(value)
    if (!parsed.success || !(parsed.data.name || parsed.data.label)) {
      throw new AppError('BACKEND_OPTIONS_INVALID', `后台${label}选项格式无效。`, { statusCode: 502 })
    }
    const status = optionStatus(parsed.data)
    return {
      id: parsed.data.id,
      name: parsed.data.name ?? parsed.data.label!,
      ...(status ? { status } : {}),
    } as T
  })
  return normalized
}

function normalizeSuppliers(payload: unknown): string[] {
  const values = collection(payload, ['suppliers', 'items', 'list'])
  const result: string[] = []
  for (const value of values) {
    const name = typeof value === 'string' ? value.trim() : rawSupplierSchema.safeParse(value).data?.name
    if (!name) throw new AppError('BACKEND_OPTIONS_INVALID', '后台供应商选项格式无效。', { statusCode: 502 })
    if (!result.includes(name)) result.push(name)
  }
  return result
}

function normalizeSubscriptions(payload: unknown): SubscriptionOption[] {
  return collection(payload, ['subscriptions', 'items', 'list']).map((value) => {
    const parsed = rawOptionSchema.safeParse(value)
    if (!parsed.success || !(parsed.data.name || parsed.data.label)) {
      throw new AppError('BACKEND_OPTIONS_INVALID', '后台动态订阅选项格式无效。', { statusCode: 502 })
    }
    const status = optionStatus(parsed.data)
    return {
      id: parsed.data.id,
      name: parsed.data.name ?? parsed.data.label!,
      ...(status ? { status } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.node_count !== undefined ? { nodeCount: parsed.data.node_count } : {}),
      ...(parsed.data.healthy_node_count !== undefined
        ? { healthyNodeCount: parsed.data.healthy_node_count }
        : {}),
    }
  })
}

function proxyDetailIndex(payload: unknown): Map<number, unknown> {
  const index = new Map<number, unknown>()
  for (const value of collection(payload, ['proxies', 'items', 'list'])) {
    const parsed = rawOptionSchema.pick({ id: true }).safeParse(value)
    if (parsed.success) index.set(parsed.data.id, value)
  }
  return index
}

function normalizeProxyDetail(value: unknown): RawProxyDetail {
  const parsed = rawProxyDetailSchema.safeParse(value)
  if (!parsed.success) {
    throw new AppError('BACKEND_OPTIONS_INVALID', '后台代理连接配置格式无效。', { statusCode: 502 })
  }
  return {
    id: parsed.data.id,
    name: parsed.data.name ?? parsed.data.label ?? `Proxy ${parsed.data.id}`,
    server: parsed.data.server ?? undefined,
    proxyUrl: parsed.data.proxy_url ?? undefined,
    protocol: parsed.data.protocol ?? parsed.data.scheme ?? undefined,
    host: parsed.data.host ?? undefined,
    port: parsed.data.port ?? undefined,
    username: parsed.data.username ?? undefined,
    password: parsed.data.password ?? undefined,
  }
}

function parseProxyMachines(payload: unknown): Array<z.infer<typeof rawProxyMachineSchema>> {
  return collection(payload, ['items', 'machines', 'list']).map((value) => {
    const parsed = rawProxyMachineSchema.safeParse(value)
    if (!parsed.success) {
      throw new AppError('BACKEND_OPTIONS_INVALID', '后台代理机选项格式无效。', { statusCode: 502 })
    }
    return parsed.data
  })
}

function normalizeProxyOptions(proxiesPayload: unknown, machinesPayload: unknown): ProxyOption[] {
  const proxies = normalizeOptions<ProxyOption>(proxiesPayload, ['proxies', 'items', 'list'], '固定代理')
  const proxyById = new Map(proxies.map((proxy) => [proxy.id, proxy]))
  const claimedProxyIds = new Set<number>()
  const machineOptions: ProxyOption[] = []

  for (const machine of parseProxyMachines(machinesPayload)) {
    if (machine.status?.toLowerCase() === 'inactive') continue
    const linkedProxyId = machine.proxy_id ?? machine.current_proxy_id ?? undefined
    const linkedProxy = linkedProxyId ? proxyById.get(linkedProxyId) : undefined
    if (linkedProxy) claimedProxyIds.add(linkedProxy.id)
    machineOptions.push({
      id: linkedProxy?.id ?? -machine.id,
      name: machine.name ?? linkedProxy?.name ?? `Machine #${machine.id}`,
      status: machine.status === 'inactive' ? 'inactive' : 'active',
      proxyMachineId: machine.id,
      ...(linkedProxy ? { proxyMachineProxyId: linkedProxy.id } : {}),
    })
  }

  return [...machineOptions, ...proxies.filter((proxy) => !claimedProxyIds.has(proxy.id))]
}

export class BackendOptionsApi {
  #proxyDetailsById = new Map<number, unknown>()

  constructor(
    private readonly backend: BackendRequester,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async loadSnapshot(): Promise<OptionsSnapshot> {
    const [proxies, proxyMachines, subscriptions, suppliers, groups] = await Promise.all([
      this.backend.request<unknown>('admin/proxies/all'),
      this.backend.request<unknown>('admin/proxy-machines?page_size=200'),
      this.backend.request<unknown>('admin/proxies/subscriptions'),
      this.backend.request<unknown>('admin/accounts/suppliers'),
      this.backend.request<unknown>('admin/groups/all'),
    ])
    this.#proxyDetailsById = proxyDetailIndex(proxies)
    const loadedAt = this.now().toISOString()
    return {
      version: loadedAt,
      loadedAt,
      proxies: normalizeProxyOptions(proxies, proxyMachines),
      subscriptions: normalizeSubscriptions(subscriptions),
      suppliers: normalizeSuppliers(suppliers),
      groups: normalizeOptions<GroupOption>(groups, ['groups', 'items', 'list'], '分组'),
    }
  }

  async resolveAssignment(body: ProxyAssignmentRequest): Promise<ProxyAssignmentResult> {
    const payload = await this.backend.request<unknown>('admin/proxies/assignments/resolve', {
      method: 'POST',
      body,
    })
    const parsed = assignmentSchema.parse(payload)
    const proxyId = parsed.proxy_id ?? parsed.proxy?.id ?? parsed.id
    const proxyName = parsed.proxy_name ?? parsed.proxy?.name ?? parsed.proxy?.label ?? parsed.name
    if (!proxyId) {
      throw new AppError('PROXY_RESOLUTION_INVALID', '后台未返回可用的代理解析结果。', { statusCode: 502 })
    }
    return { proxyId, ...(proxyName ? { proxyName } : {}) }
  }

  async getProxy(id: number): Promise<RawProxyDetail> {
    let raw = this.#proxyDetailsById.get(id)
    if (!raw) {
      const proxies = await this.backend.request<unknown>('admin/proxies/all')
      this.#proxyDetailsById = proxyDetailIndex(proxies)
      raw = this.#proxyDetailsById.get(id)
    }
    if (!raw) throw new AppError('OPTION_SELECTION_INVALID', '所选代理已失效，请刷新选项。')
    return normalizeProxyDetail(raw)
  }

  async getProxyMachine(id: number): Promise<RawProxyMachineDetail> {
    const payload = await this.backend.request<unknown>('admin/proxy-machines?page_size=200')
    const machine = parseProxyMachines(payload).find((candidate) => candidate.id === id)
    if (!machine) throw new AppError('OPTION_SELECTION_INVALID', '所选代理机已失效，请刷新选项。')
    return {
      id: machine.id,
      name: machine.name ?? `Machine #${machine.id}`,
      proxyId: machine.proxy_id ?? machine.current_proxy_id ?? undefined,
      server: machine.endpoint ?? machine.base_url ?? undefined,
      protocol: machine.protocol,
      host: machine.host,
      port: machine.port,
      username: machine.username ?? undefined,
      password: machine.password ?? undefined,
    }
  }
}

export function validateTaskSelection(input: CreateTaskInput, snapshot: OptionsSnapshot): CreateTaskSelection {
  let proxyId: number | undefined
  let machineId: number | undefined
  let proxyName: string | undefined
  if (input.proxyChoice.mode === 'fixed') {
    const selectedProxyId = input.proxyChoice.proxyId
    const proxy = snapshot.proxies.find((candidate) => candidate.id === selectedProxyId)
    if (!proxy) throw new AppError('OPTION_SELECTION_INVALID', '所选固定代理已失效，请刷新选项。')
    if (proxy.id > 0) proxyId = proxy.id
    machineId = proxy.proxyMachineId
    proxyName = proxy.name
  } else if (input.proxyChoice.mode === 'dynamic') {
    const selectedSubscriptionId = input.proxyChoice.subscriptionId
    const subscription = snapshot.subscriptions.find(
      (candidate) => candidate.id === selectedSubscriptionId,
    )
    if (!subscription) throw new AppError('OPTION_SELECTION_INVALID', '所选动态代理订阅已失效，请刷新选项。')
    if (!isSubscriptionAvailable(subscription)) {
      throw new AppError('OPTION_SELECTION_UNAVAILABLE', '所选动态代理订阅当前没有可用节点，请选择其他订阅。')
    }
    proxyName = subscription.name
  }

  if (input.supplier && !snapshot.suppliers.includes(input.supplier)) {
    throw new AppError('OPTION_SELECTION_INVALID', '所选供应商已失效，请刷新选项。')
  }
  const groups = input.groupIds.map((id) => {
    const group = snapshot.groups.find((candidate) => candidate.id === id)
    if (!group) throw new AppError('OPTION_SELECTION_INVALID', '所选分组已失效，请刷新选项。')
    return { id: group.id, name: group.name }
  })

  return {
    operation: 'create',
    proxyMode: input.proxyChoice.mode,
    ...(proxyId ? { proxyId } : {}),
    ...(machineId ? { machineId } : {}),
    ...(proxyName ? { proxyName } : {}),
    concurrency: input.concurrency,
    supplier: input.supplier,
    groups,
    allowDuplicateCreation: input.allowDuplicateCreation,
    confirmMixedChannelRisk: input.confirmMixedChannelRisk,
    modelsCleared: true,
    loginMaterialSource: input.loginMaterialSource ?? 'manual',
  }
}

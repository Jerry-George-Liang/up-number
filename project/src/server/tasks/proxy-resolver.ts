import { isSubscriptionAvailable, type OptionsSnapshot, type ProxyChoice } from '../../shared/contracts'
import { AppError } from '../../shared/errors'
import type {
  ProxyAssignmentRequest,
  ProxyAssignmentResult,
  RawProxyDetail,
  RawProxyMachineDetail,
} from '../backend/options'

export interface BrowserProxyConfig {
  server: string
  username?: string
  password?: string
}

export type ResolvedProxy =
  | { mode: 'none' }
  | {
      mode: Exclude<ProxyChoice['mode'], 'none'>
      proxyId?: number
      machineId?: number
      proxyName: string
      browserProxy: BrowserProxyConfig
      assignmentMode?: 'random_fixed' | 'dynamic'
      subscriptionId?: number
    }

export interface ProxyBackend {
  resolveAssignment(body: ProxyAssignmentRequest): Promise<ProxyAssignmentResult>
  getProxy(id: number): Promise<RawProxyDetail>
  getProxyMachine(id: number): Promise<RawProxyMachineDetail>
}

function normalizeServer(proxy: RawProxyDetail): string {
  const direct = proxy.server ?? proxy.proxyUrl
  if (direct) {
    try {
      const parsed = new URL(direct)
      if (parsed.protocol === 'socks5h:') parsed.protocol = 'socks5:'
      if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
      return parsed.toString().replace(/\/$/, '')
    } catch {
      throw new AppError('PROXY_CONFIG_INVALID', '所选代理的连接地址无效。')
    }
  }
  if (!proxy.protocol || !proxy.host || !proxy.port) {
    throw new AppError('PROXY_CONFIG_INVALID', '所选代理缺少浏览器连接配置。')
  }
  const suppliedProtocol = proxy.protocol.replace(/:$/, '').toLowerCase()
  const protocol = suppliedProtocol === 'socks5h' ? 'socks5' : suppliedProtocol
  if (!['http', 'https', 'socks5'].includes(protocol)) {
    throw new AppError('PROXY_CONFIG_INVALID', '所选代理协议不受支持。')
  }
  try {
    return new URL(`${protocol}://${proxy.host}:${proxy.port}`).toString().replace(/\/$/, '')
  } catch {
    throw new AppError('PROXY_CONFIG_INVALID', '所选代理的主机或端口无效。')
  }
}

function browserConfig(proxy: RawProxyDetail): BrowserProxyConfig {
  return {
    server: normalizeServer(proxy),
    ...(proxy.username ? { username: proxy.username } : {}),
    ...(proxy.password ? { password: proxy.password } : {}),
  }
}

const SUBSCRIPTION_METADATA_NAME =
  /(?:剩余流量|流量剩余|套餐流量|到期时间|过期时间|更新订阅|订阅更新|官网|公告|通知|subscription\s*(?:info|update)|traffic\s*remaining|expires?)/i

function assertAssignableProxyName(
  choice: ProxyChoice,
  proxyId: number | undefined,
  ...names: Array<string | undefined>
): void {
  if (choice.mode !== 'dynamic') return
  const metadataName = names.find((name) => name && SUBSCRIPTION_METADATA_NAME.test(name))
  if (!metadataName) return
  throw new AppError('PROXY_ASSIGNMENT_METADATA_NODE', '动态代理订阅返回了流量或到期信息节点，正在切换其他节点。', {
    statusCode: 502,
    retryable: true,
    details: { proxyId, proxyName: metadataName },
  })
}

export class ProxyResolver {
  constructor(private readonly backend: ProxyBackend) {}

  async resolve(choice: ProxyChoice, snapshot: OptionsSnapshot, affinityKey: string): Promise<ResolvedProxy> {
    if (choice.mode === 'none') return { mode: 'none' }

    let proxyId: number | undefined
    let machineId: number | undefined
    let proxyName: string | undefined
    let assignmentMode: 'random_fixed' | 'dynamic' | undefined
    let subscriptionId: number | undefined
    if (choice.mode === 'fixed') {
      const selected = snapshot.proxies.find((proxy) => proxy.id === choice.proxyId)
      if (!selected) throw new AppError('OPTION_SELECTION_INVALID', '所选固定代理已失效，请刷新选项。')
      proxyId = selected.id > 0 ? selected.id : undefined
      machineId = selected.proxyMachineId
      proxyName = selected.name
    } else {
      if (choice.mode === 'dynamic') {
        const subscription = snapshot.subscriptions.find((item) => item.id === choice.subscriptionId)
        if (!subscription) throw new AppError('OPTION_SELECTION_INVALID', '所选动态代理订阅已失效，请刷新选项。')
        if (!isSubscriptionAvailable(subscription)) {
          throw new AppError('OPTION_SELECTION_UNAVAILABLE', '所选动态代理订阅当前没有可用节点，请选择其他订阅。')
        }
      }
      const request: ProxyAssignmentRequest =
        choice.mode === 'random_fixed'
          ? { mode: 'random_fixed', affinity_key: affinityKey }
          : { mode: 'dynamic', subscription_id: choice.subscriptionId, affinity_key: affinityKey }
      const resolved = await this.backend.resolveAssignment(request)
      proxyId = resolved.proxyId
      proxyName = resolved.proxyName
      assignmentMode = choice.mode
      if (choice.mode === 'dynamic') subscriptionId = choice.subscriptionId
    }

    let proxy: RawProxyDetail
    if (machineId) {
      const machine = await this.backend.getProxyMachine(machineId)
      const hasDirectConnection = Boolean(machine.server ?? machine.proxyUrl ?? (machine.protocol && machine.host && machine.port))
      if (hasDirectConnection) proxy = machine
      else if (proxyId ?? machine.proxyId) proxy = await this.backend.getProxy((proxyId ?? machine.proxyId)!)
      else throw new AppError('PROXY_CONFIG_INVALID', '所选代理机缺少浏览器连接配置。')
    } else {
      if (!proxyId) throw new AppError('PROXY_RESOLUTION_INVALID', '后台未返回可用的代理解析结果。')
      proxy = await this.backend.getProxy(proxyId)
    }
    assertAssignableProxyName(choice, proxyId, proxyName, proxy.name)
    proxyName ??= proxy.name
    if (!proxyName) throw new AppError('PROXY_CONFIG_INVALID', '所选代理缺少可识别的名称。')
    return {
      mode: choice.mode,
      ...(proxyId ? { proxyId } : {}),
      ...(machineId ? { machineId } : {}),
      proxyName,
      browserProxy: browserConfig(proxy),
      ...(assignmentMode ? { assignmentMode } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
    }
  }
}

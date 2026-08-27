import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '../../shared/errors'
import type { PublicTask, ReauthorizationAccountSummary } from '../../shared/contracts'

const TEAM_CODE_PATTERN = /\bteam-[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}\b/g
const TERMINAL_RECLAIM = new Set(['done', 'skipped', 'unreclaimable', 'not_owned', 'exhausted', 'failed'])

function teamCodes(value: string): string[] {
  return value.match(TEAM_CODE_PATTERN) ?? []
}

export interface TeamWorkflowState {
  status: 'idle' | 'running' | 'completed' | 'failed'
  stage: string
  accounts: number
  codes: number
  reauthorized: number
  downloaded: number
  deleted: number
  message: string
  outputDirectory: string | null
}

interface TeamWorkflowOptions {
  outputDirectory: string
  listAccounts(page: number): Promise<{ items: ReauthorizationAccountSummary[]; pages: number }>
  startReauthorization(account: ReauthorizationAccountSummary): PublicTask
  waitForCompletion(taskId: string): Promise<PublicTask>
  deleteAccounts(ids: readonly number[]): Promise<void>
  fetch?: typeof fetch
}

export class TeamWorkflowService {
  readonly #fetch: typeof fetch
  #run: Promise<void> | null = null
  #state: TeamWorkflowState = { status: 'idle', stage: 'idle', accounts: 0, codes: 0, reauthorized: 0, downloaded: 0, deleted: 0, message: '尚未开始。', outputDirectory: null }

  constructor(private readonly options: TeamWorkflowOptions) {
    this.#fetch = options.fetch ?? fetch
  }

  state(): TeamWorkflowState { return structuredClone(this.#state) }

  preview(cardCode: string, format: 'sub2api' | 'cpa'): Promise<unknown> {
    return this.#json('/api/redeem/preview', { card_code: cardCode, project: 'k12', format })
  }

  createOrder(cardCode: string, format: 'sub2api' | 'cpa'): Promise<unknown> {
    return this.#json('/api/redeem/orders', {
      card_code: cardCode,
      project: 'k12',
      format,
      action: 'redeem_remaining',
      client_request_id: crypto.randomUUID(),
    })
  }

  history(cardCodes: string[]): Promise<unknown> {
    return this.#json('/api/redeem/history/batch', { card_codes: cardCodes })
  }

  healthCheck(cardCodes: string[]): Promise<unknown> {
    return this.#json('/api/redeem/reclaim/health-check', { card_codes: cardCodes })
  }

  reclaim(cardCodes: string[], mode: '401' | 'all', queryOnly = false): Promise<unknown> {
    return this.#json('/api/redeem/reclaim/batch-cards', { card_codes: cardCodes, mode, query_only: queryOnly })
  }

  download(orderNo: string, token: string): Promise<Response> {
    const url = new URL(`/api/redeem/orders/${encodeURIComponent(orderNo)}/download`, 'https://30d.team')
    url.searchParams.set('token', token)
    return this.#fetch(url, { signal: AbortSignal.timeout(180_000) })
  }

  start(): TeamWorkflowState {
    if (this.#run) throw new AppError('TEAM_WORKFLOW_ACTIVE', 'Team 自动处理正在运行。', { statusCode: 409 })
    this.#run = this.#execute().finally(() => { this.#run = null })
    void this.#run.catch(() => undefined)
    return this.state()
  }

  async #execute(): Promise<void> {
    this.#state = { status: 'running', stage: 'discovering', accounts: 0, codes: 0, reauthorized: 0, downloaded: 0, deleted: 0, message: '正在查找包含 Team 兑换码的错误账号。', outputDirectory: null }
    try {
      const accounts: ReauthorizationAccountSummary[] = []
      for (let page = 1; page <= 100; page += 1) {
        const result = await this.options.listAccounts(page)
        accounts.push(...result.items.filter((account) => teamCodes(account.name).length > 0))
        if (page >= result.pages) break
      }
      const groups = new Map<string, ReauthorizationAccountSummary[]>()
      for (const account of accounts) {
        const codes = teamCodes(account.name)
        for (const code of codes) groups.set(code, [...(groups.get(code) ?? []), account])
      }
      this.#state.accounts = accounts.length
      this.#state.codes = groups.size
      if (groups.size === 0) throw new AppError('TEAM_CODES_NOT_FOUND', '没有找到可处理的 Team 兑换码。', { statusCode: 404 })

      this.#state.stage = 'reauthorizing'
      for (const account of accounts) {
        this.#state.message = `正在重新授权 Team 账号（${this.#state.reauthorized + 1}/${accounts.length}）。`
        const task = this.options.startReauthorization(account)
        const finished = await this.options.waitForCompletion(task.id)
        if (finished.status !== 'success') throw new AppError('TEAM_REAUTHORIZATION_FAILED', `账号 #${account.id} 重新授权失败，未执行找回或删除。`)
        this.#state.reauthorized += 1
      }

      this.#state.stage = 'reclaiming'
      const cardCodes = [...groups.keys()]
      let reclaim = await this.#json('/api/redeem/reclaim/batch-cards', { card_codes: cardCodes, mode: '401', query_only: false })
      for (let poll = 0; poll < 50 && !this.#reclaimFinished(reclaim); poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 12_000))
        reclaim = await this.#json('/api/redeem/reclaim/batch-cards', { card_codes: cardCodes, mode: '401', query_only: true })
      }
      if (!this.#reclaimFinished(reclaim)) throw new AppError('TEAM_RECLAIM_TIMEOUT', '401 找回超时，原账号已保留。')

      const tasks = this.#tasks(reclaim)
      const outputDirectory = join(this.options.outputDirectory, new Date().toISOString().replace(/[:.]/g, '-'))
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 })
      this.#state.outputDirectory = outputDirectory
      this.#state.stage = 'downloading'
      const downloadedCodes = new Set<string>()
      for (const task of tasks) {
        if (task.status !== 'done' || !task.order_no || !task.download_token || !task.card_code) continue
        const url = new URL(`/api/redeem/orders/${encodeURIComponent(task.order_no)}/download`, 'https://30d.team')
        url.searchParams.set('token', task.download_token)
        const response = await this.#fetch(url)
        if (!response.ok) throw new AppError('TEAM_DOWNLOAD_FAILED', '找回文件下载失败，原账号已保留。')
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.length === 0) throw new AppError('TEAM_DOWNLOAD_EMPTY', '找回文件为空，原账号已保留。')
        await writeFile(join(outputDirectory, `${task.order_no}.bin`), bytes, { mode: 0o600 })
        downloadedCodes.add(task.card_code)
        this.#state.downloaded += 1
      }

      this.#state.stage = 'deleting'
      for (const code of cardCodes) {
        if (!downloadedCodes.has(code)) continue
        const ids = (groups.get(code) ?? []).map((account) => account.id)
        await this.options.deleteAccounts(ids)
        this.#state.deleted += ids.length
      }
      if (this.#state.deleted === 0) throw new AppError('TEAM_NOTHING_DELETED', '没有兑换码完成下载，原账号全部保留。')
      this.#state.status = 'completed'
      this.#state.stage = 'completed'
      this.#state.message = `已保存 ${this.#state.downloaded} 个找回文件，并删除 ${this.#state.deleted} 个对应原账号。`
    } catch (error) {
      this.#state.status = 'failed'
      this.#state.stage = 'failed'
      this.#state.message = error instanceof Error ? error.message : 'Team 自动处理失败，未完成部分的原账号已保留。'
    }
  }

  async #json(path: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(new URL(path, 'https://30d.team'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
    const payload = await response.json()
    if (!response.ok) throw new AppError('TEAM_REMOTE_FAILED', (payload as { error?: string })?.error || `Team 接口返回 HTTP ${response.status}。`)
    return payload
  }

  #tasks(payload: unknown): Array<Record<string, string>> {
    if (!payload || typeof payload !== 'object') return []
    const cards = (payload as { cards?: unknown[] }).cards ?? []
    return cards.flatMap((card) => card && typeof card === 'object' && Array.isArray((card as { tasks?: unknown[] }).tasks) ? (card as { tasks: Array<Record<string, string>> }).tasks : [])
  }

  #reclaimFinished(payload: unknown): boolean {
    const tasks = this.#tasks(payload)
    return tasks.length > 0 && tasks.every((task) => typeof task.status === 'string' && TERMINAL_RECLAIM.has(task.status))
  }
}

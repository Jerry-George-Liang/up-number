import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CreateTaskInputSchema, type PublicTask } from '../../shared/contracts'
import { AppError } from '../../shared/errors'

const idParamsSchema = z.object({ id: z.string().min(1).max(200) })
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
const eventsQuerySchema = z.object({ once: z.enum(['0', '1']).optional() })

export interface TaskRoutesOrchestrator {
  start(input: unknown): PublicTask
  cancel(taskId: string): PublicTask
  takeOver(taskId: string): PublicTask
  releaseTakeover(taskId: string): PublicTask
  subscribe(listener: (task: PublicTask) => void): () => void
  getActiveTask(): PublicTask | null
  getAuthorizationUrl(taskId: string): string | null
  forgetAuthorizationUrl(taskId: string): void
}

export interface TaskRoutesStorage {
  listTasks(limit?: number): PublicTask[]
  getTask(id: string): PublicTask | null
  deleteTask(id: string): boolean
}

function sseEvent(task: PublicTask): string {
  return `event: task\ndata: ${JSON.stringify(task)}\n\n`
}

export function registerTaskRoutes(
  app: FastifyInstance,
  orchestrator: TaskRoutesOrchestrator,
  tasks: TaskRoutesStorage,
): void {
  app.post('/local-api/tasks', async (request, reply) => {
    const input = CreateTaskInputSchema.parse(request.body)
    return reply.code(202).send(orchestrator.start(input))
  })

  app.get('/local-api/tasks', async (request) => {
    const query = listQuerySchema.parse(request.query)
    return tasks.listTasks(query.limit)
  })

  app.get('/local-api/tasks/active', async () => ({ task: orchestrator.getActiveTask() }))

  app.get('/local-api/tasks/:id/authorization-url', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    const authUrl = orchestrator.getAuthorizationUrl(id)
    if (!authUrl) {
      throw new AppError('TASK_AUTHORIZATION_URL_UNAVAILABLE', '当前任务没有可用的实时授权链接。', { statusCode: 404 })
    }
    return { authUrl }
  })

  app.get('/local-api/tasks/:id', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    const task = tasks.getTask(id)
    if (!task) throw new AppError('TASK_NOT_FOUND', '未找到任务。', { statusCode: 404 })
    return task
  })

  app.post('/local-api/tasks/:id/cancel', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    return orchestrator.cancel(id)
  })

  app.post('/local-api/tasks/:id/takeover', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    return orchestrator.takeOver(id)
  })

  app.delete('/local-api/tasks/:id/takeover', async (request) => {
    const { id } = idParamsSchema.parse(request.params)
    return orchestrator.releaseTakeover(id)
  })

  app.delete('/local-api/tasks/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    if (orchestrator.getActiveTask()?.id === id) {
      throw new AppError('TASK_DELETE_ACTIVE', '运行中的任务不能从历史记录删除。', { statusCode: 409 })
    }
    if (!tasks.deleteTask(id)) throw new AppError('TASK_NOT_FOUND', '未找到任务。', { statusCode: 404 })
    orchestrator.forgetAuthorizationUrl(id)
    return reply.code(204).send()
  })

  app.get('/local-api/tasks/:id/events', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params)
    const query = eventsQuerySchema.parse(request.query)
    const current = tasks.getTask(id)
    if (!current) throw new AppError('TASK_NOT_FOUND', '未找到任务。', { statusCode: 404 })
    if (query.once === '1') {
      return reply.type('text/event-stream').header('Cache-Control', 'no-store').send(sseEvent(current))
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(sseEvent(current))
    const unsubscribe = orchestrator.subscribe((task) => {
      if (task.id === id && !reply.raw.destroyed) reply.raw.write(sseEvent(task))
    })
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n')
    }, 15_000)
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}

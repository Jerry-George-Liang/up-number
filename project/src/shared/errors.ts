import type { TaskStage } from './task-state'

export interface PublicTaskError {
  stage: TaskStage
  code: string
  message: string
  retryable: boolean
  requiresLogin?: boolean
  requiresManualIntervention?: boolean
}

export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options: {
      statusCode?: number
      retryable?: boolean
      cause?: unknown
      details?: Record<string, unknown>
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.statusCode = options.statusCode ?? 400
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

export function toPublicError(error: unknown, stage: TaskStage): PublicTaskError {
  if (error instanceof AppError) {
    return {
      stage,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requiresLogin: error.code === 'SESSION_EXPIRED',
      requiresManualIntervention: error.code === 'MANUAL_INTERVENTION',
    }
  }

  return {
    stage,
    code: 'UNEXPECTED_ERROR',
    message: '任务发生未预期错误，请重新开始。',
    retryable: false,
  }
}

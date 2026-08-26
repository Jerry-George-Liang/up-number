import type { PublicTask } from '../../shared/contracts'
import type {
  ExternalExecutionOptions,
  ExternalExecutionReservation,
} from '../tasks/orchestrator'

export interface ProvisioningAgentStatus {
  paired: boolean
  connected: boolean
  runningTask: boolean
  centralOrigin: string | null
  deviceId: string | null
  deviceName: string | null
  lastContactAt: string | null
  lastError: { code: string; message: string } | null
}

export interface AgentOrchestrator {
  reserveExternalExecution(): ExternalExecutionReservation
  releaseExternalExecution(reservation: ExternalExecutionReservation): void
  startReserved(
    reservation: ExternalExecutionReservation,
    input: unknown,
    options?: ExternalExecutionOptions,
  ): PublicTask
  startReservedReauthorization(
    reservation: ExternalExecutionReservation,
    input: unknown,
    options?: ExternalExecutionOptions,
  ): PublicTask
  waitForCompletion(id: string): Promise<PublicTask>
  cancel(id: string): PublicTask
  subscribe(listener: (task: PublicTask) => void): () => void
}

export interface PairProvisioningAgentInput {
  centralOrigin: string
  pairingCode: string
  deviceName: string
}

export interface ChangeProvisioningAgentOriginInput {
  centralOrigin: string
}

export interface ProvisioningAgentController {
  status(): ProvisioningAgentStatus
  pair(input: PairProvisioningAgentInput): Promise<ProvisioningAgentStatus>
  changeOrigin(input: ChangeProvisioningAgentOriginInput): Promise<ProvisioningAgentStatus>
  disconnect(): Promise<void>
}

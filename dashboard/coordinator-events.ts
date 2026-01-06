import { EventEmitter } from 'events';

export interface Job {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  estimatedComplexity: "trivial" | "small" | "medium" | "large";
  files: string[];
  acceptanceCriteria: string[];
  context?: string;
}

export interface IterationResult {
  iteration: number;
  jobsCompleted: number;
  jobsFailed: number;
  branches: string[];
  timestamp: string;
}

export interface DashboardEvent {
  timestamp: string;
  type: string;
  data: any;
}

export class CoordinatorEvents extends EventEmitter {
  private enabled = true;

  constructor() {
    super();
    this.setMaxListeners(20); // Allow multiple dashboard connections
  }

  // Enable/disable events (useful for testing)
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  private emitEvent(type: string, data: any) {
    // No-op if disabled or no listeners
    if (!this.enabled || this.listenerCount('*') === 0 && this.listenerCount(type) === 0) {
      return;
    }

    const event: DashboardEvent = {
      timestamp: new Date().toISOString(),
      type,
      data
    };

    // Emit specific event
    this.emit(type, event);
    // Emit wildcard for dashboard server
    this.emit('*', event);
  }

  // Iteration events
  emitIterationStart(iteration: number) {
    this.emitEvent('iteration:start', { iteration });
  }

  emitIterationComplete(result: IterationResult) {
    this.emitEvent('iteration:complete', result);
  }

  // Job events
  emitJobCreated(job: Job) {
    this.emitEvent('job:created', { job });
  }

  emitJobStatus(jobId: string, status: 'pending' | 'in-progress' | 'completed' | 'failed') {
    this.emitEvent('job:status', { jobId, status });
  }

  // Worker events
  emitWorkerSpawned(jobId: string, workerName: string) {
    this.emitEvent('worker:spawned', { jobId, workerName });
  }

  // Merge events
  emitMergeStart(branches: string[]) {
    this.emitEvent('merge:start', { branches });
  }

  emitMergeComplete(success: boolean, successCount: number, failCount: number) {
    this.emitEvent('merge:complete', { success, successCount, failCount });
  }
}

// Singleton instance for shared use
export const coordinatorEvents = new CoordinatorEvents();

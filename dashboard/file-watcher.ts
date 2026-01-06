import chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import type { DashboardEvent, Job } from './coordinator-events.js';

export type FileChangeCallback = (event: DashboardEvent) => void;

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private onChangeCallback: FileChangeCallback;
  private jobsDir: string;

  constructor(jobsDir: string, onChangeCallback: FileChangeCallback) {
    this.jobsDir = jobsDir;
    this.onChangeCallback = onChangeCallback;
  }

  start() {
    console.log(`📁 Starting file watcher for ${this.jobsDir}...`);

    // Watch all job directories
    const patterns = [
      `${this.jobsDir}/pending/*.json`,
      `${this.jobsDir}/in-progress/*.json`,
      `${this.jobsDir}/completed/*.json`,
      `${this.jobsDir}/failed/*.json`,
    ];

    this.watcher = chokidar.watch(patterns, {
      persistent: true,
      ignoreInitial: true, // Don't fire events for existing files on start
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    this.watcher
      .on('add', filePath => this.handleFileChange('added', filePath))
      .on('change', filePath => this.handleFileChange('changed', filePath))
      .on('unlink', filePath => this.handleFileChange('removed', filePath))
      .on('ready', () => {
        console.log(`✅ File watcher ready and monitoring job files`);
      })
      .on('error', error => {
        console.error(`❌ File watcher error:`, error);
      });
  }

  private handleFileChange(changeType: string, filePath: string) {
    const status = this.extractStatus(filePath);
    const jobId = path.basename(filePath, '.json');

    if (changeType === 'added' || changeType === 'changed') {
      // New job file detected or file changed
      try {
        const job: Job = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        const event: DashboardEvent = {
          type: changeType === 'added' ? 'job:created' : 'job:updated',
          timestamp: new Date().toISOString(),
          data: { job, status }
        };

        this.onChangeCallback(event);
      } catch (error) {
        console.error(`Failed to read job file ${filePath}:`, error);
      }
    } else if (changeType === 'removed') {
      // Job moved to different directory (status change)
      const event: DashboardEvent = {
        type: 'job:moved',
        timestamp: new Date().toISOString(),
        data: { jobId, oldStatus: status }
      };

      this.onChangeCallback(event);
    }
  }

  private extractStatus(filePath: string): 'pending' | 'in-progress' | 'completed' | 'failed' {
    if (filePath.includes('/pending/')) return 'pending';
    if (filePath.includes('/in-progress/')) return 'in-progress';
    if (filePath.includes('/completed/')) return 'completed';
    if (filePath.includes('/failed/')) return 'failed';
    return 'pending';
  }

  stop() {
    if (this.watcher) {
      console.log('🛑 Stopping file watcher...');
      this.watcher.close();
      this.watcher = null;
    }
  }

  getJobsDir(): string {
    return this.jobsDir;
  }
}

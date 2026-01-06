import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { FileWatcher } from './file-watcher.js';
import { coordinatorEvents, type DashboardEvent, type Job } from './coordinator-events.js';

const HTTP_PORT = process.env.DASHBOARD_PORT ? parseInt(process.env.DASHBOARD_PORT) : 3000;
const WS_PORT = process.env.DASHBOARD_WS_PORT ? parseInt(process.env.DASHBOARD_WS_PORT) : 3001;
const JOBS_DIR = './orchestration/jobs';
const PUBLIC_DIR = './dashboard/public';

interface DashboardState {
  iteration: number;
  jobs: {
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
  };
  jobsList: {
    pending: Job[];
    inProgress: Job[];
    completed: Job[];
    failed: Job[];
  };
  lastUpdate: string;
  coordinatorConnected: boolean;
}

class DashboardServer {
  private httpServer: http.Server;
  private wsServer: WebSocketServer;
  private fileWatcher: FileWatcher;
  private clients = new Set<WebSocket>();
  private currentState: DashboardState;

  constructor() {
    this.currentState = {
      iteration: 0,
      jobs: { pending: 0, inProgress: 0, completed: 0, failed: 0 },
      jobsList: { pending: [], inProgress: [], completed: [], failed: [] },
      lastUpdate: new Date().toISOString(),
      coordinatorConnected: false
    };

    this.setupHttpServer();
    this.setupWebSocketServer();
    this.setupFileWatcher();
    this.setupCoordinatorListeners();

    // Initialize state from files
    this.updateStateFromFiles();
  }

  private setupHttpServer() {
    this.httpServer = http.createServer((req, res) => {
      if (req.url === '/api/state') {
        this.handleStateRequest(req, res);
      } else if (req.url?.startsWith('/api/jobs/')) {
        this.handleJobsRequest(req, res);
      } else {
        this.serveStatic(req, res);
      }
    });

    this.httpServer.listen(HTTP_PORT, () => {
      console.log(`\n🌐 Maximus Dashboard`);
      console.log(`   HTTP server: http://localhost:${HTTP_PORT}`);
      console.log(`   WebSocket:   ws://localhost:${WS_PORT}`);
      console.log(`\n📊 Dashboard ready! Open http://localhost:${HTTP_PORT} in your browser\n`);
    });
  }

  private setupWebSocketServer() {
    this.wsServer = new WebSocketServer({ port: WS_PORT });

    this.wsServer.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`📱 Dashboard client connected (${this.clients.size} total)`);

      // Send initial state immediately
      ws.send(JSON.stringify({
        type: 'initial',
        timestamp: new Date().toISOString(),
        data: this.currentState
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`📴 Dashboard client disconnected (${this.clients.size} remaining)`);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });
    });
  }

  private setupFileWatcher() {
    this.fileWatcher = new FileWatcher(JOBS_DIR, (event) => {
      this.updateStateFromFiles();
      this.broadcast(event);
    });

    this.fileWatcher.start();
  }

  private setupCoordinatorListeners() {
    // Listen to all coordinator events
    coordinatorEvents.on('*', (event: DashboardEvent) => {
      this.currentState.coordinatorConnected = true;
      this.currentState.lastUpdate = event.timestamp;

      // Update iteration number
      if (event.type === 'iteration:start') {
        this.currentState.iteration = event.data.iteration;
      }

      // Update state from files when job status changes
      if (event.type.startsWith('job:')) {
        this.updateStateFromFiles();
      }

      this.broadcast(event);
    });
  }

  private broadcast(event: DashboardEvent) {
    const message = JSON.stringify(event);
    let sent = 0;

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          sent++;
        } catch (error) {
          console.error('Failed to send to client:', error);
        }
      }
    });

    if (sent > 0) {
      console.log(`📤 Broadcast ${event.type} to ${sent} client(s)`);
    }
  }

  private updateStateFromFiles() {
    // Count and read jobs in each directory
    this.currentState.jobs = {
      pending: this.countJobFiles('pending'),
      inProgress: this.countJobFiles('in-progress'),
      completed: this.countJobFiles('completed'),
      failed: this.countJobFiles('failed')
    };

    // Read job details
    this.currentState.jobsList = {
      pending: this.readJobFiles('pending'),
      inProgress: this.readJobFiles('in-progress'),
      completed: this.readJobFiles('completed'),
      failed: this.readJobFiles('failed')
    };

    this.currentState.lastUpdate = new Date().toISOString();

    // Read iteration number from PRODUCT_STATE.md if it exists
    try {
      const productStatePath = './orchestration/PRODUCT_STATE.md';
      if (fs.existsSync(productStatePath)) {
        const content = fs.readFileSync(productStatePath, 'utf-8');
        const match = content.match(/Total iterations:\s*(\d+)/);
        if (match) {
          this.currentState.iteration = parseInt(match[1]);
        }
      }
    } catch (error) {
      // Ignore errors reading product state
    }
  }

  private countJobFiles(status: string): number {
    const dir = path.join(JOBS_DIR, status);
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
  }

  private readJobFiles(status: string): Job[] {
    const dir = path.join(JOBS_DIR, status);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(filename => {
        try {
          const filePath = path.join(dir, filename);
          const content = fs.readFileSync(filePath, 'utf-8');
          return JSON.parse(content) as Job;
        } catch (error) {
          console.error(`Failed to read ${filename}:`, error);
          return null;
        }
      })
      .filter((job): job is Job => job !== null)
      .sort((a, b) => {
        // Sort by priority then by ID
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.id.localeCompare(b.id);
      });
  }

  private handleStateRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.currentState));
  }

  private handleJobsRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const status = req.url?.split('/').pop() as 'pending' | 'in-progress' | 'completed' | 'failed';
    const jobs = this.currentState.jobsList[status === 'in-progress' ? 'inProgress' : status] || [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jobs));
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
    let filePath = req.url === '/' ? '/index.html' : req.url || '/index.html';
    filePath = path.join(PUBLIC_DIR, filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const ext = path.extname(filePath);
      const contentType = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
      }[ext] || 'text/plain';

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  shutdown() {
    console.log('\n🛑 Shutting down dashboard server...');
    this.fileWatcher.stop();
    this.wsServer.close();
    this.httpServer.close();
    console.log('✅ Dashboard server stopped\n');
  }
}

// Start server
const server = new DashboardServer();

// Handle graceful shutdown
process.on('SIGINT', () => {
  server.shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.shutdown();
  process.exit(0);
});

class DashboardClient {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.fallbackMode = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.fallbackInterval = null;
    this.currentState = null;

    this.connect();
    this.setupFallback();
  }

  connect() {
    const wsUrl = `ws://localhost:3001`;
    console.log('Connecting to WebSocket...', wsUrl);

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('✅ Connected to coordinator');
      this.isConnected = true;
      this.fallbackMode = false;
      this.reconnectAttempts = 0;
      this.updateConnectionStatus('live');
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleEvent(data);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    };

    this.ws.onclose = () => {
      console.log('❌ Disconnected from coordinator');
      this.isConnected = false;
      this.updateConnectionStatus('disconnected');
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.fallbackMode = true;
    };
  }

  setupFallback() {
    // Poll REST API every 2 seconds when in fallback mode
    this.fallbackInterval = setInterval(() => {
      if (this.fallbackMode || !this.isConnected) {
        this.fetchState();
      }
    }, 2000);
  }

  async fetchState() {
    try {
      const response = await fetch('/api/state');
      const data = await response.json();
      this.updateUI(data);
      if (!this.isConnected) {
        this.updateConnectionStatus('fallback');
      }
    } catch (error) {
      console.error('Failed to fetch state:', error);
      this.updateConnectionStatus('error');
    }
  }

  handleEvent(event) {
    console.log('Event received:', event.type);

    switch (event.type) {
      case 'initial':
        this.currentState = event.data;
        this.updateUI(event.data);
        break;
      case 'iteration:start':
        this.onIterationStart(event.data);
        break;
      case 'job:created':
        this.fetchState(); // Refresh full state
        break;
      case 'job:status':
        this.fetchState(); // Refresh full state
        break;
      case 'iteration:complete':
        this.onIterationComplete(event.data);
        break;
      default:
        // Refresh state for any other events
        this.fetchState();
    }
  }

  onIterationStart(data) {
    document.getElementById('iteration').textContent = data.iteration;
    this.fetchState(); // Refresh full state
  }

  onIterationComplete(data) {
    this.fetchState(); // Refresh full state
  }

  updateUI(state) {
    this.currentState = state;

    // Update iteration
    document.getElementById('iteration').textContent = state.iteration || 0;

    // Update job counts
    document.getElementById('pending').textContent = state.jobs.pending;
    document.getElementById('in-progress').textContent = state.jobs.inProgress;
    document.getElementById('completed').textContent = state.jobs.completed;
    document.getElementById('failed').textContent = state.jobs.failed;

    // Update column counts
    document.getElementById('pending-count').textContent = state.jobs.pending;
    document.getElementById('in-progress-count').textContent = state.jobs.inProgress;
    document.getElementById('completed-count').textContent = state.jobs.completed;
    document.getElementById('failed-count').textContent = state.jobs.failed;

    // Update progress
    const total = state.jobs.pending + state.jobs.inProgress +
                  state.jobs.completed + state.jobs.failed;
    const progress = total > 0
      ? Math.round(((state.jobs.completed + state.jobs.failed) / total) * 100)
      : 0;

    document.getElementById('progress-percentage').textContent = `${progress}%`;
    document.getElementById('progress-bar').style.width = `${progress}%`;

    // Update last update time
    const lastUpdateTime = new Date(state.lastUpdate).toLocaleTimeString();
    document.getElementById('last-update').textContent = lastUpdateTime;

    // Update job lists
    this.updateJobList('pending', state.jobsList.pending);
    this.updateJobList('in-progress', state.jobsList.inProgress);
    this.updateJobList('completed', state.jobsList.completed);
    this.updateJobList('failed', state.jobsList.failed);
  }

  updateJobList(status, jobs) {
    const listId = `${status}-list`;
    const listElement = document.getElementById(listId);

    if (!jobs || jobs.length === 0) {
      listElement.innerHTML = '<div class="empty-state">No jobs</div>';
      return;
    }

    listElement.innerHTML = jobs.map(job => this.createJobCard(job, status)).join('');
  }

  createJobCard(job, status) {
    const priorityClass = `priority-${job.priority}`;
    const complexityClass = `complexity-${job.estimatedComplexity}`;

    return `
      <div class="job-card ${status}">
        <div class="job-header">
          <div class="job-id">${job.id}</div>
          <div class="job-badges">
            <span class="badge ${priorityClass}">${job.priority}</span>
            <span class="badge ${complexityClass}">${job.estimatedComplexity}</span>
          </div>
        </div>
        <div class="job-title">${this.escapeHtml(job.title)}</div>
        <div class="job-description">${this.escapeHtml(job.description)}</div>
        <div class="job-files">
          <strong>Files:</strong> ${job.files.slice(0, 3).join(', ')}
          ${job.files.length > 3 ? ` +${job.files.length - 3} more` : ''}
        </div>
      </div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
      console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(), delay);
    } else {
      console.log('Max reconnect attempts reached, switching to fallback mode');
      this.fallbackMode = true;
      this.updateConnectionStatus('fallback');
    }
  }

  updateConnectionStatus(status) {
    const indicator = document.getElementById('connection-indicator');
    const statusText = document.getElementById('connection-status');

    indicator.className = `indicator indicator-${status}`;

    const statusMessages = {
      live: '🟢 Live',
      disconnected: '🟡 Reconnecting...',
      fallback: '🟠 File Monitoring',
      error: '🔴 Offline'
    };

    statusText.textContent = statusMessages[status] || 'Unknown';
  }
}

// Initialize dashboard when page loads
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Dashboard client starting...');
  new DashboardClient();
});

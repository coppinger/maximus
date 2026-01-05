# Emergent Builder

An autonomous product development system that uses Claude Code to iteratively analyze and improve a codebase.

## Concept

Emergent Builder creates a self-directing loop:

1. **Analyze** → Claude examines the codebase (optionally via Browserbase for visual analysis)
2. **Plan** → Generate focused job specifications for improvements
3. **Execute** → Worker instances implement each job in parallel
4. **Merge** → Combine all improvements back to main
5. **Repeat** → Loop until the product reaches completion criteria

## Two Modes

### 1. Simple Local Runner (Start Here)

Runs entirely on your machine. Jobs execute sequentially. Perfect for testing.

```bash
# Install dependencies
npm install

# Point to your project and run
REPO_PATH=/path/to/your/project npm run simple
```

### 2. Full Sprites Runner (Parallel & Persistent)

Uses Fly.io Sprites for true parallelization and checkpoint/restore.

```bash
# Install dependencies
npm install

# Set your Sprites token and repo
export SPRITE_TOKEN=your_token_here
export REPO_URL=https://github.com/you/your-repo.git

# Run
npm run dev
```

## Setup

### Prerequisites

- Node.js 20+
- Claude Code CLI installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- Git
- (For Sprites mode) Fly.io account and Sprites access

### Quick Start

```bash
# Clone this repo
git clone <this-repo>
cd emergent-builder

# Install dependencies
npm install

# Copy the orchestration folder to your project
cp -r orchestration /path/to/your/project/

# Edit the product vision
# (IMPORTANT: customize this for your project)
nano /path/to/your/project/orchestration/PRODUCT_VISION.md

# Run the simple version
REPO_PATH=/path/to/your/project npm run simple
```

## Configuration Files

### `orchestration/PRODUCT_VISION.md`

**You must customize this.** It tells the coordinator what you're building:

- Product name and purpose
- Key features
- Design principles
- Technical stack
- Success criteria
- What's out of scope

### `orchestration/COORDINATOR_PROMPT.md`

Instructions for how the coordinator analyzes and generates jobs. The default covers:

- Design critique
- UX flow review
- Accessibility audit
- Performance review
- Code quality
- Feature completeness

You can customize this to focus on what matters for your project.

### `orchestration/PRODUCT_STATE.md`

Auto-generated file tracking iteration history. The coordinator uses this to understand what's already been improved.

## How Jobs Work

Each job is a focused improvement task:

```json
{
  "id": "job-001",
  "title": "Add loading state to submit button",
  "description": "The submit button has no feedback during form submission...",
  "priority": "high",
  "estimatedComplexity": "small",
  "files": ["src/components/SubmitButton.tsx"],
  "acceptanceCriteria": [
    "Button shows spinner during submission",
    "Button is disabled while loading",
    "Original text restored after completion"
  ]
}
```

Jobs flow through:
- `pending/` → waiting to be executed
- `in-progress/` → currently being worked on
- `completed/` → successfully finished
- `failed/` → execution failed

## Visual Analysis (Optional)

If you have Browserbase MCP configured with Claude Code, the coordinator can take screenshots of your running application and critique the actual rendered UI. This is powerful but uses more tokens.

To enable:
1. Set up Browserbase MCP in your Claude Code config
2. Have your dev server running on a tunnel (e.g., ngrok or Browserbase's built-in proxy)
3. The coordinator will automatically use it when available

## Stopping Conditions

The loop stops when:
- Max iterations reached (configurable)
- Coordinator generates no jobs (product is "done")
- You manually interrupt (Ctrl+C)

## Tips

**Start small**: Run one iteration, review the results, adjust your PRODUCT_VISION.md if needed.

**Review jobs before execution**: Add `--dry-run` (not yet implemented) or pause after job generation to review what will be changed.

**Use checkpoints**: In Sprites mode, you can restore to any previous checkpoint if an iteration makes things worse.

**Tune the coordinator prompt**: If you're getting jobs that aren't useful, adjust COORDINATOR_PROMPT.md to focus on what matters.

**Commit frequently**: Each job creates its own branch and commit, so you have full git history of every change.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      COORDINATOR                             │
│  - Loads PRODUCT_VISION.md                                  │
│  - Runs Claude Code for analysis                            │
│  - Generates job files                                       │
│  - Spawns workers (parallel in Sprites mode)                │
│  - Merges branches                                          │
│  - Updates PRODUCT_STATE.md                                 │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
      ┌──────────┐      ┌──────────┐      ┌──────────┐
      │ Worker 1 │      │ Worker 2 │      │ Worker 3 │
      │          │      │          │      │          │
      │ job-001  │      │ job-002  │      │ job-003  │
      │    ↓     │      │    ↓     │      │    ↓     │
      │  branch  │      │  branch  │      │  branch  │
      └──────────┘      └──────────┘      └──────────┘
```

## Future Enhancements

- [ ] Web dashboard for monitoring iterations
- [ ] Rollback command to restore previous checkpoints
- [ ] Dry-run mode to preview jobs before execution
- [ ] Cost tracking per iteration
- [ ] Integration with CI/CD for deployment after successful iterations
- [ ] Multi-model support (use cheaper models for simple jobs)

## License

MIT

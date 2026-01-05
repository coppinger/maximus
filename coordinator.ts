import { SpritesClient, Sprite } from "@fly/sprites";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Configuration
const CONFIG = {
  maxWorkers: 4,
  maxIterations: 10,
  jobsDir: "./orchestration/jobs",
  repoUrl: process.env.REPO_URL || "",
  repoBranch: process.env.REPO_BRANCH || "main",
  projectPath: process.env.PROJECT_PATH || "/home/sprite/project",
  coordinatorPromptPath: "./orchestration/COORDINATOR_PROMPT.md",
  productVisionPath: "./orchestration/PRODUCT_VISION.md",
  productStatePath: "./orchestration/PRODUCT_STATE.md",
};

interface Job {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  estimatedComplexity: "trivial" | "small" | "medium" | "large";
  files: string[];
  acceptanceCriteria: string[];
  context?: string;
}

interface IterationResult {
  iteration: number;
  jobsCompleted: number;
  jobsFailed: number;
  branches: string[];
  timestamp: string;
}

class EmergentBuilder {
  private client: SpritesClient;
  private coordinatorSprite: Sprite | null = null;
  private iteration = 0;
  private results: IterationResult[] = [];

  constructor() {
    const token = process.env.SPRITE_TOKEN;
    if (!token) throw new Error("SPRITE_TOKEN environment variable required");
    this.client = new SpritesClient(token);
  }

  async initialize() {
    console.log("🚀 Initializing Emergent Builder...");

    // Ensure directories exist
    fs.mkdirSync(`${CONFIG.jobsDir}/pending`, { recursive: true });
    fs.mkdirSync(`${CONFIG.jobsDir}/in-progress`, { recursive: true });
    fs.mkdirSync(`${CONFIG.jobsDir}/completed`, { recursive: true });
    fs.mkdirSync(`${CONFIG.jobsDir}/failed`, { recursive: true });

    // Create coordinator Sprite
    console.log("📦 Creating coordinator Sprite...");
    this.coordinatorSprite = await this.client.createSprite("coordinator");

    // Clone the repo into the coordinator
    if (CONFIG.repoUrl) {
      console.log("📥 Cloning repository...");
      await this.coordinatorSprite.execFile("git", [
        "clone",
        "--branch",
        CONFIG.repoBranch,
        CONFIG.repoUrl,
        CONFIG.projectPath,
      ]);
    }

    // Install Claude Code CLI if not present
    await this.coordinatorSprite.execFile("bash", [
      "-c",
      "which claude || npm install -g @anthropic-ai/claude-code",
    ]);

    console.log("✅ Coordinator initialized");
  }

  async runAnalysis(): Promise<Job[]> {
    if (!this.coordinatorSprite) throw new Error("Coordinator not initialized");

    console.log(`\n🔍 Running analysis (iteration ${this.iteration + 1})...`);

    const coordinatorPrompt = fs.readFileSync(
      CONFIG.coordinatorPromptPath,
      "utf-8"
    );
    const productVision = fs.existsSync(CONFIG.productVisionPath)
      ? fs.readFileSync(CONFIG.productVisionPath, "utf-8")
      : "No product vision defined yet.";
    const productState = fs.existsSync(CONFIG.productStatePath)
      ? fs.readFileSync(CONFIG.productStatePath, "utf-8")
      : "No previous state. This is the first iteration.";

    const analysisPrompt = `
${coordinatorPrompt}

## Product Vision
${productVision}

## Current Product State
${productState}

## Your Task
Analyze the current state of the project at ${CONFIG.projectPath} and generate job files for improvements.

1. If Browserbase MCP is available, use it to view the running application
2. Otherwise, analyze the codebase directly
3. Generate 4-8 job files as JSON, one per improvement
4. Output ONLY valid JSON array of jobs, no other text

Output format:
[
  {
    "id": "job-001",
    "title": "Short title",
    "description": "What needs to be done",
    "priority": "high",
    "estimatedComplexity": "small",
    "files": ["src/file1.tsx", "src/file2.tsx"],
    "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
  }
]
`;

    // Write the prompt to a temp file
    await this.coordinatorSprite.execFile("bash", [
      "-c",
      `cat > /tmp/analysis-prompt.md << 'PROMPT_EOF'
${analysisPrompt}
PROMPT_EOF`,
    ]);

    // Run Claude Code for analysis
    const cmd = this.coordinatorSprite.spawn(
      "claude",
      [
        "-p",
        analysisPrompt,
        "--output-format",
        "text",
        "--max-turns",
        "10",
      ],
      { cwd: CONFIG.projectPath }
    );

    let output = "";
    cmd.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    cmd.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    await cmd.wait();

    // Parse jobs from output
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error("❌ Failed to parse jobs from analysis output");
      return [];
    }

    try {
      const jobs: Job[] = JSON.parse(jsonMatch[0]);
      console.log(`✅ Generated ${jobs.length} jobs`);
      return jobs;
    } catch (e) {
      console.error("❌ Failed to parse jobs JSON:", e);
      return [];
    }
  }

  async writeJobFiles(jobs: Job[]) {
    for (const job of jobs) {
      const jobPath = `${CONFIG.jobsDir}/pending/${job.id}.json`;
      fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
      console.log(`📝 Created job: ${job.id} - ${job.title}`);
    }
  }

  async spawnWorker(job: Job): Promise<{ success: boolean; branch: string }> {
    const branchName = `emergent/${this.iteration}/${job.id}`;
    console.log(`\n🔧 Spawning worker for ${job.id}: ${job.title}`);

    // Move job to in-progress
    const pendingPath = `${CONFIG.jobsDir}/pending/${job.id}.json`;
    const inProgressPath = `${CONFIG.jobsDir}/in-progress/${job.id}.json`;
    if (fs.existsSync(pendingPath)) {
      fs.renameSync(pendingPath, inProgressPath);
    }

    const worker = await this.client.createSprite(`worker-${job.id}`);

    try {
      // Clone repo
      await worker.execFile("git", [
        "clone",
        "--branch",
        CONFIG.repoBranch,
        CONFIG.repoUrl,
        CONFIG.projectPath,
      ]);

      // Create branch
      await worker.execFile("git", ["checkout", "-b", branchName], {
        cwd: CONFIG.projectPath,
      });

      // Write job context
      const jobPrompt = `
You are a worker agent executing a specific improvement job.

## Job Details
- ID: ${job.id}
- Title: ${job.title}
- Description: ${job.description}
- Priority: ${job.priority}
- Files to modify: ${job.files.join(", ")}

## Acceptance Criteria
${job.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Instructions
1. Implement the changes described above
2. Ensure all acceptance criteria are met
3. Keep changes focused and minimal
4. Test that the application still builds/runs
5. Commit your changes with a descriptive message

Do not make changes outside the scope of this job.
`;

      // Run Claude Code to execute the job
      const cmd = worker.spawn(
        "claude",
        ["-p", jobPrompt, "--output-format", "text", "--max-turns", "20"],
        { cwd: CONFIG.projectPath }
      );

      cmd.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
      cmd.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));

      const exitCode = await cmd.wait();

      if (exitCode !== 0) {
        throw new Error(`Worker exited with code ${exitCode}`);
      }

      // Commit and push
      await worker.execFile("git", ["add", "-A"], { cwd: CONFIG.projectPath });
      await worker.execFile(
        "git",
        ["commit", "-m", `[emergent] ${job.title}\n\nJob ID: ${job.id}`],
        { cwd: CONFIG.projectPath }
      );
      await worker.execFile("git", ["push", "-u", "origin", branchName], {
        cwd: CONFIG.projectPath,
      });

      // Move to completed
      const completedPath = `${CONFIG.jobsDir}/completed/${job.id}.json`;
      if (fs.existsSync(inProgressPath)) {
        fs.renameSync(inProgressPath, completedPath);
      }

      console.log(`✅ Worker ${job.id} completed successfully`);
      return { success: true, branch: branchName };
    } catch (error) {
      console.error(`❌ Worker ${job.id} failed:`, error);

      // Move to failed
      const failedPath = `${CONFIG.jobsDir}/failed/${job.id}.json`;
      if (fs.existsSync(inProgressPath)) {
        fs.renameSync(inProgressPath, failedPath);
      }

      return { success: false, branch: branchName };
    } finally {
      await worker.delete();
    }
  }

  async runWorkers(jobs: Job[]): Promise<{ branches: string[]; failed: number }> {
    const branches: string[] = [];
    let failed = 0;

    // Process in batches of maxWorkers
    for (let i = 0; i < jobs.length; i += CONFIG.maxWorkers) {
      const batch = jobs.slice(i, i + CONFIG.maxWorkers);
      console.log(
        `\n📦 Processing batch ${Math.floor(i / CONFIG.maxWorkers) + 1} (${batch.length} jobs)`
      );

      const results = await Promise.all(batch.map((job) => this.spawnWorker(job)));

      for (const result of results) {
        if (result.success) {
          branches.push(result.branch);
        } else {
          failed++;
        }
      }
    }

    return { branches, failed };
  }

  async mergeBranches(branches: string[]): Promise<boolean> {
    if (!this.coordinatorSprite || branches.length === 0) return true;

    console.log(`\n🔀 Merging ${branches.length} branches...`);

    try {
      // Fetch all branches
      await this.coordinatorSprite.execFile("git", ["fetch", "--all"], {
        cwd: CONFIG.projectPath,
      });

      for (const branch of branches) {
        console.log(`  Merging ${branch}...`);
        try {
          await this.coordinatorSprite.execFile(
            "git",
            ["merge", `origin/${branch}`, "--no-edit"],
            { cwd: CONFIG.projectPath }
          );
        } catch (e) {
          console.error(`  ⚠️ Merge conflict on ${branch}, skipping`);
          await this.coordinatorSprite.execFile("git", ["merge", "--abort"], {
            cwd: CONFIG.projectPath,
          });
        }
      }

      // Push merged changes
      await this.coordinatorSprite.execFile("git", ["push"], {
        cwd: CONFIG.projectPath,
      });

      console.log("✅ Merge complete");
      return true;
    } catch (error) {
      console.error("❌ Merge failed:", error);
      return false;
    }
  }

  async updateProductState(result: IterationResult) {
    const stateContent = `# Product State

Last updated: ${result.timestamp}
Total iterations: ${this.iteration}

## Latest Iteration (#${result.iteration})
- Jobs completed: ${result.jobsCompleted}
- Jobs failed: ${result.jobsFailed}
- Branches merged: ${result.branches.join(", ") || "none"}

## History
${this.results
  .map(
    (r) =>
      `- Iteration ${r.iteration}: ${r.jobsCompleted} completed, ${r.jobsFailed} failed`
  )
  .join("\n")}
`;

    fs.writeFileSync(CONFIG.productStatePath, stateContent);
  }

  async checkpoint(name: string) {
    if (!this.coordinatorSprite) return;
    console.log(`💾 Creating checkpoint: ${name}`);
    await this.coordinatorSprite.checkpoint(name);
  }

  async restore(name: string) {
    if (!this.coordinatorSprite) return;
    console.log(`⏪ Restoring checkpoint: ${name}`);
    await this.coordinatorSprite.restore(name);
  }

  async runIteration(): Promise<boolean> {
    this.iteration++;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🔄 ITERATION ${this.iteration}`);
    console.log(`${"=".repeat(60)}`);

    // Checkpoint before changes
    await this.checkpoint(`pre-iteration-${this.iteration}`);

    // Run analysis and generate jobs
    const jobs = await this.runAnalysis();
    if (jobs.length === 0) {
      console.log("No jobs generated. Stopping.");
      return false;
    }

    // Write job files
    await this.writeJobFiles(jobs);

    // Spawn workers
    const { branches, failed } = await this.runWorkers(jobs);

    // Merge successful branches
    await this.mergeBranches(branches);

    // Record result
    const result: IterationResult = {
      iteration: this.iteration,
      jobsCompleted: branches.length,
      jobsFailed: failed,
      branches,
      timestamp: new Date().toISOString(),
    };
    this.results.push(result);

    // Update product state
    await this.updateProductState(result);

    // Checkpoint after changes
    await this.checkpoint(`post-iteration-${this.iteration}`);

    console.log(`\n✅ Iteration ${this.iteration} complete`);
    console.log(`   Jobs completed: ${branches.length}`);
    console.log(`   Jobs failed: ${failed}`);

    return this.iteration < CONFIG.maxIterations;
  }

  async run() {
    try {
      await this.initialize();

      let continueLoop = true;
      while (continueLoop) {
        continueLoop = await this.runIteration();

        // Brief pause between iterations
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      console.log("\n🎉 Emergent Builder complete!");
      console.log(`Total iterations: ${this.iteration}`);
      console.log(
        `Total jobs completed: ${this.results.reduce((a, r) => a + r.jobsCompleted, 0)}`
      );
    } catch (error) {
      console.error("Fatal error:", error);
      throw error;
    } finally {
      if (this.coordinatorSprite) {
        console.log("\n🧹 Cleaning up coordinator Sprite...");
        await this.coordinatorSprite.delete();
      }
    }
  }
}

// CLI entry point
async function main() {
  const builder = new EmergentBuilder();
  await builder.run();
}

main().catch(console.error);

import { SpritesClient, Sprite } from "@fly/sprites";
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { coordinatorEvents } from "./dashboard/coordinator-events.js";

// Load environment variables from .env file
config();

// Configuration
const CONFIG = {
  maxWorkers: 2, // Reduced from 4 to avoid overwhelming WebSocket connections
  maxIterations: 10,
  jobsDir: "./orchestration/jobs",
  repoUrl: process.env.REPO_URL || "https://github.com/coppinger/test-web-app.git",
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
  private anthropic: Anthropic;
  private coordinatorSprite: Sprite | null = null;
  private iteration = 0;
  private results: IterationResult[] = [];

  constructor() {
    const token = process.env.SPRITE_TOKEN;
    if (!token) throw new Error("SPRITE_TOKEN environment variable required");
    this.client = new SpritesClient(token);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY environment variable required");
    this.anthropic = new Anthropic({ apiKey });
  }

  async initialize() {
    console.log("🚀 Initializing Emergent Builder...");

    // Ensure directories exist
    fs.mkdirSync(`${CONFIG.jobsDir}/pending`, { recursive: true });
    fs.mkdirSync(`${CONFIG.jobsDir}/in-progress`, { recursive: true });
    fs.mkdirSync(`${CONFIG.jobsDir}/completed`, { recursive: true });
    fs.mkdirSync(`${CONFIG.jobsDir}/failed`, { recursive: true });

    // Create coordinator Sprite with unique name
    console.log("📦 Creating coordinator Sprite...");
    const coordinatorName = `coordinator-${Date.now()}`;
    this.coordinatorSprite = await this.client.createSprite(coordinatorName);

    // Clone the repo into the coordinator
    if (CONFIG.repoUrl) {
      console.log("📥 Cloning repository...");
      const ghToken = process.env.GITHUB_TOKEN;
      const repoUrl = ghToken
        ? CONFIG.repoUrl.replace("https://", `https://x-access-token:${ghToken}@`)
        : CONFIG.repoUrl;

      await this.coordinatorSprite.execFile("git", [
        "clone",
        "--branch",
        CONFIG.repoBranch,
        repoUrl,
        CONFIG.projectPath,
      ]);
    }

    console.log("✅ Coordinator initialized");
  }

  async runAnalysis(): Promise<Job[]> {
    if (!this.coordinatorSprite) throw new Error("Coordinator not initialized");

    console.log(`\n🔍 Running analysis (iteration ${this.iteration + 1})...`);

    // Read configuration files locally
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

    // Read codebase files from the Sprite
    console.log("📖 Reading codebase files...");
    const codebaseFiles = await this.readCodebaseFromSprite();

    // Build the analysis prompt
    const systemPrompt = `${coordinatorPrompt}

## Product Vision
${productVision}

## Current Product State
${productState}

## Instructions
Analyze the codebase provided below and generate 4-8 job specifications for improvements.
Output ONLY a valid JSON array of jobs, with no other text before or after.

Each job must follow this schema:
{
  "id": "job-XXX",
  "title": "Concise title (max 60 chars)",
  "description": "Detailed description of what needs to change and why",
  "priority": "critical" | "high" | "medium" | "low",
  "estimatedComplexity": "trivial" | "small" | "medium" | "large",
  "files": ["path/to/file.ext"],
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
}`;

    const userMessage = `Here is the current codebase:

${codebaseFiles}

Generate job specifications for improvements based on the product vision and success criteria.`;

    try {
      console.log("🤖 Calling Claude API for analysis...");
      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 16000,
        temperature: 1,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      });

      // Extract text from response
      const textContent = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as any).text)
        .join("\n");

      console.log("📝 Response received, parsing jobs...");

      // Parse JSON array from response
      const jsonMatch = textContent.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error("❌ Failed to find JSON array in response");
        console.error("Response:", textContent.substring(0, 500));
        return [];
      }

      const jobs: Job[] = JSON.parse(jsonMatch[0]);
      console.log(`✅ Generated ${jobs.length} jobs`);
      return jobs;
    } catch (e) {
      console.error("❌ API call or parsing failed:", e);
      return [];
    }
  }

  async readCodebaseFromSprite(): Promise<string> {
    if (!this.coordinatorSprite) throw new Error("Coordinator not initialized");

    // List all files in the project
    const result = await this.coordinatorSprite.execFile("find", [
      CONFIG.projectPath,
      "-type",
      "f",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
    ]);

    const files = result.stdout.toString().trim().split("\n").filter(Boolean);

    let codebase = "";
    for (const file of files) {
      try {
        const content = await this.coordinatorSprite.execFile("cat", [file]);
        const relativePath = file.replace(CONFIG.projectPath + "/", "");
        codebase += `\n\n## File: ${relativePath}\n\`\`\`\n${content.stdout.toString()}\n\`\`\`\n`;
      } catch (e) {
        // Skip files that can't be read
      }
    }

    return codebase;
  }

  async listFilesInWorker(worker: Sprite): Promise<string[]> {
    const result = await worker.execFile("find", [
      CONFIG.projectPath,
      "-type",
      "f",
      "-not",
      "-path",
      "*/node_modules/*",
      "-not",
      "-path",
      "*/.git/*",
    ]);

    return result.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(CONFIG.projectPath + "/", ""));
  }

  async writeJobFiles(jobs: Job[]) {
    for (const job of jobs) {
      const jobPath = `${CONFIG.jobsDir}/pending/${job.id}.json`;
      fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
      console.log(`📝 Created job: ${job.id} - ${job.title}`);
      coordinatorEvents.emitJobCreated(job);
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
      coordinatorEvents.emitJobStatus(job.id, 'in-progress');
    }

    const worker = await this.client.createSprite(`worker-${job.id}-${Date.now()}`);

    try {
      // Configure git
      await worker.execFile("git", ["config", "--global", "user.name", "Sprite Builder"]);
      await worker.execFile("git", ["config", "--global", "user.email", "sprite@emergentbuilder.dev"]);

      // Set up GitHub authentication if token is available
      const ghToken = process.env.GITHUB_TOKEN;
      if (ghToken) {
        // Configure git to use the GitHub token for HTTPS
        const repoUrlWithAuth = CONFIG.repoUrl.replace(
          "https://",
          `https://x-access-token:${ghToken}@`
        );
        await worker.execFile("git", [
          "clone",
          "--branch",
          CONFIG.repoBranch,
          repoUrlWithAuth,
          CONFIG.projectPath,
        ]);
      } else {
        // Clone without authentication (will fail on push if repo is private)
        await worker.execFile("git", [
          "clone",
          "--branch",
          CONFIG.repoBranch,
          CONFIG.repoUrl,
          CONFIG.projectPath,
        ]);
      }

      // Create branch
      await worker.execFile("git", ["checkout", "-b", branchName], {
        cwd: CONFIG.projectPath,
      });

      // Read current codebase files
      console.log(`  📖 Reading files for ${job.id}...`);
      const filesToRead = job.files.length > 0 ? job.files : await this.listFilesInWorker(worker);
      let codebaseContext = "";

      for (const file of filesToRead.slice(0, 10)) { // Limit to 10 files to avoid token overflow
        try {
          const fullPath = `${CONFIG.projectPath}/${file}`;
          const content = await worker.execFile("cat", [fullPath]);
          codebaseContext += `\n\n## File: ${file}\n\`\`\`\n${content.stdout.toString()}\n\`\`\`\n`;
        } catch (e) {
          // File might not exist yet or not readable
        }
      }

      // Call Claude API to generate implementation
      console.log(`  🤖 Generating implementation for ${job.id}...`);
      const systemPrompt = `You are a code implementation agent. Generate bash commands to implement the requested changes.

Output ONLY bash commands that can be executed to make the changes. Use heredocs for file writes.
Do not include any explanations, only executable bash commands.

Example output format:
cat > path/to/file.js << 'EOF'
// file contents here
EOF

cat > path/to/another.css << 'EOF'
/* css here */
EOF`;

      const userPrompt = `## Job Details
- ID: ${job.id}
- Title: ${job.title}
- Description: ${job.description}
- Files to modify: ${job.files.join(", ")}

## Acceptance Criteria
${job.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Current Codebase
${codebaseContext}

Generate bash commands to implement these changes. Output ONLY the bash commands, nothing else.`;

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        temperature: 1,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      });

      const bashScript = response.content
        .filter((block) => block.type === "text")
        .map((block) => (block as any).text)
        .join("\n");

      console.log(`  ⚙️  Executing changes for ${job.id}...`);

      // Write and execute the bash script
      await worker.execFile("bash", [
        "-c",
        `cat > /tmp/apply-changes-${job.id}.sh << 'SCRIPT_EOF'
#!/bin/bash
cd ${CONFIG.projectPath}
${bashScript}
SCRIPT_EOF
chmod +x /tmp/apply-changes-${job.id}.sh`,
      ]);

      await worker.execFile("bash", [`/tmp/apply-changes-${job.id}.sh`]);

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
        coordinatorEvents.emitJobStatus(job.id, 'completed');
      }

      console.log(`✅ Worker ${job.id} completed successfully`);
      return { success: true, branch: branchName };
    } catch (error) {
      console.error(`❌ Worker ${job.id} failed:`, error);

      // Move to failed
      const failedPath = `${CONFIG.jobsDir}/failed/${job.id}.json`;
      if (fs.existsSync(inProgressPath)) {
        fs.renameSync(inProgressPath, failedPath);
        coordinatorEvents.emitJobStatus(job.id, 'failed');
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
    // Checkpoint functionality not available in @fly/sprites v0.0.1
    // Skipping checkpoint creation
    if (typeof this.coordinatorSprite.checkpoint === 'function') {
      console.log(`💾 Creating checkpoint: ${name}`);
      await this.coordinatorSprite.checkpoint(name);
    }
  }

  async restore(name: string) {
    if (!this.coordinatorSprite) return;
    // Restore functionality not available in @fly/sprites v0.0.1
    // Skipping checkpoint restore
    if (typeof this.coordinatorSprite.restore === 'function') {
      console.log(`⏪ Restoring checkpoint: ${name}`);
      await this.coordinatorSprite.restore(name);
    }
  }

  async runIteration(): Promise<boolean> {
    this.iteration++;
    coordinatorEvents.emitIterationStart(this.iteration);
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

    coordinatorEvents.emitIterationComplete(result);

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

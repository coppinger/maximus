#!/usr/bin/env tsx

/**
 * Simple Local Runner for Emergent Builder
 * 
 * This version runs entirely locally without Sprites.
 * Perfect for testing the concept before scaling up.
 * 
 * Usage:
 *   REPO_PATH=/path/to/your/project tsx simple-runner.ts
 */

import { execSync, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

const CONFIG = {
  maxWorkers: 4,
  maxIterations: 5,
  repoPath: process.env.REPO_PATH || process.cwd(),
  orchestrationDir: process.env.ORCHESTRATION_DIR || "./orchestration",
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

function ensureDirectories() {
  const dirs = [
    `${CONFIG.orchestrationDir}/jobs/pending`,
    `${CONFIG.orchestrationDir}/jobs/in-progress`,
    `${CONFIG.orchestrationDir}/jobs/completed`,
    `${CONFIG.orchestrationDir}/jobs/failed`,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function runClaudeCode(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const proc = spawn("claude", ["-p", prompt, "--output-format", "text"], {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
    });

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    proc.stderr.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Claude Code exited with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

async function runAnalysis(iteration: number): Promise<Job[]> {
  console.log(`\n🔍 Running analysis (iteration ${iteration})...`);

  const coordinatorPromptPath = `${CONFIG.orchestrationDir}/COORDINATOR_PROMPT.md`;
  const productVisionPath = `${CONFIG.orchestrationDir}/PRODUCT_VISION.md`;
  const productStatePath = `${CONFIG.orchestrationDir}/PRODUCT_STATE.md`;

  const coordinatorPrompt = fs.existsSync(coordinatorPromptPath)
    ? fs.readFileSync(coordinatorPromptPath, "utf-8")
    : "Analyze the codebase and suggest improvements.";

  const productVision = fs.existsSync(productVisionPath)
    ? fs.readFileSync(productVisionPath, "utf-8")
    : "No product vision defined.";

  const productState = fs.existsSync(productStatePath)
    ? fs.readFileSync(productStatePath, "utf-8")
    : "This is the first iteration.";

  const analysisPrompt = `
${coordinatorPrompt}

## Product Vision
${productVision}

## Current Product State
${productState}

## Iteration
This is iteration ${iteration}.

## Instructions
1. Analyze the current state of this project
2. If you have access to Browserbase MCP, use it to view the running application
3. Generate 4-8 improvement jobs as a JSON array
4. Focus on the most impactful improvements for this iteration
5. Output ONLY the JSON array, no other text

Output the jobs as a JSON array:
`;

  const output = await runClaudeCode(analysisPrompt, CONFIG.repoPath);

  // Extract JSON from output
  const jsonMatch = output.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) {
    console.log("⚠️ No jobs found in analysis output");
    return [];
  }

  try {
    const jobs: Job[] = JSON.parse(jsonMatch[0]);
    console.log(`✅ Generated ${jobs.length} jobs`);
    return jobs;
  } catch (e) {
    console.error("❌ Failed to parse jobs:", e);
    return [];
  }
}

async function executeJob(job: Job, iteration: number): Promise<boolean> {
  const branchName = `emergent/iter-${iteration}/${job.id}`;
  console.log(`\n🔧 Executing job: ${job.id} - ${job.title}`);

  // Move to in-progress
  const pendingPath = `${CONFIG.orchestrationDir}/jobs/pending/${job.id}.json`;
  const inProgressPath = `${CONFIG.orchestrationDir}/jobs/in-progress/${job.id}.json`;
  if (fs.existsSync(pendingPath)) {
    fs.renameSync(pendingPath, inProgressPath);
  }

  try {
    // Create branch
    execSync(`git checkout -b ${branchName}`, {
      cwd: CONFIG.repoPath,
      stdio: "inherit",
    });

    const jobPrompt = `
You are executing a specific improvement job. Stay focused on this task only.

## Job: ${job.title}

${job.description}

## Files to modify
${job.files.map((f) => `- ${f}`).join("\n")}

## Acceptance Criteria
${job.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

## Instructions
1. Make the changes described above
2. Ensure all acceptance criteria are met
3. Keep changes minimal and focused
4. Commit your changes when done

Do NOT make changes outside the scope of this job.
`;

    await runClaudeCode(jobPrompt, CONFIG.repoPath);

    // Commit changes
    execSync(`git add -A`, { cwd: CONFIG.repoPath });
    execSync(`git commit -m "[emergent] ${job.title}" --allow-empty`, {
      cwd: CONFIG.repoPath,
      stdio: "inherit",
    });

    // Move to completed
    const completedPath = `${CONFIG.orchestrationDir}/jobs/completed/${job.id}.json`;
    if (fs.existsSync(inProgressPath)) {
      fs.renameSync(inProgressPath, completedPath);
    }

    // Return to main branch
    execSync(`git checkout main`, { cwd: CONFIG.repoPath, stdio: "inherit" });

    console.log(`✅ Job ${job.id} completed`);
    return true;
  } catch (error) {
    console.error(`❌ Job ${job.id} failed:`, error);

    // Move to failed
    const failedPath = `${CONFIG.orchestrationDir}/jobs/failed/${job.id}.json`;
    if (fs.existsSync(inProgressPath)) {
      fs.renameSync(inProgressPath, failedPath);
    }

    // Try to return to main
    try {
      execSync(`git checkout main`, { cwd: CONFIG.repoPath, stdio: "pipe" });
    } catch {}

    return false;
  }
}

async function mergeBranches(
  branches: string[],
  iteration: number
): Promise<void> {
  console.log(`\n🔀 Merging ${branches.length} branches...`);

  for (const branch of branches) {
    try {
      execSync(`git merge ${branch} --no-edit`, {
        cwd: CONFIG.repoPath,
        stdio: "inherit",
      });
      console.log(`  ✅ Merged ${branch}`);
    } catch {
      console.log(`  ⚠️ Conflict merging ${branch}, skipping`);
      execSync(`git merge --abort`, { cwd: CONFIG.repoPath, stdio: "pipe" });
    }
  }
}

function updateProductState(iteration: number, completed: number, failed: number) {
  const statePath = `${CONFIG.orchestrationDir}/PRODUCT_STATE.md`;
  const content = `# Product State

Last updated: ${new Date().toISOString()}
Current iteration: ${iteration}

## Latest Results
- Jobs completed: ${completed}
- Jobs failed: ${failed}

## Notes
This file is automatically updated after each iteration.
`;
  fs.writeFileSync(statePath, content);
}

async function runIteration(iteration: number): Promise<boolean> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🔄 ITERATION ${iteration}`);
  console.log(`${"=".repeat(60)}`);

  // Run analysis
  const jobs = await runAnalysis(iteration);
  if (jobs.length === 0) {
    console.log("No jobs to execute. Stopping.");
    return false;
  }

  // Write job files
  for (const job of jobs) {
    const jobPath = `${CONFIG.orchestrationDir}/jobs/pending/${job.id}.json`;
    fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
    console.log(`📝 Created job: ${job.id}`);
  }

  // Execute jobs sequentially (for local version)
  // In the Sprites version, these run in parallel
  const completedBranches: string[] = [];
  let failedCount = 0;

  for (const job of jobs) {
    const success = await executeJob(job, iteration);
    if (success) {
      completedBranches.push(`emergent/iter-${iteration}/${job.id}`);
    } else {
      failedCount++;
    }
  }

  // Merge all successful branches
  if (completedBranches.length > 0) {
    await mergeBranches(completedBranches, iteration);
  }

  // Update state
  updateProductState(iteration, completedBranches.length, failedCount);

  console.log(`\n✅ Iteration ${iteration} complete`);
  console.log(`   Completed: ${completedBranches.length}`);
  console.log(`   Failed: ${failedCount}`);

  return iteration < CONFIG.maxIterations;
}

async function main() {
  console.log("🚀 Emergent Builder - Simple Local Runner");
  console.log(`   Repository: ${CONFIG.repoPath}`);
  console.log(`   Max iterations: ${CONFIG.maxIterations}`);
  console.log("");

  ensureDirectories();

  let iteration = 0;
  let continueLoop = true;

  while (continueLoop) {
    iteration++;
    continueLoop = await runIteration(iteration);
  }

  console.log("\n🎉 Emergent Builder complete!");
  console.log(`   Total iterations: ${iteration}`);
}

main().catch(console.error);

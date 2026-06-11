import { spawn } from "child_process";
import type {
  BuilderResult,
  ProviderSettings,
  ReviewVerdict,
  WorkOrderInput,
} from "./types.js";
import type { Provider } from "./provider.js";
import { getClaudeCliPath } from "../config.js";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const BUILDER_TIMEOUT_MS = 10 * 60 * 1000;
const REVIEWER_TIMEOUT_MS = 5 * 60 * 1000;

function resolveCliPath(settings: ProviderSettings): string {
  return settings.cliPath?.trim() || getClaudeCliPath();
}

function resolveModel(settings: ProviderSettings): string {
  return settings.model?.trim() || DEFAULT_MODEL;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnClaude(params: {
  cliPath: string;
  args: string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(params.cliPath, params.args, {
      cwd: params.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, params.timeoutMs);

    child.stdout?.on("data", (buf: Buffer) => { stdout += buf.toString("utf8"); });
    child.stderr?.on("data", (buf: Buffer) => { stderr += buf.toString("utf8"); });

    if (params.stdin) {
      child.stdin?.write(params.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ exitCode: 124, stdout, stderr: stderr + "\n[TIMEOUT]" });
      } else {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

function buildBuilderPrompt(workOrder: WorkOrderInput): string {
  const criteria = workOrder.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const stops = workOrder.stopConditions.map((s, i) => `  ${i + 1}. ${s}`).join("\n");

  return `You are implementing a work order for a software project.

Work Order: ${workOrder.id} - ${workOrder.title}

Goal:
${workOrder.goal}

Acceptance Criteria:
${criteria}

Stop Conditions (stop and report if any of these occur):
${stops}

Instructions:
1. Read the codebase to understand the current state
2. Implement the changes needed to satisfy ALL acceptance criteria
3. Run any existing tests to make sure nothing is broken
4. If tests fail, fix them
5. When done, provide a summary of what you changed

Do NOT commit changes - just make the edits.`;
}

function buildReviewerPrompt(workOrder: WorkOrderInput, builder: BuilderResult): string {
  const criteria = workOrder.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const diffPreview = builder.diff.length > 12000
    ? builder.diff.slice(0, 12000) + "\n\n[diff truncated]"
    : builder.diff;

  return `You are a code reviewer. Review the following changes against the acceptance criteria.

Work Order: ${workOrder.id} - ${workOrder.title}

Goal:
${workOrder.goal}

Acceptance Criteria:
${criteria}

Builder Summary:
${builder.summary}

Files Changed:
${builder.filesChanged.join("\n")}

Diff:
\`\`\`
${diffPreview}
\`\`\`

${builder.tests.length > 0 ? `Test Results:\n${builder.tests.map(t => `- ${t.command}: ${t.passed ? "PASSED" : "FAILED"}`).join("\n")}` : "No tests were run."}

${builder.risks.length > 0 ? `Risks:\n${builder.risks.map(r => `- ${r}`).join("\n")}` : ""}

For each acceptance criterion, state whether it is met or not and why.

End your review with one of:
- VERDICT: APPROVED (if all criteria are met and code quality is acceptable)
- VERDICT: CHANGES_REQUESTED (if any criteria are not met or there are significant issues)`;
}

export const claudeCodeProvider: Provider = {
  name: "claude_code",

  async runBuilder(workOrder: WorkOrderInput, settings: ProviderSettings): Promise<BuilderResult> {
    const cliPath = resolveCliPath(settings);
    const model = resolveModel(settings);
    const prompt = buildBuilderPrompt(workOrder);

    // Use --print for non-interactive mode, --dangerously-skip-permissions for no prompts
    const args = [
      "--print",
      "--model", model,
      "--dangerously-skip-permissions",
      prompt,
    ];

    const result = await spawnClaude({
      cliPath,
      args,
      cwd: workOrder.repoPath,
      timeoutMs: BUILDER_TIMEOUT_MS,
    });

    if (result.exitCode !== 0 && result.exitCode !== 124) {
      const errorMsg = result.stderr.trim().slice(-500) || `claude failed with exit code ${result.exitCode}`;
      return {
        summary: `Builder failed: ${errorMsg}`,
        filesChanged: [],
        diff: "",
        tests: [],
        risks: [`Builder process exited with code ${result.exitCode}`, errorMsg],
      };
    }

    if (result.exitCode === 124) {
      return {
        summary: "Builder timed out",
        filesChanged: [],
        diff: "",
        tests: [],
        risks: ["Builder timed out"],
      };
    }

    const summary = result.stdout.trim();

    // Get git diff
    let diff = "";
    let filesChanged: string[] = [];
    try {
      const diffResult = await spawnClaude({
        cliPath: "git",
        args: ["diff", "--no-color"],
        cwd: workOrder.repoPath,
        timeoutMs: 10000,
      });
      if (diffResult.exitCode === 0) {
        diff = diffResult.stdout;
        const diffFiles = diff.match(/^diff --git a\/(.+?) b\//gm);
        if (diffFiles) {
          filesChanged = diffFiles.map(f => f.replace(/^diff --git a\//, "").replace(/ b\/.*$/, ""));
        }
      }
      const statusResult = await spawnClaude({
        cliPath: "git",
        args: ["status", "--porcelain"],
        cwd: workOrder.repoPath,
        timeoutMs: 10000,
      });
      if (statusResult.exitCode === 0) {
        const untracked = statusResult.stdout.split("\n")
          .filter(l => l.startsWith("??"))
          .map(l => l.slice(3).trim());
        filesChanged = [...new Set([...filesChanged, ...untracked])];
      }
    } catch {
      // ignore
    }

    const risks: string[] = [];
    if (filesChanged.length === 0 && diff === "") {
      risks.push("No files were changed");
    }

    return {
      summary,
      filesChanged,
      diff,
      tests: [],
      risks,
    };
  },

  async runReviewer(workOrder: WorkOrderInput, builder: BuilderResult, settings: ProviderSettings): Promise<ReviewVerdict> {
    const cliPath = resolveCliPath(settings);
    const model = resolveModel(settings);
    const prompt = buildReviewerPrompt(workOrder, builder);

    // For review, use --print (non-interactive, no tool use needed)
    const args = [
      "--print",
      "--model", model,
      prompt,
    ];

    const result = await spawnClaude({
      cliPath,
      args,
      cwd: workOrder.repoPath,
      timeoutMs: REVIEWER_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      return {
        status: "changes_requested",
        notes: [`Reviewer process failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-300)}`],
      };
    }

    const responseText = result.stdout.trim();
    const lower = responseText.toLowerCase();

    // Check for explicit verdict
    const hasApproved = lower.includes("verdict: approved") || lower.includes("verdict:approved");
    const hasChangesRequested = lower.includes("verdict: changes_requested") || lower.includes("verdict:changes_requested") || lower.includes("changes requested");

    let status: "approved" | "changes_requested";
    if (hasApproved && !hasChangesRequested) {
      status = "approved";
    } else if (hasChangesRequested) {
      status = "changes_requested";
    } else {
      // Default to changes_requested if unclear
      status = lower.includes("approved") ? "approved" : "changes_requested";
    }

    return {
      status,
      notes: responseText ? [responseText] : ["Reviewer completed but produced no output"],
    };
  },
};

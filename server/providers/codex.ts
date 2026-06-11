import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type {
  BuilderResult,
  ProviderSettings,
  ReviewVerdict,
  WorkOrderInput,
} from "./types.js";
import type { Provider } from "./provider.js";

const DEFAULT_MODEL = "gpt-5.3-codex-spark";
const DEFAULT_CLI_PATH = "/opt/homebrew/bin/codex";
const BUILDER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const REVIEWER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resolveCliPath(settings: ProviderSettings): string {
  return settings.cliPath?.trim() || DEFAULT_CLI_PATH;
}

function resolveModel(settings: ProviderSettings): string {
  return settings.model?.trim() || DEFAULT_MODEL;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
5. Stage your changed files with \`git add <file>...\` when done (do NOT use \`git add -A\` or \`git add .\` — only stage files you modified or created)
6. When done, provide a summary of what you changed

IMPORTANT RULES:
- Do NOT commit changes - just stage them. The system will handle git commit/merge.
- Do NOT modify any files in the work_orders/ directory - those are managed by the system.
- Do NOT modify .gitignore unless explicitly required by the work order.
- Ensure build artifacts (target/, node_modules/, *.o, etc.) are NOT staged.`;
}

function buildReviewerPrompt(workOrder: WorkOrderInput, builder: BuilderResult): string {
  const criteria = workOrder.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const diffPreview = builder.diff.length > 12000
    ? builder.diff.slice(0, 12000) + "\n\n[diff truncated]"
    : builder.diff;

  return `You are reviewing code changes for a work order.

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

${builder.tests.length > 0 ? `Test Results:\n${builder.tests.map(t => `- ${t.command}: ${t.passed ? "PASSED" : "FAILED"}${t.output ? ` (${t.output.slice(0, 200)})` : ""}`).join("\n")}` : "No tests were run."}

${builder.risks.length > 0 ? `Risks identified by builder:\n${builder.risks.map(r => `- ${r}`).join("\n")}` : ""}

Review the changes against the acceptance criteria. For each criterion, determine if it is met.

Respond with your verdict:
- If ALL acceptance criteria are met and the code looks correct: APPROVED
- If any criteria are not met or there are significant issues: CHANGES_REQUESTED

Provide specific notes explaining your reasoning.`;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function spawnCodex(params: {
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

/**
 * Parse the JSON event stream from `codex exec --json` to extract useful info.
 * Events are newline-delimited JSON. We look for the final assistant message
 * and any command executions.
 */
function parseCodexOutput(stdout: string): {
  summary: string;
  filesChanged: string[];
  commands: Array<{ command: string; exitCode: number | null }>;
} {
  const lines = stdout.split("\n").filter(Boolean);
  let summary = "";
  const filesChanged = new Set<string>();
  const commands: Array<{ command: string; exitCode: number | null }> = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = event.type as string | undefined;

      // Extract messages for summary
      if (type === "message.completed" || type === "turn.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "message" && typeof item.content === "string") {
          summary = item.content;
        }
        // Handle content array format
        if (item?.type === "message" && Array.isArray(item.content)) {
          const textParts = (item.content as Array<Record<string, unknown>>)
            .filter(p => p.type === "text" || p.type === "output_text")
            .map(p => (p.text ?? p.content ?? "") as string);
          if (textParts.length) summary = textParts.join("\n");
        }
      }

      // Extract from response.completed
      if (type === "response.completed") {
        const response = event.response as Record<string, unknown> | undefined;
        if (response && Array.isArray(response.output)) {
          for (const item of response.output as Array<Record<string, unknown>>) {
            if (item.type === "message" && Array.isArray(item.content)) {
              const textParts = (item.content as Array<Record<string, unknown>>)
                .filter(p => p.type === "output_text")
                .map(p => p.text as string);
              if (textParts.length) summary = textParts.join("\n");
            }
          }
        }
      }

      // Extract command executions
      if (type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "command_execution") {
          const cmd = item.command as string | undefined;
          const exitCode = item.exit_code as number | null | undefined;
          if (cmd) commands.push({ command: cmd, exitCode: exitCode ?? null });
        }
      }

      // Extract file paths from various events
      if (type === "item.completed" || type === "item.created") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "file_edit" || item?.type === "file_create") {
          const filePath = (item.path ?? item.file_path) as string | undefined;
          if (filePath) filesChanged.add(filePath);
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return { summary, filesChanged: Array.from(filesChanged), commands };
}

export const codexProvider: Provider = {
  name: "codex",

  async runBuilder(workOrder: WorkOrderInput, settings: ProviderSettings): Promise<BuilderResult> {
    const cliPath = resolveCliPath(settings);
    const model = resolveModel(settings);
    const prompt = buildBuilderPrompt(workOrder);

    const args = [
      "--ask-for-approval", "never",
      "exec", "--json",
      "--model", model,
      "--sandbox", "danger-full-access",
      "-",
    ];

    const result = await spawnCodex({
      cliPath,
      args,
      cwd: workOrder.repoPath,
      stdin: prompt,
      timeoutMs: BUILDER_TIMEOUT_MS,
    });

    if (result.exitCode !== 0 && result.exitCode !== 124) {
      const errorMsg = result.stderr.trim().slice(-500) || `codex exec failed with exit code ${result.exitCode}`;
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
        summary: "Builder timed out after 10 minutes",
        filesChanged: [],
        diff: "",
        tests: [],
        risks: ["Builder timed out - may need more time or simpler task"],
      };
    }

    // Parse the codex output
    const parsed = parseCodexOutput(result.stdout);

    // Stage all changes (builder may not have done it) and get the diff
    let diff = "";
    let filesChanged = parsed.filesChanged;
    try {
      // Stage modified/new files (but not deletions) so git diff --staged captures changes
      // Get only modified files (M) and new files (A) - NOT deletions (D)
      const modifiedResult = await spawnCodex({
        cliPath: "git",
        args: ["diff", "--name-only", "--diff-filter=MA"],
        cwd: workOrder.repoPath,
        timeoutMs: 10000,
      });
      const modifiedFiles = modifiedResult.exitCode === 0 && modifiedResult.stdout.trim()
        ? modifiedResult.stdout.trim().split("\n").filter(Boolean)
        : [];
      
      // Get untracked (new) files
      const untrackedResult = await spawnCodex({
        cliPath: "git",
        args: ["ls-files", "--others", "--exclude-standard"],
        cwd: workOrder.repoPath,
        timeoutMs: 10000,
      });
      const newFiles = untrackedResult.exitCode === 0 && untrackedResult.stdout.trim()
        ? untrackedResult.stdout.trim().split("\n").filter(Boolean)
        : [];
      
      // Combine and stage all modified + new files (no deletions)
      const allFilesToStage = [...new Set([...modifiedFiles, ...newFiles])];
      if (allFilesToStage.length > 0) {
        await spawnCodex({
          cliPath: "git",
          args: ["add", "--", ...allFilesToStage],
          cwd: workOrder.repoPath,
          timeoutMs: 10000,
        });
      }
      // Get diff of staged changes (includes new files now)
      const diffResult = await spawnCodex({
        cliPath: "git",
        args: ["diff", "--staged", "--no-color"],
        cwd: workOrder.repoPath,
        timeoutMs: 10000,
      });
      if (diffResult.exitCode === 0) {
        diff = diffResult.stdout;
        // Also parse files from the diff if we didn't get them from events
        if (filesChanged.length === 0) {
          const diffFiles = diff.match(/^diff --git a\/(.+?) b\//gm);
          if (diffFiles) {
            filesChanged = diffFiles.map(f => f.replace(/^diff --git a\//, "").replace(/ b\/.*$/, ""));
          }
        }
      }
      // Catch any remaining untracked files
      const statusResult = await spawnCodex({
        cliPath: "git",
        args: ["status", "--porcelain"],
        cwd: workOrder.repoPath,
        timeoutMs: 10000,
      });
      if (statusResult.exitCode === 0) {
        const untrackedFiles = statusResult.stdout.split("\n")
          .filter(l => l.startsWith("??"))
          .map(l => l.slice(3).trim());
        filesChanged = [...new Set([...filesChanged, ...untrackedFiles])];
      }
    } catch {
      // Ignore git errors
    }

    // Extract test results from commands
    const tests = parsed.commands
      .filter(c => /test|jest|vitest|pytest|cargo test|npm test/i.test(c.command))
      .map(c => ({
        command: c.command,
        passed: c.exitCode === 0,
        output: undefined as string | undefined,
      }));

    // Identify risks
    const risks: string[] = [];
    if (filesChanged.length === 0 && diff === "") {
      risks.push("No files were changed - builder may not have completed the task");
    }
    if (tests.some(t => !t.passed)) {
      risks.push("Some tests failed");
    }

    return {
      summary: parsed.summary || "Builder completed (no summary extracted)",
      filesChanged,
      diff,
      tests,
      risks,
    };
  },

  async runReviewer(workOrder: WorkOrderInput, builder: BuilderResult, settings: ProviderSettings): Promise<ReviewVerdict> {
    const cliPath = resolveCliPath(settings);
    const model = resolveModel(settings);
    const prompt = buildReviewerPrompt(workOrder, builder);

    const args = [
      "--ask-for-approval", "never",
      "exec", "--json",
      "--model", model,
      "--sandbox", "danger-full-access",
      "-",
    ];

    const result = await spawnCodex({
      cliPath,
      args,
      cwd: workOrder.repoPath,
      stdin: prompt,
      timeoutMs: REVIEWER_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      return {
        status: "changes_requested",
        notes: [`Reviewer process failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-300)}`],
      };
    }

    const parsed = parseCodexOutput(result.stdout);
    const responseText = parsed.summary.toLowerCase();

    // Determine verdict from response
    const isApproved = responseText.includes("approved") && !responseText.includes("changes_requested") && !responseText.includes("changes requested");

    // Extract notes from the response
    const notes = parsed.summary
      ? [parsed.summary]
      : ["Reviewer completed but no detailed response was extracted"];

    return {
      status: isApproved ? "approved" : "changes_requested",
      notes,
    };
  },
};

/**
 * os-eco pi extension
 *
 * Bridges Seeds (sd), Mulch (ml), Canopy (cn), and Overstory (ov) with
 * pi-coding-agent by mapping the overstory Claude Code hooks.json events
 * to pi's native extension lifecycle.
 *
 * Also implements comprehensive safety guards and activity tracking
 * previously handled by overstory-generated .ts files.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isBashToolResult } from "@mariozechner/pi-coding-agent";
import { getOverstorySessionMeta } from "./session";

// ── Constants ──

const TEAM_BLOCKED = new Set([
  "Task", "TeamCreate", "TeamDelete", "SendMessage", "TaskCreate",
  "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
]);

const INTERACTIVE_BLOCKED = new Set(["AskUserQuestion", "EnterPlanMode", "EnterWorktree"]);

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "write", "edit"]);

const NON_IMPLEMENTATION_CAPABILITIES = new Set([
  "orchestrator", "scout", "reviewer", "lead", "coordinator", "supervisor", "monitor",
]);

const COORDINATION_CAPABILITIES = new Set(["orchestrator", "coordinator", "supervisor", "monitor"]);

const SAFE_BASH_PREFIXES = [
  "ov ", "overstory ", "bd ", "sd ", "git status", "git log", "git diff",
  "git show", "git blame", "git branch", "mulch ", "cn ", "canopy ",
];

const DANGEROUS_BASH_PATTERNS = [
  /sed\s+-i/, /sed\s+--in-place/, /echo\s+.*>/, /printf\s+.*>/, /cat\s+.*>/,
  /tee\s/, /\bvim\b/, /\bnano\b/, /\bvi\b/, /\bmv\s/, /\bcp\s/, /\brm\s/,
  /\bmkdir\s/, /\btouch\s/, /\bchmod\s/, /\bchown\s/, />>/, /\bgit\s+add\b/,
  /\bgit\s+commit\b/, /\bgit\s+merge\b/, /\bgit\s+push\b/, /\bgit\s+reset\b/,
  /\bgit\s+checkout\b/, /\bgit\s+rebase\b/, /\bgit\s+stash\b/, /\bnpm\s+install\b/,
  /\bbun\s+install\b/, /\bbun\s+add\b/, /\bbun\s+-e\b/, /\bbun\s+--eval\b/,
  /\bnode\s+-e\b/, /\bnode\s+--eval\b/, /\bdeno\s+eval\b/, /\bpython3?\s+-c\b/,
  /\bperl\s+-e\b/, /\bruby\s+-e\b/,
];

const FILE_MODIFYING_BASH_PATTERNS = [
  /sed\s+-i/, /sed\s+--in-place/, /echo\s+.*>/, /printf\s+.*>/, /cat\s+.*>/,
  /tee\s/, /\bmv\s/, /\bcp\s/, /\brm\s/, /\bmkdir\s/, /\btouch\s/, /\bchmod\s/,
  /\bchown\s/, />>/, /\binstall\s/, /\brsync\s/,
];

// ── Extension Implementation ──

export default function (pi: ExtensionAPI) {
  const session = getOverstorySessionMeta();
  const AGENT_NAME = session.agentName;
  const CAPABILITY = session.capability;
  const WORKTREE_PATH = session.worktreePath;
  const TASK_ID = session.taskId;
  const isOverstorySession = session.isOverstorySession;
  const isNonImpl = NON_IMPLEMENTATION_CAPABILITIES.has(CAPABILITY);
  const isCoordination = COORDINATION_CAPABILITIES.has(CAPABILITY);

  // Cached prime context — injected into every systemPrompt this session
  let primeContext = "";

  // ── SessionStart ──────────────────────────────────────────────────────────
  pi.on("session_start", async () => {
    // Prime Seeds everywhere; only prime Overstory when the session is managed.
    const [ovResult, sdResult] = await Promise.allSettled([
      isOverstorySession ? pi.exec("ov", ["prime", "--agent", AGENT_NAME]) : Promise.resolve(null),
      pi.exec("sd", ["prime"]),
    ]);

    const parts: string[] = [];
    if (ovResult.status === "fulfilled" && ovResult.value?.code === 0) {
      const out = ovResult.value.stdout.trim();
      if (out) parts.push(out);
    }
    if (sdResult.status === "fulfilled" && sdResult.value.code === 0) {
      const out = sdResult.value.stdout.trim();
      if (out) parts.push(out);
    }
    primeContext = parts.join("\n\n---\n\n");
  });

  // ── UserPromptSubmit ──────────────────────────────────────────────────────
  pi.on("before_agent_start", async (event, _ctx) => {
    const mailResult = isOverstorySession
      ? await pi.exec("ov", ["mail", "check", "--inject", "--agent", AGENT_NAME]).catch(() => null)
      : null;
    const mailText = mailResult?.code === 0 ? mailResult.stdout.trim() : "";

    const newSystemPrompt = primeContext
      ? `${event.systemPrompt}\n\n---\n\n${primeContext}`
      : event.systemPrompt;

    return {
      ...(mailText ? {
        message: {
          customType: "os-eco-mail",
          content: `📬 **Agent mail:**\n\n${mailText}`,
          display: true,
        },
      } : {}),
      systemPrompt: newSystemPrompt,
    };
  });

  // ── PreToolUse/Guards ─────────────────────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    // Activity tracking: update lastActivity so watchdog knows agent is alive.
    // Fire-and-forget — do not await (avoids latency on every tool call).
    if (isOverstorySession) {
      pi.exec("ov", ["log", "tool-start", "--agent", AGENT_NAME, "--tool-name", event.toolName]).catch(() => {});
    }

    if (!isOverstorySession) return;

    // 1. Block native team/task tools (all agents).
    if (TEAM_BLOCKED.has(event.toolName)) {
      return { block: true, reason: `Overstory agents must use 'ov sling' for delegation — ${event.toolName} is not allowed` };
    }

    // 2. Block interactive tools (all agents).
    if (INTERACTIVE_BLOCKED.has(event.toolName)) {
      return { block: true, reason: `${event.toolName} requires human interaction — use ov mail (--type question) to escalate` };
    }

    // 3. Block write tools for non-implementation capabilities.
    if (isNonImpl && WRITE_TOOLS.has(event.toolName)) {
      return { block: true, reason: `${CAPABILITY} agents cannot modify files — ${event.toolName} is not allowed` };
    }

    // 4. Path boundary enforcement for write/edit tools (all agents).
    if (WRITE_TOOLS.has(event.toolName)) {
      const filePath = String(
        (event.input as Record<string, unknown>)?.path ??
        (event.input as Record<string, unknown>)?.file_path ??
        (event.input as Record<string, unknown>)?.notebook_path ??
        "",
      );
      if (filePath && !filePath.startsWith(WORKTREE_PATH + "/") && filePath !== WORKTREE_PATH) {
        return { block: true, reason: "Path boundary violation: file is outside your assigned worktree. All writes must target files within your worktree." };
      }
    }

    // 5. Bash command guards.
    if (event.toolName === "bash" || event.toolName === "Bash") {
      const cmd = String((event.input as Record<string, unknown>)?.command ?? "");

      // Universal danger guards (all agents).
      if (/\bgit\s+push\b/.test(cmd)) {
        return { block: true, reason: "git push is blocked — use ov merge to integrate changes, push manually when ready" };
      }
      if (/git\s+reset\s+--hard/.test(cmd)) {
        return { block: true, reason: "git reset --hard is not allowed — it destroys uncommitted work" };
      }
      const branchMatch = /git\s+checkout\s+-b\s+(\\S+)/.exec(cmd);
      if (branchMatch) {
        const branch = branchMatch[1] ?? "";
        if (!branch.startsWith(`overstory/${AGENT_NAME}/`)) {
          return { block: true, reason: `Branch must follow overstory/${AGENT_NAME}/{task-id} convention` };
        }
      }

      // Tracker ownership guards
      if (TASK_ID) {
        if (/^\s*(sd|bd)\s+close\s/.test(cmd)) {
          const match = /^\s*(sd|bd)\s+close\s+([^ ]+)/.exec(cmd);
          if (match && match[2] !== TASK_ID) {
            return { block: true, reason: `Cannot close issue ${match[2]} — agents may only close their own task (${TASK_ID}).` };
          }
        }
        if (/^\s*(sd|bd)\s+update\s.*--status/.test(cmd)) {
          const match = /^\s*(sd|bd)\s+update\s+([^ ]+)/.exec(cmd);
          if (match && match[2] !== TASK_ID) {
            return { block: true, reason: `Cannot update issue ${match[2]} — agents may only update their own task (${TASK_ID}).` };
          }
        }
      }

      if (isNonImpl) {
        // Non-implementation agents: whitelist safe prefixes, block dangerous patterns.
        const trimmed = cmd.trimStart();
        const coordinationSafe = isCoordination ? ["git add", "git commit"] : [];
        const allSafe = [...SAFE_BASH_PREFIXES, ...coordinationSafe];

        if (allSafe.some((p) => trimmed.startsWith(p))) {
          return; // Safe command — allow through.
        }
        if (DANGEROUS_BASH_PATTERNS.some((re) => re.test(cmd))) {
          return { block: true, reason: `${CAPABILITY} agents cannot modify files — this command is not allowed` };
        }
      } else {
        // Implementation agents: path boundary on file-modifying Bash commands.
        if (FILE_MODIFYING_BASH_PATTERNS.some((re) => re.test(cmd))) {
          const tokens = cmd.split(/\s+/);
          const paths = tokens
            .filter((t) => t.startsWith("/"))
            .map((t) => t.replace(/[";>]*$/, ""));
          for (const p of paths) {
            if (!p.startsWith("/dev/") && !p.startsWith("/tmp/") && !p.startsWith(WORKTREE_PATH + "/") && p !== WORKTREE_PATH) {
              return { block: true, reason: "Bash path boundary violation: command targets a path outside your worktree. All file modifications must stay within your assigned worktree." };
            }
          }
        }
      }
    }
  });

  // ── PostToolUse ───────────────────────────────────────────────────────────
  pi.on("tool_execution_end", async (event, _ctx) => {
    if (isOverstorySession) {
      pi.exec("ov", ["log", "tool-end", "--agent", AGENT_NAME, "--tool-name", event.toolName]).catch(() => {});
    }
  });

  // ── Bash Tool Result ──────────────────────────────────────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    if (!isBashToolResult(event)) return;
    const cmd = (event.input.command as string | undefined) ?? "";
    if (/\bgit\s+commit\b/.test(cmd)) {
      pi.exec("ml", ["diff", "HEAD~1"]).catch(() => {});
    }
  });

  // ── Stop ──────────────────────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    await Promise.allSettled([
      ...(isOverstorySession ? [pi.exec("ov", ["log", "session-end", "--agent", AGENT_NAME])] : []),
      pi.exec("ml", ["learn"]),
    ]);
  });

  // Also handle Graceful Agent End (task done)
  pi.on("agent_end", async (_event) => {
    if (isOverstorySession) {
      await pi.exec("ov", ["log", "session-end", "--agent", AGENT_NAME]).catch(() => {});
    }
  });
}

export type OverstorySessionKind =
	| "standalone"
	| "orchestrator"
	| "coordinator"
	| "monitor"
	| "worker";

export interface OverstorySessionMeta {
	sessionKind: OverstorySessionKind;
	isOverstorySession: boolean;
	agentName: string;
	capability: string;
	worktreePath: string;
	projectRoot: string;
	taskId?: string;
}

const SESSION_KINDS = new Set<OverstorySessionKind>([
	"standalone",
	"orchestrator",
	"coordinator",
	"monitor",
	"worker",
]);

const OVERSTORY_WORKTREE_RE = /[\\/]\.overstory[\\/]worktrees[\\/]/;

function normalizeSessionKind(value: string | undefined): OverstorySessionKind | undefined {
	if (!value) return undefined;
	return SESSION_KINDS.has(value as OverstorySessionKind)
		? (value as OverstorySessionKind)
		: undefined;
}

function isOverstoryWorktree(cwd: string): boolean {
	return OVERSTORY_WORKTREE_RE.test(cwd);
}

function deriveLegacySessionKind(cwd: string, capability: string | undefined): OverstorySessionKind {
	switch (capability) {
		case "orchestrator":
			return "orchestrator";
		case "coordinator":
		case "supervisor":
			return "coordinator";
		case "monitor":
			return "monitor";
		default:
			return isOverstoryWorktree(cwd) ? "worker" : "coordinator";
	}
}

function inferProjectRoot(cwd: string): string {
	const match = cwd.match(/^(.*?)(?:[\\/]\.overstory[\\/]worktrees[\\/].*)$/);
	return match?.[1] || cwd;
}

function defaultCapabilityFor(sessionKind: OverstorySessionKind): string {
	switch (sessionKind) {
		case "orchestrator":
			return "orchestrator";
		case "coordinator":
			return "coordinator";
		case "monitor":
			return "monitor";
		case "worker":
			return "worker";
		case "standalone":
			return "standalone";
	}
}

export function getOverstorySessionMeta(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): OverstorySessionMeta {
	const explicitKind = normalizeSessionKind(env.OVERSTORY_SESSION_KIND);
	const legacyManaged = Boolean(env.OVERSTORY_AGENT_NAME) || isOverstoryWorktree(cwd);
	const sessionKind =
		explicitKind ?? (legacyManaged ? deriveLegacySessionKind(cwd, env.OVERSTORY_CAPABILITY) : "standalone");
	const isOverstorySession = sessionKind !== "standalone";

	return {
		sessionKind,
		isOverstorySession,
		agentName: env.OVERSTORY_AGENT_NAME || "pi",
		capability: env.OVERSTORY_CAPABILITY || defaultCapabilityFor(sessionKind),
		worktreePath: env.OVERSTORY_WORKTREE_PATH || cwd,
		projectRoot: env.OVERSTORY_PROJECT_ROOT || inferProjectRoot(cwd),
		...(env.OVERSTORY_TASK_ID ? { taskId: env.OVERSTORY_TASK_ID } : {}),
	};
}

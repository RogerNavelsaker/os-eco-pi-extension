/**
 * workflow-status.ts
 *
 * Superpowers-inspired workflow guidance adapted to Singularity's os-eco stack.
 * Keeps a lightweight view of the current session phase visible in the UI,
 * exposes a /workflow command, and injects concise next-step guidance into
 * the system prompt before each agent turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface MulchWarning {
	domain: string;
	level: "over" | "approaching";
}

interface WorkflowState {
	phase: "idle" | "plan" | "implement" | "verify";
	activeChanges: number | null;
	inProgressIssues: number | null;
	dirtyFiles: number | null;
	seedsCount: number | null;
	mulchWarnings: MulchWarning[] | null;
	steps: string[];
}

async function fetchSeedsCount(pi: ExtensionAPI): Promise<number | null> {
	const result = await pi.exec("sd", ["ready", "--json"]);
	if (result.code !== 0) return null;
	try {
		const data = JSON.parse(result.stdout) as { count?: number };
		return data.count ?? null;
	} catch {
		return null;
	}
}

async function fetchMulchWarnings(pi: ExtensionAPI): Promise<MulchWarning[] | null> {
	const result = await pi.exec("ml", ["status"]);
	if (result.code !== 0) return null;
	const warnings: MulchWarning[] = [];
	for (const line of result.stdout.split("\n")) {
		const trimmed = line.trim();
		const domain = trimmed.split(":")[0]?.trim();
		if (!domain) continue;
		if (trimmed.includes("OVER HARD LIMIT")) {
			warnings.push({ domain, level: "over" });
		} else if (trimmed.includes("approaching limit")) {
			warnings.push({ domain, level: "approaching" });
		}
	}
	return warnings;
}

async function countOpenSpecChanges(pi: ExtensionAPI): Promise<number | null> {
	const result = await pi.exec("openspec", ["list"]);
	if (result.code !== 0) return null;
	const stdout = result.stdout.trim();
	if (!stdout || stdout.includes("No active changes found")) return 0;
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- ")).length;
}

async function countInProgressIssues(pi: ExtensionAPI): Promise<number | null> {
	const result = await pi.exec("sd", ["list", "--status", "in_progress"]);
	if (result.code !== 0) return null;
	const stdout = result.stdout.trim();
	if (!stdout || stdout.includes("0 issue(s)")) return 0;
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- ")).length;
}

async function countDirtyFiles(pi: ExtensionAPI): Promise<number | null> {
	const result = await pi.exec("git", ["status", "--porcelain"]);
	if (result.code !== 0) return null;
	const stdout = result.stdout.trim();
	if (!stdout) return 0;
	return stdout.split("\n").filter(Boolean).length;
}

function buildState(
	activeChanges: number | null,
	inProgressIssues: number | null,
	dirtyFiles: number | null,
	seedsCount: number | null,
	mulchWarnings: MulchWarning[] | null,
): WorkflowState {
	let phase: WorkflowState["phase"] = "idle";
	let steps = [
		"Pick or create a Seeds issue before starting significant work.",
		"If the request adds a capability or changes architecture, start with OpenSpec.",
	];

	if ((dirtyFiles ?? 0) > 0) {
		phase = "verify";
		steps = [
			"Run verification for the touched area before claiming completion.",
			"If work is complete, run the landing sequence: tests/checks, Mulch, Seeds, merge/push.",
		];
	} else if ((activeChanges ?? 0) > 0) {
		phase = "plan";
		steps = [
			"Use OpenSpec as the design gate: refine proposal, tasks, and validation first.",
			"Do not implement unapproved changes; link work to a Seeds issue.",
		];
	} else if ((inProgressIssues ?? 0) > 0) {
		phase = "implement";
		steps = [
			"Work from the approved plan: read proposal/tasks, then execute small steps.",
			"Use review/debug/verification skills instead of ad-hoc iteration.",
		];
	}

	return {
		phase,
		activeChanges,
		inProgressIssues,
		dirtyFiles,
		seedsCount,
		mulchWarnings,
		steps,
	};
}

async function collectState(pi: ExtensionAPI): Promise<WorkflowState> {
	const [activeChanges, inProgressIssues, dirtyFiles, seedsCount, mulchWarnings] = await Promise.all([
		countOpenSpecChanges(pi),
		countInProgressIssues(pi),
		countDirtyFiles(pi),
		fetchSeedsCount(pi),
		fetchMulchWarnings(pi),
	]);
	return buildState(activeChanges, inProgressIssues, dirtyFiles, seedsCount, mulchWarnings);
}

function renderWidget(ctx: ExtensionContext, state: WorkflowState): void {
	if (!ctx.hasUI) return;

	// Only show the status widget in standalone sessions.
	// Hide it in Overstory worktrees to reduce clutter.
	const isOverstoryWorktree = process.cwd().includes(".overstory/worktrees/");
	if (isOverstoryWorktree) {
		ctx.ui.setWidget("os-eco", []); // Clear the widget
		return;
	}

	const theme = ctx.ui.theme;

	const phaseText =
		state.phase === "verify"
			? theme.fg("warning", state.phase)
			: state.phase === "implement"
				? theme.fg("success", state.phase)
				: theme.fg("muted", state.phase);

	// Seeds
	let seedsValue: string;
	if (state.seedsCount === null) {
		seedsValue = theme.fg("warning", "unavailable");
	} else {
		seedsValue = theme.fg("muted", `${state.seedsCount} open`);
	}
	const seedsPart = `🌱 ${theme.fg("dim", "seeds")} ${seedsValue}`;

	// Mulch
	let mulchValue: string;
	if (state.mulchWarnings === null) {
		mulchValue = theme.fg("warning", "unavailable");
	} else if (state.mulchWarnings.length === 0) {
		mulchValue = theme.fg("success", "ok");
	} else {
		const parts = state.mulchWarnings.map((w) => {
			const suffix = w.level === "over" ? " over limit" : " approaching";
			return theme.fg("warning", w.domain + suffix);
		});
		mulchValue = parts.join(theme.fg("dim", ", "));
	}
	const mulchPart = `🌿 ${theme.fg("dim", "mulch")} ${mulchValue}`;

	// Workflow Phase
	const iconForPhase = state.phase === "verify" ? "🔍" : state.phase === "implement" ? "⚡️" : state.phase === "plan" ? "📝" : "💤";
	const phasePart = `${iconForPhase} ${theme.fg("dim", "workflow")} ${phaseText}`;

	// Next steps
	const nextPart = `💡 ${theme.fg("dim", "next")} ${theme.fg("muted", state.steps[0] ?? "")}`;

	const combinedLine = `${seedsPart}   ${mulchPart}   ${phasePart}   ${nextPart}`;

	ctx.ui.setWidget("os-eco", [combinedLine]);
}

function promptBlock(state: WorkflowState): string {
	const details = [
		`Current workflow phase: ${state.phase}`,
		state.activeChanges === null ? "Active OpenSpec changes: unavailable" : `Active OpenSpec changes: ${state.activeChanges}`,
		state.inProgressIssues === null ? "Seeds in progress: unavailable" : `Seeds in progress: ${state.inProgressIssues}`,
		state.dirtyFiles === null ? "Dirty files: unavailable" : `Dirty files: ${state.dirtyFiles}`,
		"Next steps:",
		...state.steps.map((step) => `- ${step}`),
	];
	return ["# Workflow Guidance", ...details].join("\n");
}

export default function (pi: ExtensionAPI) {
	let cachedState: WorkflowState | null = null;

	async function refresh(ctx: ExtensionContext): Promise<void> {
		cachedState = await collectState(pi);
		renderWidget(ctx, cachedState);
	}

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!cachedState) {
			await refresh(ctx);
		}
		if (!cachedState) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${promptBlock(cachedState)}`,
		};
	});

	pi.registerCommand("workflow", {
		description: "Show the current Singularity workflow phase and next steps",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			if (!cachedState) {
				ctx.ui.notify("Workflow state unavailable", "warning");
				return;
			}
			const message = [`phase: ${cachedState.phase}`, ...cachedState.steps].join("\n• ");
			ctx.ui.notify(`Workflow\n• ${message}`, "info");
		},
	});

	pi.registerCommand("refresh-status", {
		description: "Refresh seeds/mulch/workflow status widget",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			ctx.ui.notify("Status widget refreshed", "info");
		},
	});
}

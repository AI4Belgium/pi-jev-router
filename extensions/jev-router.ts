/**
 * Jev router - a virtual model `jev/auto` that lets the Jev classifier pick one of four
 * Azure Foundry Claude deployments (provider `azure-foundry-anthropic` in models.json), by how
 * demanding the request is:
 *
 *   trivial  -> claude-haiku-4-5
 *   standard -> claude-sonnet-4-6
 *   complex  -> claude-opus-5-5
 *   frontier -> claude-fable-5-1
 *
 * Every user message is classified and may pick any tier.
 *
 * Inside the agent loop (tool follow-ups) the router can only ESCALATE, never de-escalate:
 * a switch costs a prompt-cache miss, so moving down mid-task rarely saves money, while moving
 * up when a cheaper model is struggling is where the value is. Jev is only consulted when the
 * transcript shows trouble (tool errors, failing tests, the same file edited again and again),
 * and at most once every CHECK_EVERY steps. An escalation needs a confident Jev answer.
 *
 * Retries stay on the failed model: they are mostly provider errors (overload, timeouts,
 * context overflow), not a sign that the task is too hard.
 *
 * The tier is router state: Pi stores it on the session branch, so it follows the session tree
 * and survives compaction. Requests outside the agent loop (compaction summaries, extension
 * calls) go to Sonnet.
 *
 * Requires TYPESAFE_API_KEY and the `azure-foundry-anthropic` provider configured in models.json.
 * Usage: pi --model jev/auto
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

const PROVIDER = "azure-foundry-anthropic";

const TIERS = {
	trivial: "claude-haiku-4-5",
	standard: "claude-sonnet-4-6",
	complex: "claude-opus-5-5",
	frontier: "claude-fable-5-1",
} as const;

type Tier = keyof typeof TIERS;
const TIER_ORDER: Tier[] = ["trivial", "standard", "complex", "frontier"];
const DEFAULT_TIER: Tier = "standard";
/** Model for requests outside the agent loop, such as compaction summaries. */
const DIRECT_TIER: Tier = "standard";

const TIER_EMOJI: Record<Tier, string> = { trivial: "⚡", standard: "🔵", complex: "🟠", frontier: "🔴" };

// ── In-loop escalation tuning ──────────────────────────────────────────────
/** Minimum loop steps between two Jev checks within one turn. */
const CHECK_EVERY = 5;
/** Recent tool results inspected for trouble. */
const RECENT_RESULTS = 6;
/** Failing tool results among the recent ones that count as struggling. */
const ERROR_THRESHOLD = 2;
/** Edits to the same file within one turn that count as churning. */
const SAME_FILE_EDITS = 3;
/** Jev probability required for the chosen higher tier before escalating. */
const MIN_CONFIDENCE = 0.7;

/** Output that looks like failing tests or a broken build, even when the command exited 0. */
const FAILURE_PATTERN =
	/\b(\d+ (?:failed|failing|errors?)|FAILED|FAIL\b|Traceback|AssertionError|panicked at|error TS\d+|SyntaxError|Segmentation fault)/;

interface JevState {
	tier: Tier;
	model: string;
	/** Loop step (assistant responses since the last user message) at the last in-loop Jev check. */
	checkedAtStep: number;
}

type JevRequest = ModelRouteRequest<JevState>;

const rank = (tier: Tier) => TIER_ORDER.indexOf(tier);

function routeTo(request: JevRequest, ctx: ExtensionContext, tier: Tier, state?: JevState): ModelRoute<JevState> {
	const id = TIERS[tier];
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

function textOf(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The last user message plus a little earlier user context, newest last. */
function recentUserText(messages: readonly Message[]): { prompt: string; earlier: string[] } {
	const users = messages.filter((message) => message.role === "user");
	const prompt = users.at(-1) ? textOf(users.at(-1)!).slice(0, 16_000) : "";
	const earlier = users
		.slice(-4, -1)
		.map((message) => textOf(message).slice(0, 1_000))
		.filter((text) => text.length > 0);
	return { prompt, earlier };
}

function notify(ctx: ExtensionContext, text: string) {
	if (ctx.hasUI) ctx.ui.notify(text, "info");
}

/** Ask Jev which tier the current user message needs. Falls back to the previous or default tier. */
async function chooseTier(request: JevRequest, ctx: ExtensionContext): Promise<Tier> {
	const previous = request.state?.tier ?? DEFAULT_TIER;
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return previous;

	const { prompt, earlier } = recentUserText(request.messages);
	if (!prompt) return previous;

	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: { prompt, earlier_user_messages: earlier, previous_tier: request.state?.tier ?? null },
			questions: {
				tier: {
					type: "choice",
					instructions:
						"Which capability tier does the work requested in `prompt` need? " +
						"If `prompt` is a short follow-up that continues the task described in `earlier_user_messages` " +
						"(for example an approval, a clarification, or 'go ahead'), keep `previous_tier`.",
					criteria: {
						trivial: "Quick factual questions, one-line edits, renames, formatting, running a command, summarising short text",
						standard: "Ordinary features, bug fixes, tests, refactors within a few files, code review, explanations",
						complex: "Subtle design decisions, cross-cutting changes across many files, hard debugging, performance work, architecture",
						frontier: "Research-grade or open-ended problems, long multi-step autonomous work, high-stakes correctness, novel algorithms",
					},
				},
			},
		},
		{ signal: request.signal },
	);

	const answer = result.stopReason === "stop" ? result.answers.tier : undefined;
	if (answer?.type !== "choice") return previous;
	const choice = answer.choice as Tier;
	return TIER_ORDER.includes(choice) ? choice : previous;
}

// ── In-loop trouble detection ──────────────────────────────────────────────

interface LoopSignals {
	/** Assistant responses since the last user message. */
	step: number;
	recentErrors: number;
	/** Path edited most often this turn, and how many times. */
	churn?: { path: string; edits: number };
	/** Short excerpts of the recent failing tool output, for Jev. */
	errorExcerpts: string[];
	lastAssistantText: string;
}

function loopSignals(messages: readonly Message[]): LoopSignals {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	const turn = messages.slice(lastUser + 1);

	const step = turn.filter((message) => message.role === "assistant").length;

	const results = turn.filter((message) => message.role === "toolResult").slice(-RECENT_RESULTS);
	const failing = results.filter((message) => message.isError || FAILURE_PATTERN.test(textOf(message)));
	const errorExcerpts = failing.slice(-3).map((message) => `${message.toolName}: ${textOf(message).slice(-600)}`);

	const editsByPath = new Map<string, number>();
	for (const message of turn) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || (block.name !== "edit" && block.name !== "write")) continue;
			const path = (block.arguments as { path?: unknown }).path;
			if (typeof path === "string") editsByPath.set(path, (editsByPath.get(path) ?? 0) + 1);
		}
	}
	const [path, edits] = [...editsByPath].sort((a, b) => b[1] - a[1])[0] ?? [];
	const churn = path && edits ? { path, edits } : undefined;

	const lastAssistant = turn.filter((message) => message.role === "assistant").at(-1);
	const lastAssistantText = lastAssistant ? textOf(lastAssistant).slice(-2_000) : "";

	return { step, recentErrors: failing.length, churn, errorExcerpts, lastAssistantText };
}

/** Why the loop looks stuck, or undefined when it is going fine. */
function troubleReason(signals: LoopSignals): string | undefined {
	if (signals.recentErrors >= ERROR_THRESHOLD) {
		return `${signals.recentErrors} failing tool results in the last ${RECENT_RESULTS}`;
	}
	if (signals.churn && signals.churn.edits >= SAME_FILE_EDITS) {
		return `${signals.churn.path.split("/").at(-1)} edited ${signals.churn.edits}×`;
	}
	return undefined;
}

/** Ask Jev whether the next step needs a higher tier. Returns the higher tier, or undefined to stay. */
async function escalationTier(
	request: JevRequest,
	ctx: ExtensionContext,
	current: Tier,
	signals: LoopSignals,
	reason: string,
): Promise<Tier | undefined> {
	const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
	if (!jev) return undefined;
	const { prompt } = recentUserText(request.messages);

	const result = await ctx.modelRegistry.classify(
		jev,
		{
			state: {
				task: prompt.slice(0, 8_000),
				current_tier: current,
				steps_so_far: signals.step,
				trouble: reason,
				recent_tool_errors: signals.errorExcerpts,
				latest_assistant_message: signals.lastAssistantText,
			},
			questions: {
				tier: {
					type: "choice",
					instructions:
						"An AI coding agent running at `current_tier` is part-way through `task` and is showing `trouble`. " +
						"Which capability tier does the NEXT step need? Keep `current_tier` when the trouble looks routine " +
						"(a typo, a missing import, an expected failing test before a fix) and the agent is making progress. " +
						"Choose a higher tier only when the agent seems stuck, is repeating itself, or the problem turned out harder than expected.",
					criteria: {
						trivial: "Mechanical steps: running commands, small obvious fixes",
						standard: "Ordinary debugging and implementation the agent is handling",
						complex: "Hard debugging, subtle interactions, the agent is going in circles",
						frontier: "The agent is clearly stuck on a deep or novel problem after repeated attempts",
					},
				},
			},
		},
		{ signal: request.signal },
	);

	const answer = result.stopReason === "stop" ? result.answers.tier : undefined;
	if (answer?.type !== "choice") return undefined;
	const choice = answer.choice as Tier;
	if (!TIER_ORDER.includes(choice) || rank(choice) <= rank(current)) return undefined;
	return (answer.probabilities[choice] ?? 0) >= MIN_CONFIDENCE ? choice : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<JevState>({
		provider: "jev",
		id: "auto",
		name: "Auto (Jev → Haiku/Sonnet/Opus/Fable)",
		thinkingLevels: ["low", "medium", "high", "xhigh"],
		// Haiku is the smallest of the four; shown before the first response.
		contextWindow: 200_000,
		maxTokens: 64_000,
		async route(request, ctx) {
			if (request.reason === "direct") return routeTo(request, ctx, DIRECT_TIER);

			// New user message: classify it; any tier is allowed.
			if (request.reason === "user") {
				const tier = await chooseTier(request, ctx);
				notify(ctx, `${TIER_EMOJI[tier]} jev → ${tier} (${TIERS[tier]})`);
				const unchanged = request.state?.tier === tier && request.state.checkedAtStep === 0;
				return routeTo(request, ctx, tier, unchanged ? undefined : { tier, model: TIERS[tier], checkedAtStep: 0 });
			}

			// Retry: stay on the model that failed (usually a provider error, not task difficulty).
			if (request.reason === "retry") {
				const sticky = request.failed ?? request.previous;
				if (request.state) return routeTo(request, ctx, request.state.tier);
				if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
				return routeTo(request, ctx, DEFAULT_TIER);
			}

			// Continuation inside the agent loop: escalate only, and only when the loop shows trouble.
			const state = request.state;
			if (!state) {
				const sticky = request.previous;
				if (sticky) return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
				return routeTo(request, ctx, DEFAULT_TIER);
			}
			const current = state.tier;
			if (current === TIER_ORDER.at(-1)) return routeTo(request, ctx, current);

			const signals = loopSignals(request.messages);
			const reason = troubleReason(signals);
			// checkedAtStep can be ahead of `step` after compaction trimmed the turn; treat as reset.
			const lastCheck = state.checkedAtStep <= signals.step ? state.checkedAtStep : 0;
			if (!reason || signals.step - lastCheck < CHECK_EVERY) return routeTo(request, ctx, current);

			let higher: Tier | undefined;
			try {
				higher = await escalationTier(request, ctx, current, signals, reason);
			} catch (error) {
				if (request.signal?.aborted) throw error;
				higher = undefined; // Jev unavailable: keep going on the current tier.
			}
			if (higher) {
				notify(ctx, `${TIER_EMOJI[higher]} jev ↑ ${higher} (${TIERS[higher]}) — ${reason}`);
				return routeTo(request, ctx, higher, { tier: higher, model: TIERS[higher], checkedAtStep: signals.step });
			}
			// Checked and staying: record the step so the next check waits CHECK_EVERY steps.
			return routeTo(request, ctx, current, { ...state, checkedAtStep: signals.step });
		},
	});
}

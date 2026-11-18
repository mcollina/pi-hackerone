import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HackerOneClient,
	changeReportState,
	changeableReportStates,
	createComment,
	filterComments,
	getReport,
	isAppError,
	listAllActivities,
	reportStates,
	validateStateChange,
	type Activity,
	type ChangeableReportState,
	type Report,
} from "@matteo.collina/hackerone";
import { Type } from "typebox";

const TOOL_NAME = "hackerone_report";
const COMMENT_TOOL_NAME = "hackerone_comment";
const STATE_TOOL_NAME = "hackerone_change_state";

// States and their definitions come from the client library, so the tool,
// the command, and the README stay in step with it.
const STATE_INFO = reportStates.filter((info) => info.changeable).map(({ state, status, requiresMessage, definition }) => {
	const summary = `${status === "open" ? "Open" : "Closed"}${requiresMessage ? ", message required" : ""}. ${definition}`;
	return { state, requiresMessage, summary };
});
const STATE_DEFINITIONS = STATE_INFO.map(({ state, summary }) => `- ${state}: ${summary}`).join("\n");
const MESSAGE_STATES = STATE_INFO.filter((info) => info.requiresMessage).map((info) => info.state).join(", ");
const STATE_TRANSITION_RULE = "Closed reports (resolved, informative, duplicate, not-applicable, spam) can only move back to new or triaged.";
const STATE_COMMAND_USAGE = "/hackerone-state <number> <state> [--message \"text\"] [--original-report-id id] [--attachment-id id]";

const reportParameters = Type.Object({
	reportId: Type.Integer({
		minimum: 1,
		description: "HackerOne report number/id to fetch.",
	}),
	includeComments: Type.Optional(Type.Boolean({
		default: false,
		description: "Fetch report comments from HackerOne's activity API when possible.",
	})),
	program: Type.Optional(Type.String({
		description: "Program handle override. Usually inferred from the report; useful when fetching comments.",
	})),
});

interface FetchReportOptions {
	reportId: number;
	includeComments?: boolean;
	program?: string;
}

const commentParameters = Type.Object({
	reportId: Type.Integer({
		minimum: 1,
		description: "HackerOne report number/id to comment on.",
	}),
	message: Type.String({
		minLength: 1,
		description: "The comment message to post.",
	}),
	internal: Type.Optional(Type.Boolean({
		default: false,
		description: "Post as an internal (team-only) comment instead of a public one.",
	})),
	attachmentIds: Type.Optional(Type.Array(Type.Integer({
		minimum: 1,
	}), {
		description: "Optional attachment IDs to attach to the comment.",
	})),
});

interface CommentToolParams {
	reportId: number;
	message: string;
	internal?: boolean;
	attachmentIds?: number[];
}

const stateParameters = Type.Object({
	reportId: Type.Integer({
		minimum: 1,
		description: "HackerOne report number/id whose state should change.",
	}),
	// A plain string enum (not anyOf/const) so every model provider accepts it.
	state: Type.Unsafe<ChangeableReportState>({
		type: "string",
		enum: [...changeableReportStates],
		description: `The state to move the report to. ${STATE_TRANSITION_RULE} One of:\n${STATE_DEFINITIONS}`,
	}),
	message: Type.Optional(Type.String({
		description: `Message posted on the report with the state change. It is visible to the reporter, so never include team-only notes. Required for ${MESSAGE_STATES}.`,
	})),
	originalReportId: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Only for the duplicate state: the ID of the original report this one duplicates.",
	})),
	attachmentIds: Type.Optional(Type.Array(Type.Integer({
		minimum: 1,
	}), {
		description: "Optional attachment IDs to include with the state change message.",
	})),
});

interface StateToolParams {
	reportId: number;
	state: ChangeableReportState;
	message?: string;
	originalReportId?: number;
	attachmentIds?: number[];
}

interface FetchReportResult {
	report: Report;
	comments?: Activity[];
	programHandle?: string;
	warnings: string[];
}

interface Credentials {
	apiIdentifier: string;
	apiToken: string;
	baseUrl?: string;
}

type HackerOneSettings = Partial<Credentials>;

function readSettingsFile(path: string): HackerOneSettings {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { hackerone?: unknown };
		if (!raw.hackerone || typeof raw.hackerone !== "object") {
			return {};
		}

		const settings = raw.hackerone as Record<string, unknown>;
		return {
			apiIdentifier: typeof settings.apiIdentifier === "string" ? settings.apiIdentifier : undefined,
			apiToken: typeof settings.apiToken === "string" ? settings.apiToken : undefined,
			baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl : undefined,
		};
	} catch {
		return {};
	}
}

function readSettingsCredentials(cwd: string): HackerOneSettings {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const globalSettings = readSettingsFile(join(agentDir, "settings.json"));
	const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"));

	return {
		...globalSettings,
		...projectSettings,
	};
}

function readCredentials(cwd: string): Credentials {
	const settings = readSettingsCredentials(cwd);
	const apiIdentifier = process.env.HACKERONE_API_IDENTIFIER ?? settings.apiIdentifier;
	const apiToken = process.env.HACKERONE_API_TOKEN ?? settings.apiToken;

	if (!apiIdentifier || !apiToken) {
		throw new Error(
			"Missing HackerOne credentials. Set hackerone.apiIdentifier and hackerone.apiToken in pi settings.json, or set HACKERONE_API_IDENTIFIER and HACKERONE_API_TOKEN.",
		);
	}

	return {
		apiIdentifier,
		apiToken,
		baseUrl: process.env.HACKERONE_API_BASE_URL ?? settings.baseUrl,
	};
}

function createClient(cwd: string): HackerOneClient {
	return new HackerOneClient(readCredentials(cwd));
}

function parsePositiveInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}

	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}

	return undefined;
}

// Accepts case and separator variants such as "Not_Applicable" or "needs more info".
function normalizeState(value: unknown): ChangeableReportState | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const candidate = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
	return changeableReportStates.find((state) => state === candidate);
}

function normalizeToolArguments<T extends object>(args: unknown): T {
	if (!args || typeof args !== "object") {
		return args as T;
	}

	const record = args as Record<string, unknown>;
	const normalized: Record<string, unknown> = { ...record };
	let changed = false;

	const reportId = parsePositiveInteger(record.reportId)
		?? parsePositiveInteger(record.reportNumber)
		?? parsePositiveInteger(record.number)
		?? parsePositiveInteger(record.id);
	if (reportId !== undefined && record.reportId !== reportId) {
		normalized.reportId = reportId;
		changed = true;
	}

	const state = normalizeState(record.state);
	if (state !== undefined && record.state !== state) {
		normalized.state = state;
		changed = true;
	}

	return (changed ? normalized : args) as T;
}

function getProgramHandle(report: Report, fallback?: string): string | undefined {
	return fallback ?? report.relationships.program.data.attributes?.handle;
}

async function fetchReport(options: FetchReportOptions, cwd: string): Promise<FetchReportResult> {
	const client = createClient(cwd);
	const report = await getReport(client, options.reportId);
	const programHandle = getProgramHandle(report, options.program);
	const warnings: string[] = [];
	let comments: Activity[] | undefined;

	if (options.includeComments) {
		if (programHandle) {
			const activities: Activity[] = [];
			for await (const activity of listAllActivities(client, programHandle, { reportId: options.reportId })) {
				activities.push(activity);
			}
			comments = filterComments(activities);
		} else {
			warnings.push(
				"Could not fetch comments because no program handle was provided or found on the report.",
			);
		}
	}

	return { report, comments, programHandle, warnings };
}

async function postComment(options: CommentToolParams, cwd: string): Promise<Activity> {
	const client = createClient(cwd);
	return createComment(client, options.reportId, {
		message: options.message,
		internal: options.internal ?? false,
		attachmentIds: options.attachmentIds,
	});
}

async function changeState(options: StateToolParams, cwd: string): Promise<Report> {
	const client = createClient(cwd);
	return changeReportState(client, options.reportId, options.state, {
		message: options.message,
		originalReportId: options.originalReportId,
		attachmentIds: options.attachmentIds,
	});
}

function formatActor(activity: Activity): string {
	const actor = activity.relationships?.actor?.data;
	return actor?.attributes?.username ?? actor?.attributes?.handle ?? actor?.id ?? "unknown";
}

function formatCommentMarkdown(comment: Activity, reportId: number): string {
	const actor = comment.relationships?.actor?.data;
	const actorName = actor?.attributes?.username ?? actor?.attributes?.handle ?? actor?.id ?? "unknown";
	const visibility = comment.attributes.internal ? "internal" : "public";
	const lines = [
		`# Comment posted on report #${reportId}`,
		"",
		`- Visibility: ${visibility}`,
		`- Author: ${actorName}`,
		`- Created: ${comment.attributes.created_at}`,
		"",
		comment.attributes.message ?? "_(empty comment)_",
	];
	return lines.join("\n");
}

function formatReportMarkdown(result: FetchReportResult): string {
	const { report, comments, programHandle, warnings } = result;
	const reporter = report.relationships.reporter?.data;
	const reporterName = reporter?.attributes?.username ?? reporter?.attributes?.handle ?? reporter?.id ?? "unknown";
	const attachments = report.relationships.attachments?.data ?? [];
	const lines = [
		`# HackerOne report #${report.id}: ${report.attributes.title}`,
		"",
		`- State: ${report.attributes.state}`,
		`- Severity: ${report.attributes.severity_rating ?? "unknown"}`,
		`- Program: ${programHandle ?? report.relationships.program.data.id}`,
		`- Reporter: ${reporterName}`,
		`- Submitted: ${report.attributes.submitted_at}`,
		`- Created: ${report.attributes.created_at}`,
		`- Triaged: ${report.attributes.triaged_at ?? "not triaged"}`,
		`- Closed: ${report.attributes.closed_at ?? "not closed"}`,
		`- Last activity: ${report.attributes.last_activity_at ?? "unknown"}`,
		`- Attachments: ${attachments.length}`,
		"",
		"## Vulnerability information",
		"",
		report.attributes.vulnerability_information || "_(empty)_",
	];

	if (attachments.length > 0) {
		lines.push("", "## Attachments", "");
		for (const attachment of attachments) {
			lines.push(
				`- ${attachment.attributes.file_name} (${attachment.attributes.content_type}, ${attachment.attributes.file_size} bytes)`,
			);
		}
	}

	if (comments) {
		lines.push("", "## Comments", "");
		if (comments.length === 0) {
			lines.push("_(no comments found)_");
		} else {
			for (const comment of comments) {
				const visibility = comment.attributes.internal ? "internal" : "external";
				lines.push(
					`### ${comment.attributes.created_at} — ${formatActor(comment)} (${visibility})`,
					"",
					comment.attributes.message ?? "_(empty comment)_",
					"",
				);
			}
		}
	}

	if (warnings.length > 0) {
		lines.push("", "## Warnings", "");
		for (const warning of warnings) {
			lines.push(`- ${warning}`);
		}
	}

	return lines.join("\n");
}

function formatStateChange(report: Report): string {
	return `# HackerOne report #${report.id}\n\n- State: ${report.attributes.state}`;
}

function formatError(error: unknown): string {
	// Rejected by the client library before any request was sent.
	if (isAppError(error) && error.code === "VALIDATION_ERROR") {
		return error.message;
	}

	if (isAppError(error)) {
		const retry = error.retryAfter === undefined ? "" : ` Retry after ${error.retryAfter} seconds.`;
		return `HackerOne API error (${error.code}, HTTP ${error.statusCode}): ${error.message}.${retry}`;
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

export default function hackerOneExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "HackerOne Report",
		description: "Fetch a HackerOne report by report number using the HackerOne API.",
		promptSnippet: "Fetch a HackerOne report by report number/id",
		promptGuidelines: [
			"Use hackerone_report when the user asks to fetch, inspect, summarize, or analyze a HackerOne report by number.",
			"Before using hackerone_report, ensure the user provided the report number/id.",
		],
		parameters: reportParameters,
		prepareArguments: normalizeToolArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await fetchReport(params, ctx.cwd);
				return {
					content: [{ type: "text", text: formatReportMarkdown(result) }],
					details: result,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: formatError(error) }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: COMMENT_TOOL_NAME,
		label: "HackerOne Comment",
		description: "Post a public or internal comment on a HackerOne report using the HackerOne API.",
		promptSnippet: "Post a comment on a HackerOne report by report number/id",
		promptGuidelines: [
			"Use hackerone_comment when the user wants to add a comment to a HackerOne report.",
			"Before using hackerone_comment, ensure the user provided the report number/id and the comment message.",
			"Set internal to true when the comment should only be visible to the program's team.",
		],
		parameters: commentParameters,
		prepareArguments: normalizeToolArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = { comment: await postComment(params, ctx.cwd), reportId: params.reportId };
				return {
					content: [{ type: "text", text: formatCommentMarkdown(result.comment, result.reportId) }],
					details: result,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: formatError(error) }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerTool({
		name: STATE_TOOL_NAME,
		label: "HackerOne Change State",
		description: `Change the state of a HackerOne report: triage it, ask the reporter for more information, close it, or reopen it. The optional message is posted on the report and is visible to the reporter. ${STATE_TRANSITION_RULE}\n\nStates:\n${STATE_DEFINITIONS}`,
		promptSnippet: `Change a HackerOne report's state (${changeableReportStates.join(", ")}) by report number/id`,
		promptGuidelines: [
			"Use hackerone_change_state only when the user explicitly asks to change a specific report's state, such as triaging it, requesting more information, closing it as resolved, informative, duplicate, not-applicable, or spam, or reopening it.",
			"Before using hackerone_change_state, ensure the user supplied the report number/id and which state to move it to. If the target state is ambiguous (for example, \"close it\"), ask which closed state they mean.",
			"A state change can notify the reporter, and its message is visible to the reporter. Use hackerone_comment with internal: true for team-only notes.",
			`${MESSAGE_STATES} require a message. For duplicate, set originalReportId when the user names the original report.`,
			"Closing as not-applicable or spam lowers the reporter's reputation, and resolved raises it; informative does not change it.",
			"Do not call this tool for a request to merely inspect a report.",
		],
		parameters: stateParameters,
		prepareArguments: normalizeToolArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const report = await changeState(params, ctx.cwd);
				return {
					content: [{ type: "text", text: formatStateChange(report) }],
					details: report,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: formatError(error) }],
					isError: true,
					details: undefined,
				};
			}
		},
	});

	pi.registerCommand("hackerone-report", {
		description: "Fetch a HackerOne report: /hackerone-report <number> [--comments] [--program handle]",
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			if (!parsed) {
				ctx.ui.notify("Usage: /hackerone-report <number> [--comments] [--program handle]", "warning");
				return;
			}

			try {
				ctx.ui.notify(`Fetching HackerOne report #${parsed.reportId}...`, "info");
				const result = await fetchReport(parsed, ctx.cwd);
				pi.sendMessage({
					customType: "hackerone-report",
					content: formatReportMarkdown(result),
					display: true,
					details: result,
				});
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});

	pi.registerCommand("hackerone-state", {
		description: `Change a report's state: ${STATE_COMMAND_USAGE}. ${STATE_TRANSITION_RULE} States:\n${STATE_DEFINITIONS}`,
		// Completes the state after the report number, showing each state's definition.
		getArgumentCompletions: (prefix: string) => {
			const match = /^(\s*\d+\s+)(\S*)$/.exec(prefix);
			if (!match) {
				return null;
			}

			const [, head, partial] = match;
			const typed = partial.toLowerCase();
			const items = STATE_INFO
				.filter(({ state }) => state.startsWith(typed))
				.map(({ state, summary }) => ({ value: `${head}${state} `, label: state, description: summary }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseStateArgs(args);
			if (!parsed) {
				ctx.ui.notify(`Usage: ${STATE_COMMAND_USAGE}\nStates: ${changeableReportStates.join(", ")}`, "warning");
				return;
			}

			try {
				validateStateChange(parsed.state, parsed);
			} catch (error) {
				ctx.ui.notify(formatError(error), "warning");
				return;
			}

			try {
				ctx.ui.notify(`Moving HackerOne report #${parsed.reportId} to ${parsed.state}...`, "info");
				const report = await changeState(parsed, ctx.cwd);
				pi.sendMessage({
					customType: "hackerone-state",
					content: formatStateChange(report),
					display: true,
					details: report,
				});
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});

	pi.registerCommand("hackerone-comment", {
		description: "Post a comment on a HackerOne report: /hackerone-comment <number> --message \"text\" [--internal] [--attachment-id id]",
		handler: async (args, ctx) => {
			const parsed = parseCommentArgs(args);
			if (!parsed) {
				ctx.ui.notify(
					"Usage: /hackerone-comment <number> --message \"text\" [--internal] [--attachment-id id]",
					"warning",
				);
				return;
			}

			try {
				ctx.ui.notify(`Posting comment on HackerOne report #${parsed.reportId}...`, "info");
				const comment = await postComment(parsed, ctx.cwd);
				pi.sendMessage({
					customType: "hackerone-comment",
					content: formatCommentMarkdown(comment, parsed.reportId),
					display: true,
					details: { comment, reportId: parsed.reportId },
				});
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

function tokenizeCommand(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaping = false;

	for (const ch of input) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(ch) && !inSingle && !inDouble) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

function parseStateArgs(args: string): StateToolParams | undefined {
	const tokens = tokenizeCommand(args);
	const reportId = parsePositiveInteger(tokens[0]);
	const state = normalizeState(tokens[1]);

	if (reportId === undefined || state === undefined) {
		return undefined;
	}

	const options: StateToolParams = { reportId, state };
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index];
		const value = tokens[index + 1];

		if (token === "--message") {
			if (!value) {
				return undefined;
			}
			options.message = value;
			index += 1;
			continue;
		}

		if (token === "--original-report-id") {
			const originalReportId = parsePositiveInteger(value);
			if (originalReportId === undefined) {
				return undefined;
			}
			options.originalReportId = originalReportId;
			index += 1;
			continue;
		}

		if (token === "--attachment-id") {
			const attachmentId = parsePositiveInteger(value);
			if (attachmentId === undefined) {
				return undefined;
			}
			options.attachmentIds ??= [];
			options.attachmentIds.push(attachmentId);
			index += 1;
			continue;
		}

		return undefined;
	}

	return options;
}

function parseCommentArgs(args: string): CommentToolParams | undefined {
	const tokens = tokenizeCommand(args);
	const reportId = parsePositiveInteger(tokens[0]);

	if (reportId === undefined) {
		return undefined;
	}

	const options: Partial<CommentToolParams> = { reportId };
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--internal") {
			options.internal = true;
			continue;
		}

		if (token === "--message") {
			const message = tokens[index + 1];
			if (!message) {
				return undefined;
			}
			options.message = message;
			index += 1;
			continue;
		}

		if (token === "--attachment-id") {
			const value = tokens[index + 1];
			if (!value) {
				return undefined;
			}
			const attachmentId = Number.parseInt(value, 10);
			if (!Number.isInteger(attachmentId) || attachmentId < 1) {
				return undefined;
			}
			options.attachmentIds ??= [];
			options.attachmentIds.push(attachmentId);
			index += 1;
			continue;
		}

		return undefined;
	}

	if (!options.message) {
		return undefined;
	}

	return options as CommentToolParams;
}

function parseCommandArgs(args: string): FetchReportOptions | undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const reportId = parsePositiveInteger(tokens[0]);

	if (reportId === undefined) {
		return undefined;
	}

	const options: FetchReportOptions = { reportId };
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--comments") {
			options.includeComments = true;
			continue;
		}

		if (token === "--program") {
			const program = tokens[index + 1];
			if (!program) {
				return undefined;
			}
			options.program = program;
			index += 1;
			continue;
		}

		return undefined;
	}

	return options;
}

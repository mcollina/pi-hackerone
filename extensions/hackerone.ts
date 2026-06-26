import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	HackerOneClient,
	filterComments,
	getReport,
	isAppError,
	listAllActivities,
	type Activity,
	type Report,
} from "@matteo.collina/hackerone";
import { Type } from "typebox";

const TOOL_NAME = "hackerone_report";

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

type ReportToolParams = FetchReportOptions;

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

function normalizeReportId(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}

	if (typeof value === "string" && /^\d+$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}

	return undefined;
}

function normalizeToolArguments(args: unknown): ReportToolParams {
	if (!args || typeof args !== "object") {
		return args as ReportToolParams;
	}

	const record = args as Record<string, unknown>;
	const reportId = normalizeReportId(record.reportId)
		?? normalizeReportId(record.reportNumber)
		?? normalizeReportId(record.number)
		?? normalizeReportId(record.id);

	if (reportId === undefined || record.reportId === reportId) {
		return args as ReportToolParams;
	}

	return { ...record, reportId } as ReportToolParams;
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

function formatActor(activity: Activity): string {
	const actor = activity.relationships?.actor?.data;
	return actor?.attributes?.username ?? actor?.attributes?.handle ?? actor?.id ?? "unknown";
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

function formatError(error: unknown): string {
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
}

function parseCommandArgs(args: string): FetchReportOptions | undefined {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const reportId = normalizeReportId(tokens[0]);

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

# pi-hackerone

A pi package that adds HackerOne report fetching, commenting, and state changes (triage, close, reopen) powered by [`@matteo.collina/hackerone`](https://www.npmjs.com/package/@matteo.collina/hackerone).

## Install

Install from npm as a pi package:

```sh
pi install npm:pi-hackerone
```

Or try it without installing:

```sh
pi -e npm:pi-hackerone
```

Configure credentials in pi settings. Global settings live at `~/.pi/agent/settings.json`; project settings live at `.pi/settings.json` and override global settings.

```json
{
  "hackerone": {
    "apiIdentifier": "your_api_identifier",
    "apiToken": "your_api_token",
    "baseUrl": "https://api.hackerone.com/v1"
  }
}
```

`baseUrl` is optional. Environment variables still work and take precedence:

```sh
export HACKERONE_API_IDENTIFIER="your_api_identifier"
export HACKERONE_API_TOKEN="your_api_token"
export HACKERONE_API_BASE_URL="https://api.hackerone.com/v1"
```

## What it adds

### Tool: `hackerone_report`

The agent can call this tool when you ask for a report by number, for example:

```text
Pull HackerOne report 12345 and summarize the impact.
```

Parameters:

- `reportId` - HackerOne report number/id.
- `includeComments` - Fetch comments from the activity API.
- `program` - Program handle override, useful when fetching comments.

### Tool: `hackerone_comment`

The agent can call this tool to post a comment on a report:

```text
Post a public comment on HackerOne report 12345 saying the fix is deployed.
```

Parameters:

- `reportId` - HackerOne report number/id.
- `message` - The comment message to post.
- `internal` - Post as an internal (team-only) comment instead of a public one.
- `attachmentIds` - Optional attachment IDs to attach to the comment.

### Tool: `hackerone_change_state`

Change a specific report's state when explicitly requested: triage it, ask the reporter for more information, close it, or reopen it.

```text
Move HackerOne report 12345 to triaged.
Close HackerOne report 12345 as informative, telling the reporter this is an accepted risk.
Mark HackerOne report 12345 as a duplicate of 11111.
```

Parameters:

- `reportId` - HackerOne report number/id.
- `state` - The state to move the report to. See [Report states](#report-states).
- `message` - Message posted with the state change. It is visible to the reporter; use `hackerone_comment` with `internal: true` for team-only notes. Required for `needs-more-info`, `informative`, and `duplicate`.
- `originalReportId` - Only for `duplicate`: the ID of the original report.
- `attachmentIds` - Optional attachment IDs to include with the message.

This action requires the API user's Report Management permission and may notify the reporter.

#### Report states

| State | Status | Message required | Definition |
| --- | --- | --- | --- |
| `new` | Open | No | The report is pending validation. Moving a closed report here reopens it for a fresh review. |
| `pending-program-review` | Open | No | HackerOne triage has initially validated the report, and it awaits review and severity validation by the program team. Only applies to programs that use HackerOne's triage services. |
| `triaged` | Open | No | The report is validated and escalated for remediation. The vulnerability is treated as live and reproducible until it is fixed. |
| `needs-more-info` | Open | Yes | The reporter must provide more information to reproduce the issue or demonstrate impact. HackerOne closes the report as informative, with no reputation change, after 30 days without a reply. |
| `resolved` | Closed | No | The vulnerability is fixed and no longer reproducible; no further action is needed. The reporter gains 7 reputation and is credited in the program's hall of fame. |
| `not-applicable` | Closed | No | The report has no valid, reproducible issue and no demonstrated security impact; explain why so the reporter can improve. The reporter loses 5 reputation and their signal drops. |
| `informative` | Closed | Yes | The report contains valid information that needs no action, such as an out-of-scope finding, a known issue, or an accepted risk. The reporter's reputation does not change. |
| `duplicate` | Closed | Yes | The issue was already reported or is otherwise known, or one fix resolves several reports. The reporter's reputation change depends on how the original report is closed. |
| `spam` | Closed | No | The report does not describe a legitimate security vulnerability, or it is incomprehensible, abusive, harassing, or selling a product or service. The reporter loses 10 reputation. |

Closed reports can only move back to `new` or `triaged`. `retesting` is not offered because HackerOne sets it through its separate retest flow. The states, definitions, and message rules come from [`@matteo.collina/hackerone`](https://www.npmjs.com/package/@matteo.collina/hackerone), which follows HackerOne's [report states](https://docs.hackerone.com/en/articles/8475030-report-states) and [change state API](https://api.hackerone.com/customer-resources/#reports-change-state) documentation.

### Command: `/hackerone-report`

Fetch a report directly from the pi prompt:

```text
/hackerone-report 12345
/hackerone-report 12345 --comments --program myprogram
```

The command inserts the fetched report into the session as a displayed custom message.

### Command: `/hackerone-state`

Change a report's state directly from the pi prompt. After the report number, press Tab to pick a state; each suggestion shows the state's definition.

```text
/hackerone-state 12345 triaged
/hackerone-state 12345 needs-more-info --message "Can you share the request that triggers the crash?"
/hackerone-state 12345 informative --message "This is an accepted risk."
/hackerone-state 12345 duplicate --message "Already reported" --original-report-id 11111
/hackerone-state 12345 not-applicable --message "Not reproducible" --attachment-id 42
```

Use any state from [Report states](#report-states). The command inserts the updated report state into the session.

### Command: `/hackerone-comment`

Post a comment directly from the pi prompt:

```text
/hackerone-comment 12345 --message "A fix has been deployed, can you retest?"
/hackerone-comment 12345 --message "Internal triage note" --internal
/hackerone-comment 12345 --message "See attached POC" --attachment-id 42
```

When a comment is posted, the inserted message is a Markdown summary of the posted comment.

> HackerOne reports can contain sensitive vulnerability details and attachments metadata. Only load this extension in trusted pi sessions.

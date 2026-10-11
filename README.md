# pi-hackerone

A pi package that adds a HackerOne report fetcher and commenter powered by [`@matteo.collina/hackerone`](https://www.npmjs.com/package/@matteo.collina/hackerone).

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

### Command: `/hackerone-report`

Fetch a report directly from the pi prompt:

```text
/hackerone-report 12345
/hackerone-report 12345 --comments --program myprogram
```

The command inserts the fetched report into the session as a displayed custom message.

### Command: `/hackerone-comment`

Post a comment directly from the pi prompt:

```text
/hackerone-comment 12345 --message "A fix has been deployed, can you retest?"
/hackerone-comment 12345 --message "Internal triage note" --internal
/hackerone-comment 12345 --message "See attached POC" --attachment-id 42
```

When a comment is posted, the inserted message is a Markdown summary of the posted comment.

> HackerOne reports can contain sensitive vulnerability details and attachments metadata. Only load this extension in trusted pi sessions.

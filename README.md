# pi-hackerone

A pi package that adds a HackerOne report fetcher powered by [`@matteo.collina/hackerone`](https://www.npmjs.com/package/@matteo.collina/hackerone).

## Setup

```sh
npm install
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

## Use locally

From this repository:

```sh
pi -e ./extensions/hackerone.ts
```

Or install as a local pi package:

```sh
pi install .
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

### Command: `/hackerone-report`

Fetch a report directly from the pi prompt:

```text
/hackerone-report 12345
/hackerone-report 12345 --comments --program myprogram
```

The command inserts the fetched report into the session as a displayed custom message.

> HackerOne reports can contain sensitive vulnerability details and attachments metadata. Only load this extension in trusted pi sessions.

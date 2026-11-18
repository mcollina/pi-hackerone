import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import hackerOneExtension from '../extensions/hackerone.ts';

const STATES = [
  'new',
  'pending-program-review',
  'triaged',
  'needs-more-info',
  'resolved',
  'not-applicable',
  'informative',
  'duplicate',
  'spam',
];

describe('HackerOne state change', () => {
  let mockAgent;
  let originalDispatcher;
  let originalIdentifier;
  let originalToken;
  let originalBaseUrl;
  let tools;
  let commands;
  let messages;
  let notifications;
  let ctx;

  // Intercepts one state-change request and captures its parsed JSON body.
  function interceptStateChange(state, status = 200) {
    const captured = {};
    mockAgent.get('https://api.hackerone.com').intercept({
      method: 'POST',
      path: '/v1/reports/12345/state_changes',
      body(body) {
        captured.body = JSON.parse(body);
        return true;
      },
    }).reply(status, status < 400
      ? { id: '12345', attributes: { state } }
      : { errors: [{ detail: 'Forbidden' }] });
    return captured;
  }

  function runTool(params) {
    const tool = tools.get('hackerone_change_state');
    return tool.execute('call', tool.prepareArguments(params), undefined, undefined, ctx);
  }

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    originalIdentifier = process.env.HACKERONE_API_IDENTIFIER;
    originalToken = process.env.HACKERONE_API_TOKEN;
    originalBaseUrl = process.env.HACKERONE_API_BASE_URL;
    process.env.HACKERONE_API_IDENTIFIER = 'test';
    process.env.HACKERONE_API_TOKEN = 'token';
    process.env.HACKERONE_API_BASE_URL = 'https://api.hackerone.com/v1';
    tools = new Map();
    commands = new Map();
    messages = [];
    notifications = [];
    ctx = {
      cwd: process.cwd(),
      ui: { notify(message, level) { notifications.push({ message, level }); } },
    };
    hackerOneExtension({
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      sendMessage(message) { messages.push(message); },
    });
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    mockAgent.assertNoPendingInterceptors();
    await mockAgent.close();
    for (const [key, value] of [
      ['HACKERONE_API_IDENTIFIER', originalIdentifier],
      ['HACKERONE_API_TOKEN', originalToken],
      ['HACKERONE_API_BASE_URL', originalBaseUrl],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('replaces the triage tool and command', () => {
    assert.equal(tools.has('hackerone_triage'), false);
    assert.equal(commands.has('hackerone-triage'), false);
    assert.equal(tools.has('hackerone_change_state'), true);
    assert.equal(commands.has('hackerone-state'), true);
  });

  it('lists every state with its definition in all descriptions', () => {
    const tool = tools.get('hackerone_change_state');
    const stateSchema = tool.parameters.properties.state;
    assert.deepEqual(stateSchema.type, 'string');
    assert.deepEqual(stateSchema.enum, STATES);

    const descriptions = {
      tool: tool.description,
      stateParameter: stateSchema.description,
      command: commands.get('hackerone-state').description,
    };
    for (const [where, description] of Object.entries(descriptions)) {
      for (const state of STATES) {
        assert.match(description, new RegExp(`^- ${state}: (Open|Closed)(, message required)?\\. \\S`, 'm'),
                     `${where} description is missing the definition of ${state}`);
      }
    }
    assert.match(tool.parameters.properties.message.description, /visible to the reporter/);
  });

  it('keeps the README state table in sync with the tool definitions', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const description = tools.get('hackerone_change_state').description;
    for (const state of STATES) {
      const [, status, message, definition] = description.match(
        new RegExp(`^- ${state}: (Open|Closed)(, message required)?\\. (.+)$`, 'm'),
      );
      assert.ok(readme.includes(`| \`${state}\` | ${status} | ${message ? 'Yes' : 'No'} | ${definition} |`),
                `README row for ${state} does not match the tool definition`);
    }
  });

  it('completes states with their definitions in the command', () => {
    const complete = commands.get('hackerone-state').getArgumentCompletions;
    const all = complete('12345 ');
    assert.deepEqual(all.map((item) => item.label), STATES);
    for (const item of all) {
      assert.match(item.description, /^(Open|Closed)(, message required)?\. \S/);
    }

    assert.deepEqual(complete('12345 in'), [{
      value: '12345 informative ',
      label: 'informative',
      description: all.find((item) => item.label === 'informative').description,
    }]);
    assert.equal(complete('123'), null);
    assert.equal(complete('12345 xyz'), null);
    assert.equal(complete('12345 informative --message'), null);
  });

  it('closes a report as informative through the tool', async () => {
    const request = interceptStateChange('informative');

    const result = await runTool({ reportId: 12345, state: 'Informative', message: 'Accepted risk' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(request.body, {
      data: { type: 'state-change', attributes: { state: 'informative', message: 'Accepted risk' } },
    });
    assert.equal(result.details.attributes.state, 'informative');
    assert.match(result.content[0].text, /State: informative/);
  });

  it('sends the original report and attachments for a duplicate', async () => {
    const request = interceptStateChange('duplicate');

    const result = await runTool({
      reportId: '12345',
      state: 'duplicate',
      message: 'Already reported',
      originalReportId: 999,
      attachmentIds: [7, 8],
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(request.body, {
      data: {
        type: 'state-change',
        attributes: {
          state: 'duplicate',
          message: 'Already reported',
          original_report_id: 999,
          attachment_ids: [7, 8],
        },
      },
    });
  });

  it('normalizes state spelling variants', async () => {
    const request = interceptStateChange('not-applicable');

    const result = await runTool({ reportId: 12345, state: 'Not_Applicable' });
    assert.equal(result.isError, undefined);
    assert.equal(request.body.data.attributes.state, 'not-applicable');
    assert.equal('message' in request.body.data.attributes, false);
  });

  for (const state of ['needs-more-info', 'informative', 'duplicate']) {
    it(`requires a message for ${state} without calling the API`, async () => {
      const result = await runTool({ reportId: 12345, state, message: '   ' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(`^A message is required to move a report to ${state}`));
    });
  }

  it('rejects an original report ID outside the duplicate state', async () => {
    const result = await runTool({ reportId: 12345, state: 'spam', originalReportId: 999 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /only be set when moving a report to duplicate/);
  });

  it('changes the state through the command', async () => {
    const request = interceptStateChange('duplicate');

    await commands.get('hackerone-state').handler(
      '12345 duplicate --message "Same as #999" --original-report-id 999 --attachment-id 7',
      ctx,
    );
    assert.deepEqual(request.body.data.attributes, {
      state: 'duplicate',
      message: 'Same as #999',
      original_report_id: 999,
      attachment_ids: [7],
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, 'hackerone-state');
    assert.match(messages[0].content, /State: duplicate/);
  });

  it('shows usage with the valid states for an unknown state', async () => {
    await commands.get('hackerone-state').handler('12345 closed', ctx);
    assert.equal(messages.length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].message, /Usage: \/hackerone-state <number> <state>/);
    assert.match(notifications[0].message, new RegExp(`States: ${STATES.join(', ')}`));
  });

  it('warns before calling the API when the command lacks a required message', async () => {
    await commands.get('hackerone-state').handler('12345 needs-more-info', ctx);
    assert.equal(messages.length, 0);
    assert.deepEqual(notifications.map((n) => n.level), ['warning']);
    assert.match(notifications[0].message, /^A message is required to move a report to needs-more-info/);
  });

  it('returns API permission errors without reporting success', async () => {
    interceptStateChange('triaged', 403);

    const result = await runTool({ reportId: 12345, state: 'triaged' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /403/);
  });
});

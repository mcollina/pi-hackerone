import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import hackerOneExtension from '../extensions/hackerone.ts';

describe('HackerOne triage', () => {
  let mockAgent;
  let originalDispatcher;
  let originalIdentifier;
  let originalToken;
  let originalBaseUrl;
  let tools;
  let commands;
  let messages;

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
    hackerOneExtension({
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand(name, command) { commands.set(name, command); },
      sendMessage(message) { messages.push(message); },
    });
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
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

  it('posts the state-change payload through the tool', async () => {
    mockAgent.get('https://api.hackerone.com').intercept({
      method: 'POST',
      path: '/v1/reports/12345/state_changes',
      body: JSON.stringify({
        data: { type: 'state-change', attributes: { state: 'triaged' } },
      }),
    }).reply(200, { id: '12345', attributes: { state: 'triaged' } });

    const result = await tools.get('hackerone_triage').execute(
      'call', { reportId: 12345 }, undefined, undefined, { cwd: process.cwd() },
    );
    assert.equal(result.isError, undefined);
    assert.equal(result.details.attributes.state, 'triaged');
    assert.match(result.content[0].text, /State: triaged/);
  });

  it('accepts an optional message through the command', async () => {
    mockAgent.get('https://api.hackerone.com').intercept({
      method: 'POST',
      path: '/v1/reports/12345/state_changes',
      body: JSON.stringify({
        data: { type: 'state-change', attributes: { state: 'triaged', message: 'Confirmed' } },
      }),
    }).reply(200, { id: '12345', attributes: { state: 'triaged' } });

    await commands.get('hackerone-triage').handler('12345 --message "Confirmed"', {
      cwd: process.cwd(),
      ui: { notify() {} },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0].content, /State: triaged/);
  });

  it('returns API permission errors without reporting success', async () => {
    mockAgent.get('https://api.hackerone.com').intercept({
      method: 'POST', path: '/v1/reports/12345/state_changes',
    }).reply(403, { errors: [{ detail: 'Forbidden' }] });

    const result = await tools.get('hackerone_triage').execute(
      'call', { reportId: 12345 }, undefined, undefined, { cwd: process.cwd() },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /403/);
  });
});

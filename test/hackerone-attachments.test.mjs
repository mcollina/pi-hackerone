import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import hackerOneExtension from '../extensions/hackerone.ts';

const FILES = 'https://files.example';
const ACTIVITIES_PATH = '/v1/incremental/activities?handle=security&report_id=12345&page%5Bnumber%5D=1&page%5Bsize%5D=100';

function attachment(id, fileName, fileSize = 5) {
  return {
    id,
    type: 'attachment',
    attributes: {
      file_name: fileName,
      content_type: 'text/plain',
      file_size: fileSize,
      expiring_url: `${FILES}/${id}`,
      created_at: '2024-01-01T00:00:00.000Z',
    },
  };
}

// Two attachments share a name and one tries to escape the folder; a fourth is on a comment.
const REPORT_ATTACHMENTS = [
  attachment('2', 'poc.txt'),
  attachment('3', 'poc.txt'),
  attachment('4', '../../escaped.txt'),
];
const COMMENT_ATTACHMENTS = [attachment('5', 'comment.png')];

describe('HackerOne attachment downloads', () => {
  let mockAgent;
  let originalDispatcher;
  let originalEnv;
  let tools;
  let commands;
  let messages;
  let notifications;
  let cwd;
  let ctx;

  function interceptReport({ attachments = REPORT_ATTACHMENTS, commentAttachments = COMMENT_ATTACHMENTS, activities = true } = {}) {
    const api = mockAgent.get('https://api.hackerone.com');
    api.intercept({ path: '/v1/reports/12345', method: 'GET' }).reply(200, {
      data: {
        id: '12345',
        type: 'report',
        attributes: {
          title: 'XSS',
          state: 'new',
          created_at: '2024-01-01T00:00:00.000Z',
          submitted_at: '2024-01-01T00:00:00.000Z',
          vulnerability_information: 'details',
          triaged_at: null,
          closed_at: null,
          last_activity_at: null,
          first_program_activity_at: null,
          severity_rating: 'high',
        },
        relationships: {
          program: { data: { id: '1', type: 'program', attributes: { handle: 'security' } } },
          attachments: { data: attachments },
        },
      },
    });
    if (activities) {
      api.intercept({ path: ACTIVITIES_PATH, method: 'GET' }).reply(200, {
        data: [{
          id: '100',
          type: 'activity-comment',
          attributes: { message: 'See attached', created_at: '', updated_at: '', internal: false },
          relationships: { attachments: { data: commentAttachments } },
        }],
        links: {},
      });
    }
  }

  function interceptFile(id, status = 200) {
    mockAgent.get(FILES).intercept({ path: `/${id}`, method: 'GET' })
      .reply(status, status === 200 ? `content of ${id}` : '<Error>AccessDenied</Error>');
  }

  function runTool(params) {
    const tool = tools.get('hackerone_download_attachments');
    return tool.execute('call', tool.prepareArguments(params), undefined, undefined, ctx);
  }

  beforeEach(async () => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    originalEnv = { ...process.env };
    process.env.HACKERONE_API_IDENTIFIER = 'test';
    process.env.HACKERONE_API_TOKEN = 'token';
    process.env.HACKERONE_API_BASE_URL = 'https://api.hackerone.com/v1';
    cwd = await mkdtemp(join(tmpdir(), 'pi-hackerone-'));
    tools = new Map();
    commands = new Map();
    messages = [];
    notifications = [];
    ctx = { cwd, ui: { notify(message, level) { notifications.push({ message, level }); } } };
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
    process.env = originalEnv;
    await rm(cwd, { recursive: true, force: true });
  });

  it('downloads every attachment, including those on comments, into an ignored folder', async () => {
    interceptReport();
    for (const id of ['2', '3', '4', '5']) interceptFile(id);

    const result = await runTool({ reportId: '12345' });
    assert.equal(result.isError, undefined);

    const dir = join(cwd, '.hackerone', '12345', 'attachments');
    assert.deepEqual((await readdir(dir)).sort(), ['2-poc.txt', '3-poc.txt', '4-escaped.txt', '5-comment.png']);
    assert.equal(await readFile(join(dir, '2-poc.txt'), 'utf8'), 'content of 2');
    assert.equal(await readFile(join(dir, '3-poc.txt'), 'utf8'), 'content of 3');
    assert.deepEqual((await readdir(cwd)).sort(), ['.hackerone']);
    assert.equal(await readFile(join(cwd, '.hackerone', '.gitignore'), 'utf8'), '*\n');

    const text = result.content[0].text;
    assert.match(text, /^Saved 4 of 4 attachments to \.hackerone\/12345\/attachments\.$/m);
    assert.match(text, /^- \.hackerone\/12345\/attachments\/3-poc\.txt \(text\/plain, 12 bytes\)$/m);
    assert.match(text, /untrusted data/);
    assert.deepEqual(result.details.saved.map((file) => file.id), ['2', '3', '4', '5']);
    assert.equal(result.details.directory, dir);
  });

  it('downloads only the requested attachment IDs', async () => {
    interceptReport();
    interceptFile('5');

    const result = await runTool({ reportId: 12345, attachmentIds: [5] });
    assert.equal(result.isError, undefined);
    assert.deepEqual(await readdir(join(cwd, '.hackerone', '12345', 'attachments')), ['5-comment.png']);
  });

  it('rejects attachment IDs that are not on the report without downloading anything', async () => {
    interceptReport();

    const result = await runTool({ reportId: 12345, attachmentIds: [2, 99] });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text,
      'Report #12345 has no attachment with ID 99. Attachment IDs on the report: 2, 3, 4, 5.');
    assert.deepEqual(await readdir(cwd), []);
  });

  it('keeps going when one download fails and reports the failure', async () => {
    interceptReport({ commentAttachments: [] });
    interceptFile('2');
    interceptFile('3', 403);
    interceptFile('4');

    const result = await runTool({ reportId: 12345 });
    assert.equal(result.isError, undefined);
    assert.deepEqual((await readdir(join(cwd, '.hackerone', '12345', 'attachments'))).sort(), ['2-poc.txt', '4-escaped.txt']);

    const text = result.content[0].text;
    assert.match(text, /^Saved 2 of 3 attachments/m);
    assert.match(text, /^## Failed\n\n- Could not download attachment 3-poc\.txt: HTTP 403\. Download links expire/m);
    assert.deepEqual(result.details.failed.map((failure) => [failure.id, failure.fileName]), [['3', '3-poc.txt']]);
  });

  it('is an error when no attachment could be saved', async () => {
    interceptReport();

    // Every attachment reports 5 bytes, over the limit, so nothing is requested.
    const result = await runTool({ reportId: 12345, maxBytes: 4 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Saved 0 of 4 attachments/m);
    assert.match(result.content[0].text, /- Could not download attachment 2-poc\.txt: it is larger than 4 bytes/);
    assert.doesNotMatch(result.content[0].text, /untrusted data/);
  });

  it('saves to the requested folder without creating .hackerone', async () => {
    interceptReport();
    interceptFile('2');

    const result = await runTool({ reportId: 12345, attachmentIds: [2], outputDir: 'downloads' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(await readdir(cwd), ['downloads']);
    assert.equal(await readFile(join(cwd, 'downloads', '2-poc.txt'), 'utf8'), 'content of 2');
  });

  it('reports a report without attachments', async () => {
    interceptReport({ attachments: [], commentAttachments: [] });

    const result = await runTool({ reportId: 12345 });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /_\(the report has no attachments\)_/);
    assert.deepEqual(await readdir(cwd), []);
  });

  it('downloads through the command', async () => {
    interceptReport();
    interceptFile('2');
    interceptFile('5');

    await commands.get('hackerone-attachments').handler(
      '12345 --attachment-id 2 --attachment-id 5 --output-dir "my files"',
      ctx,
    );
    assert.deepEqual(notifications.map((n) => n.level), ['info']);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, 'hackerone-attachments');
    assert.match(messages[0].content, /^Saved 2 of 2 attachments to my files\.$/m);
    assert.deepEqual((await readdir(join(cwd, 'my files'))).sort(), ['2-poc.txt', '5-comment.png']);
  });

  for (const args of ['', 'abc', '12345 --attachment-id', '12345 --attachment-id x', '12345 --output-dir', '12345 --max-bytes 0', '12345 --bogus']) {
    it(`shows usage for "${args}"`, async () => {
      await commands.get('hackerone-attachments').handler(args, ctx);
      assert.equal(messages.length, 0);
      assert.deepEqual(notifications.map((n) => n.level), ['warning']);
      assert.match(notifications[0].message, /^Usage: \/hackerone-attachments <number>/);
    });
  }

  it('lists attachment IDs in the report tool so they can be selected', async () => {
    interceptReport({ activities: false });

    const tool = tools.get('hackerone_report');
    const result = await tool.execute('call', tool.prepareArguments({ reportId: 12345 }), undefined, undefined, ctx);
    assert.match(result.content[0].text, /^- 2: poc\.txt \(text\/plain, 5 bytes\)$/m);
  });
});

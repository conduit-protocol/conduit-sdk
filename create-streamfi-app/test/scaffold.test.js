const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_TEMPLATE, SDK_PACKAGE, parseArguments, scaffold, testnetEnv } = require('../lib/scaffold');

test('parses a project name and defaults', () => {
  assert.deepEqual(parseArguments(['my-app']), {
    projectName: 'my-app', template: DEFAULT_TEMPLATE, skipInstall: false, help: false,
  });
});

test('parses template and skip-install options', () => {
  assert.deepEqual(parseArguments(['my-app', '--template', 'https://example.test/template.git', '--skip-install']), {
    projectName: 'my-app', template: 'https://example.test/template.git', skipInstall: true, help: false,
  });
});

test('writes the testnet configuration and installs the SDK', () => {
  const calls = [];
  const writes = [];
  scaffold({ projectName: 'my-app', template: 'https://example.test/template.git', skipInstall: false }, {
    existsSync: () => false,
    resolve: (...parts) => parts.join('/'),
    writeFileSync: (...args) => writes.push(args),
    run: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [
    ['git', ['clone', '--depth', '1', 'https://example.test/template.git', process.cwd() + '/my-app']],
    ['npm', ['install'], { cwd: process.cwd() + '/my-app' }],
    ['npm', ['install', SDK_PACKAGE], { cwd: process.cwd() + '/my-app' }],
  ]);
  assert.deepEqual(writes, [[process.cwd() + '/my-app/.env.local', testnetEnv(), 'utf8']]);
});

test('rejects an existing target directory', () => {
  assert.throws(() => scaffold({ projectName: 'my-app', template: DEFAULT_TEMPLATE, skipInstall: true }, {
    existsSync: () => true,
    resolve: (...parts) => parts.join('/'),
    writeFileSync: () => {},
    run: () => {},
  }), /already exists/);
});

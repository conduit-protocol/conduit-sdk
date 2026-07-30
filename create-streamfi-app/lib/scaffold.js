const { execFileSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const { basename, resolve } = require('node:path');

// A maintained, general-purpose Next.js starter. Projects can provide a StreamFi
// specific fork with --template as soon as one is available.
const DEFAULT_TEMPLATE = 'https://github.com/ixartz/Next-js-Boilerplate.git';
const SDK_PACKAGE = '@conduit-protocol/sdk';

function parseArguments(args) {
  const options = { template: DEFAULT_TEMPLATE, skipInstall: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--skip-install') options.skipInstall = true;
    else if (argument === '--template') {
      options.template = args[++index];
      if (!options.template) throw new Error('--template requires a repository URL');
    } else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else if (options.projectName) throw new Error('Only one project name may be provided');
    else options.projectName = argument;
  }

  if (!options.help && !options.projectName) {
    throw new Error('Provide a project name, for example: npx create-streamfi-app my-streamfi-app');
  }
  return options;
}

function testnetEnv() {
  return `# StreamFi / Stellar testnet\nNEXT_PUBLIC_STELLAR_NETWORK=testnet\nNEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org\nNEXT_PUBLIC_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org\n`;
}

function run(command, args, options) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function scaffold(options, dependencies = { existsSync, writeFileSync, resolve, run }) {
  const targetDirectory = dependencies.resolve(process.cwd(), options.projectName);
  if (dependencies.existsSync(targetDirectory)) {
    throw new Error(`The directory "${options.projectName}" already exists`);
  }

  console.log(`Creating a StreamFi app in ${targetDirectory}...`);
  dependencies.run('git', ['clone', '--depth', '1', options.template, targetDirectory]);

  const envPath = dependencies.resolve(targetDirectory, '.env.local');
  dependencies.writeFileSync(envPath, testnetEnv(), 'utf8');

  if (!options.skipInstall) {
    dependencies.run('npm', ['install'], { cwd: targetDirectory });
    dependencies.run('npm', ['install', SDK_PACKAGE], { cwd: targetDirectory });
  }

  console.log('\nYour StreamFi app is ready!');
  console.log(`\n  cd ${basename(targetDirectory)}`);
  console.log('  npm run dev');
}

module.exports = { DEFAULT_TEMPLATE, SDK_PACKAGE, parseArguments, scaffold, testnetEnv };

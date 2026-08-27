const { execFileSync } = require('node:child_process');
const { existsSync, writeFileSync, cpSync } = require('node:fs');
const { basename, resolve, join } = require('node:path');

// Bundled, StreamFi-wired Next.js template (a copy of examples/nextjs-app),
// used by default. Pass --template <git-url> to clone an external starter instead.
const BUNDLED_TEMPLATE_DIR = join(__dirname, '..', 'template');
// null means "use the bundled template"; parseArguments() only replaces this
// with a URL when the caller explicitly passes --template.
const DEFAULT_TEMPLATE = null;
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

// Matches the env vars examples/nextjs-app (and the bundled template, which
// is a copy of it) actually read — see lib/conduit.ts. Values that can't be
// known ahead of time are left blank with a comment rather than guessed.
function testnetEnv() {
  return `# StreamFi / Stellar testnet\nNEXT_PUBLIC_NETWORK=testnet\n\n# Deployed DripFactory contract ID for the chosen network. Required for\n# list()/streamCount()/streamAddress() queries.\nFACTORY_ADDRESS=\n\n# Secret key for signing transactions. Required for creating/withdrawing streams.\n# Deliberately NOT NEXT_PUBLIC_-prefixed; see lib/conduit.ts.\nSTELLAR_SECRET=\n\n# Default address to query streams for (can also be typed in the UI).\nNEXT_PUBLIC_ADDRESS=\n`;
}

function run(command, args, options) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function scaffold(options, dependencies = { existsSync, writeFileSync, cpSync, resolve, run }) {
  const targetDirectory = dependencies.resolve(process.cwd(), options.projectName);
  if (dependencies.existsSync(targetDirectory)) {
    throw new Error(`The directory "${options.projectName}" already exists`);
  }

  // No --template given: copy the bundled, already StreamFi/Stellar-wired
  // Next.js template instead of cloning an unrelated external starter.
  const usingBundledTemplate = !options.template;

  if (usingBundledTemplate) {
    console.log(`Creating a StreamFi app in ${targetDirectory} (from the bundled StreamFi template)...`);
    dependencies.cpSync(BUNDLED_TEMPLATE_DIR, targetDirectory, { recursive: true });
  } else {
    console.log(`Creating a StreamFi app in ${targetDirectory}...`);
    dependencies.run('git', ['clone', '--depth', '1', options.template, targetDirectory]);
  }

  const envPath = dependencies.resolve(targetDirectory, '.env.local');
  dependencies.writeFileSync(envPath, testnetEnv(), 'utf8');

  if (!options.skipInstall) {
    dependencies.run('npm', ['install'], { cwd: targetDirectory });
    // The bundled template already declares @conduit-protocol/sdk as a
    // dependency; an external --template starter generally won't.
    if (!usingBundledTemplate) {
      dependencies.run('npm', ['install', SDK_PACKAGE], { cwd: targetDirectory });
    }
  }

  console.log('\nYour StreamFi app is ready!');
  console.log(`\n  cd ${basename(targetDirectory)}`);
  console.log('  npm run dev');
}

module.exports = { DEFAULT_TEMPLATE, BUNDLED_TEMPLATE_DIR, SDK_PACKAGE, parseArguments, scaffold, testnetEnv };

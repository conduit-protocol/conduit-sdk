# create-streamfi-app

Scaffold a Next.js app ready to use StreamFi on Stellar testnet.

```bash
npx create-streamfi-app my-streamfi-app
```

The command clones a Next.js template, installs the template's dependencies and `@conduit-protocol/sdk`, then creates `.env.local` with the Stellar testnet Soroban RPC and Horizon URLs.

To use a fork or an unreleased template repository:

```bash
npx create-streamfi-app my-streamfi-app --template https://github.com/your-org/your-template.git
```

Use `--skip-install` to clone and configure a project without running npm installs.

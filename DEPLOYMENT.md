# Deployment and rollback

The client and server are separate production artifacts. Deploy the authoritative server first, then build the static client with that server's secure WebSocket URL.

## Authoritative server — Colyseus Cloud

The repository follows the managed-hosting contract: `defineServer()`, a compiled Node entrypoint at `dist-server/server/src/index.js`, and root-level `ecosystem.config.cjs`. The Cloud build command should be `npm run build:cloud`.

Required environment variables:

- `CLIENT_ORIGIN` — comma-separated exact HTTPS client origins; no wildcard is accepted.
- `RELEASE_VERSION` — the deployed Git commit SHA.
- `NODE_ENV=production` — also supplied by the PM2 configuration.

Cloud supplies its own port, socket, Redis, and routing variables. Do not commit `.colyseus-cloud.json`; it contains deployment credentials and is ignored.

```bash
npx @colyseus/cloud deploy --env staging --remote origin --branch main
npx @colyseus/cloud deploy --env production --remote origin --branch main
```

After each deploy, verify `/health`, protocol version, release SHA, room creation, two-client join/start, roster locking, and server logs before advancing.

## Static client — Vercel

Vercel builds with `npm run build` and serves `dist`. Set `VITE_GAME_SERVER_URL` to the deployed `wss://` server endpoint separately for Preview and Production.

```bash
vercel link --project zombies
vercel env add VITE_GAME_SERVER_URL preview
vercel env add VITE_GAME_SERVER_URL production
vercel deploy
vercel deploy --prod
```

Verify the exact preview artifact before production promotion: cold load under three seconds, service-worker installation, offline solo reload, no console errors, a real two-client co-op start, and the 24-enemy plus three-remote-player stress gate.

## Rollback

1. Re-promote the last verified Vercel deployment.
2. Roll the Colyseus application back to the matching server revision.
3. Confirm client/server protocol versions match before reopening co-op.
4. Re-run health, solo, offline, and two-client smoke tests.

Never promote only one side of a protocol change. Solo remains available if the co-op service is unavailable.

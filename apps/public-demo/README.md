# SceneCart Public Demo

This package is the independently deployable, static public experience for SceneCart.
It reuses the repository's shared `PublicDemo` UI and frozen fixture data, while its
exported route contract is limited to `/`, `/demo`, `/product-guide`, and the 404 page.

Its stable public domain is `https://scenecart-public-demo.vercel.app/`. The formal
product remains a separate deployment at `https://scenecart-ai.vercel.app/`; the two
applications share source code but never share authentication, APIs, databases, model
keys, Taobao credentials, or executor state. `/demo?autoplay=1` starts the existing tour
once after the page loads, while `/demo` remains manually explorable.

## Local verification

```bash
npm ci
npm run typecheck
npm run build
```

`npm run build` performs three gated steps:

1. Safely copies `../../public/demo-products` into this package's ignored `public/` directory.
2. Produces a static Next.js export with image optimization disabled.
3. Verifies the exported routes, App Router manifest, and complete frozen asset inventory.

## Vercel project settings

- Root Directory: `apps/public-demo`
- Include source files outside the Root Directory in the Build Step: enabled
- Build Command: `npm run build`
- Framework Preset: Next.js
- Environment variables: none

Deploy from the real repository source rather than an app-only copy: this package imports
shared UI, styles, fixtures, and frozen Demo helpers from the repository root at build time.

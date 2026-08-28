# SceneCart Public Demo

This package is the independently deployable, static public experience for SceneCart.
It reuses the repository's shared `PublicDemo` UI, product-guide dialog, and frozen fixture
data. `/` is the only canonical Demo surface; `/demo` and `/product-guide` are redirect-only
compatibility routes, alongside the 404 page.

Its stable public domain is `https://scenecart-public-demo.vercel.app/`. The formal
product remains a separate deployment at `https://scenecart-ai.vercel.app/`; the two
applications share source code but never share authentication, APIs, databases, model
keys, Taobao credentials, or executor state. `/?autoplay=1` starts the existing tour once
after the page loads, while `/` remains manually explorable. `/?guide=1` opens the shared
product-guide dialog in place and then removes only the `guide` query parameter.

## Local verification

```bash
npm ci
npm run typecheck
npm run build
```

`npm run build` performs three gated steps:

1. Safely copies `../../public/demo-products` into this package's ignored `public/` directory.
2. Produces a static Next.js export with image optimization disabled.
3. Verifies the exported routes, redirect-only compatibility shells, App Router manifest,
   complete frozen asset inventory, and absence of formal API/model/database/owner/Worker
   runtime markers in exported JavaScript and HTML.

## Vercel project settings

- Root Directory: `apps/public-demo`
- Include source files outside the Root Directory in the Build Step: enabled
- Build Command: `npm run build`
- Framework Preset: Next.js
- Environment variables: none

Deploy from the real repository source rather than an app-only copy: this package imports
shared UI, styles, fixtures, and frozen Demo helpers from the repository root at build time.

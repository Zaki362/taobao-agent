# 001 — Accelerate the results half of the public demo

- **Status**: DONE
- **Commit**: 3e66c3c
- **Severity**: MEDIUM
- **Category**: Easing & duration
- **Estimated scope**: 3 files, about 70 lines including regression tests

## Problem

The public demo intentionally gives the user time to read each explanation, but the cadence remains unchanged after the workflow reaches the result page. From the “查看搜索结果” action onward there are many short comparison and add-to-cart steps, so using the same explanatory pace makes the second half feel repetitive and slow.

`components/public-demo.tsx:287` currently chooses only normal, fast-test, and reduced-motion durations:

```ts
function scaledDuration(normal: number, fast: number) {
  if (fastModeRef.current) return fast;
  if (reducedMotionRef.current) return Math.min(120, fast * 2);
  return normal;
}
```

`components/public-demo.tsx:582-673` then uses that same duration function for every tour step, including the narrator explanation, scroll settling, cursor travel, point/click feedback, and dwell:

```ts
await wait(scaledDuration(680, 35), signal);
const moveDuration = reduced || fastModeRef.current ? 0 : 1050;
await wait(scaledDuration(2200, 50), signal);
await wait(scaledDuration(step.dwell, 90), signal);
```

## Target

- Keep tour steps 1–4 (`scene:example:new-car:0` through `plan:confirm`) exactly at their current normal cadence.
- Starting with the `search:view-results` step (zero-based step index 4), run the normal-mode tour at **1.5× speed**, implemented as `Math.round(duration / 1.5)`.
- Apply the same multiplier to narrator reading time, pre-action pause, scroll settling, position stability sampling, cursor travel, point callout, press feedback, post-click feedback, and per-step dwell.
- Keep `demoSpeed=fast` values unchanged so the existing E2E acceleration mode remains deterministic.
- Keep reduced-motion timing unchanged; it already uses capped short waits and zero cursor travel.
- Do not alter target order, copy, product state changes, pause/resume behavior, or manual exploration timing.
- Keep button press feedback inside the 100–160ms duration budget from the animation audit: `180ms / 1.5 = 120ms`.

## Repo conventions to follow

- Tour timing is centralized in `components/public-demo.tsx` through `scaledDuration`; extend that pathway instead of editing every `TOUR_STEPS[].dwell` value.
- The demo already branches on `fastModeRef` and `reducedMotionRef`; preserve those branches exactly.
- Put the pure pace calculation in `lib/demo/tour-timing.ts` so the 1.5× boundary can be unit-tested without rendering the client component.
- Existing full-flow coverage is in `tests/e2e/public-demo.spec.ts` and must continue to pass unchanged.

## Steps

1. Add `lib/demo/tour-timing.ts` with exported constants for the zero-based results boundary (`4`) and speed multiplier (`1.5`), plus a pure `pacePublicDemoTourDuration(duration, stepIndex)` function. It must return the input unchanged for indices below 4 and `Math.round(duration / 1.5)` for index 4 and later.
2. Add `tests/unit/demo-tour-timing.test.ts` covering: step 3 unchanged; step 4 changes `2200` to `1467`; cursor travel `1050` becomes `700`; press feedback `180` becomes `120`; final dwell `4200` becomes `2800`.
3. In `components/public-demo.tsx`, import the pure helper. Extend `scaledDuration` with an optional `stepIndex`. Preserve fast mode and reduced motion before applying the normal-mode pace helper.
4. Pass the current step index into `animateTourStep`. Use the paced duration for every tour-only wait inside that function and for the normal cursor `moveDuration`.
5. In `runTour`, pass the current index to narrator explanation, pre-action pause, `animateTourStep`, and dwell duration calls.
6. Do not pass a step index to unrelated product-state `scheduleAction` calls; manual interaction timing and frozen data replay stay unchanged.

## Boundaries

- Do NOT change the first four tour steps or any tour copy.
- Do NOT change the frozen search/add-to-cart data timers.
- Do NOT change target order, pause/resume logic, click simulation, layout, or CSS.
- Do NOT add dependencies.
- If the cited functions have drifted enough that one shared duration path cannot express this boundary, stop and report instead of editing individual dwell values.

## Verification

- **Mechanical**:
  - `npx vitest run tests/unit/demo-tour-timing.test.ts`
  - `npm run typecheck`
  - `npx eslint components/public-demo.tsx lib/demo/tour-timing.ts tests/unit/demo-tour-timing.test.ts`
  - `npx playwright test tests/e2e/public-demo.spec.ts --project=desktop-chrome`
- **Feel check**:
  - Open `http://127.0.0.1:3210/demo` and start the automatic demo.
  - Confirm the first four steps retain their current reading pace.
  - Confirm the “查看搜索结果” step and every following results/cart step run at a consistently quicker cadence rather than only shortening dwell.
  - Confirm the product-detail point callout remains readable and the cursor still visibly lands on each target before clicking.
  - Pause after entering results, resume, and confirm the next step does not repeat or skip.
  - Toggle reduced motion and confirm cursor travel remains disabled.
- **Done when**: the pure timing tests prove the exact 1.5× boundary, the full 15-step E2E still reaches the four-item cart without duplicate actions, and the normal demo feels unchanged before results and consistently faster after results.

# API validation

Use Node 24 and run `npm run check` from the repository root. No dependency
installation, credentials or live network requests are needed for these checks.

- `npm run validate:crags` validates both the Worker and web crag datasets.
  Every crag and subcrag must have a finite numeric elevation. Zero is valid;
  missing values, null and numeric strings are rejected. IDs, names, states,
  coordinates and parent references are also checked.
- `npm test` exercises the real Worker modules using mocked fetch and edge
  cache implementations. It covers successful and failed writes, malformed
  JSON, cache-hit and cache-miss headers, CORS, and scored-response structure
  for VIC, TAS, NSW and all regions using a fixed clock and synthetic weather.
  Node's experimental VM-modules warning is expected from the test loader.

The Deploy Cloudflare Worker workflow runs validation on relevant pull requests
and pushes to main. Deployment depends on validation succeeding and only runs
on pushes, never on pull requests. This is a deployment gate, not a new branch
protection rule. Manually deploying outside this workflow bypasses the gate.

Tests do not exercise Cloudflare's runtime, live Supabase, native Swift decoding,
or real weather-provider responses. Verify those separately when releasing.
The native Xcode project is not part of this repository.

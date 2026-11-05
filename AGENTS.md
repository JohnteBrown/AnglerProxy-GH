# AnglerProxy

A lightweight HTTP forward proxy server built with Node.js.
Clients (e.g. ChromeOS Wi-Fi proxy settings) send full target URLs;
the proxy fetches them on the client's behalf.

## Tech Stack
- Node.js 20+
- `http-proxy` for forwarding
- No database, no framework

## Commands
- Run: `node index.js`
- Test: `npm test`
- Lint: `npx eslint .`

## Repo Layout
- `index.js` — server entry point, proxy setup
- `lib/` — proxy logic, logging, auth (future)
- `test/` — unit and integration tests

## Conventions
- Use ESM (`import`/`export`)
- No new dependencies without explicit approval
- Keep the proxy stateless (no session storage)
- Log all requests with timestamp, method, target URL

## Do NOT
- Do not modify `package.json` to add dependencies
- Do not change the port binding logic without being asked
- Do not implement HTTPS MITM unless explicitly requested

## Done means
- Server starts and logs "AnglerProxy listening on port X"
- A test client can send `GET http://example.com/` and receive the response
- All tests pass   
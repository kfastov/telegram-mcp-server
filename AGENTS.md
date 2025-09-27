# Repository Guidelines

## Project Structure & Module Organization
- `mcp-server.js`: FastMCP entry point exposing Telegram tools.
- `telegram-client.js`: Domain logic for MTProto login, dialog cache, and message helpers.
- `client.js`: Example CLI harness for manual testing without the MCP layer.
- `data/`: Runtime artifacts (SQLite session storage); keep out of version control but ensure the directory exists locally.
- Documentation lives in `README.md` and `LIBRARY.md`; configuration relies on a local `.env` file.

## Build, Test, and Development Commands
- `npm install`: Restore dependencies whenever `package-lock.json` changes.
- `npm start`: Boot the SSE server on `http://localhost:8080/sse`; first run will drive the Telegram login flow.
- `node client.js`: Run the sample script to exercise the client API and inspect dialog listings.
- `npm run build`: Currently a no-op placeholder—extend it only if a transpile/bundle step is introduced.
- `npm test`: Placeholder that echoes a notice; replace with real checks once tests exist.

## Coding Style & Naming Conventions
- Use ES modules with semicolons, two-space indentation, and `camelCase` identifiers.
- Keep FastMCP tool names descriptive and aligned with Telegram operations (`listChannels`, `searchChannels`, etc.).
- Emit log lines that explain side effects (cache refreshes, MTProto calls) and reference chat IDs/titles.
- Store secrets in `.env`; never hard-code API credentials or session paths in commits.

## Testing Guidelines
- Add coverage when extending `telegram-client.js` by mocking MTProto responses to validate session recovery and cache hydration.
- Name new test files `<module>.test.js` under `tests/` or co-locate in `__tests__/`; make `npm test` execute them.
- Before pushing, run your test suite and a smoke `npm start` to verify authentication prompts and cache initialization remain intact.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (`type: subject`) as seen in `docs(readme): add detailed login guide...`; use lowercase types for routine changes and `fix:` for bug patches.
- Keep commits atomic; include body details when altering session management or cache persistence.
- PR descriptions should summarize intent, list manual verification (commands run, Telegram scenarios exercised), link related issues, and attach console excerpts when tool output changes.
- Confirm no sensitive credentials or runtime artifacts from `data/` are committed before requesting review.

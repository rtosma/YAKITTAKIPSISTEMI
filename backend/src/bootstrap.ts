/**
 * Bootstrap Entry Point
 *
 * MUST be the process entry point (see package.json `dev`/`build` scripts).
 *
 * Why this file exists: in ES Modules, an importing module's own top-level
 * code only runs AFTER every module it imports has been fully evaluated —
 * regardless of where in the file the import statement or the executable
 * code textually appears. Previously `dotenv.config()` was called inside
 * `index.ts`, but `index.ts` itself imports `./routes/routes`, which
 * transitively imports `./services/tokenService` — and that module reads
 * `process.env.JWT_SECRET` / `process.env.JWT_REFRESH_SECRET` at module
 * scope. That read always happened BEFORE `dotenv.config()` ran, so a
 * `JWT_SECRET` set only in a local `.env` file was silently ignored and the
 * hardcoded fallback secret was used instead — even though everything
 * "looked" configured.
 *
 * Loading `dotenv/config` here, as the first and only statement before
 * importing `./index`, guarantees environment variables are populated
 * before any other application module evaluates.
 */
import 'dotenv/config';
import './index';

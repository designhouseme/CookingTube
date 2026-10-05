# CookingTube — technical guide

Deployment, storage, API and limits. For an overview of the app, see the [README](../README.md).


Recipes from public YouTube cooking videos, with Polish and English generation.
The Cloudflare target runs the app and API on **Workers**, stores immutable recipe
JSON in **R2**, and keeps the catalogue, anonymous votes and generation leases in
**D1**. R2 is object storage; it does not run the application server.

## Run locally

```sh
npm ci
cp .env.example .env.local
# Set GEMINI_API_KEY in the ignored .env.local file.
npm run dev
```

Next.js starts on http://127.0.0.1:5173. Generation works on the local Next.js server;
shared storage and voting require Cloudflare bindings. Missing bindings return an
explicit unavailable response, never a pretend successful save or vote.

For the Cloudflare runtime, set `GEMINI_API_KEY` in an ignored `.dev.vars` file,
then run:

```sh
npm run db:migrate:local
npm run dev:cloudflare
```

To test the production Worker locally with the same database:

```sh
npm run build:cloudflare
npm run preview:cloudflare
```

Local D1/R2 state stays in `.wrangler`. The checked-in database UUID is a local
placeholder. The compatibility date matches the versions of Wrangler and the Vite
plugin pinned in this project; upgrade them together before advancing the date.

## Later deployment to Cloudflare

No production resources are created by installing or building the app.

1. Create an R2 bucket named `cooking-tube-recipes` and a D1 database named
   `cooking-tube-catalog` (or adjust the non-secret resource names in the template).
2. Set `CLOUDFLARE_DATABASE_ID` in your shell/CI secret configuration. Run
   `npm run cloudflare:config`; it writes ignored `wrangler.local.jsonc`.
3. Apply `wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc`.
4. Set the Worker secret with `wrangler secret put GEMINI_API_KEY --config wrangler.local.jsonc`.
5. Run `npm run build:cloudflare`, then
   `wrangler deploy --config dist/server/wrangler.json`.
6. Verify generation, reload/share a stored recipe, vote from two browsers,
   install the PWA and open a saved recipe offline before opening production traffic.

Use a dedicated bucket with public access disabled. The Worker serves recipe
JSON through the validated API; browsers never receive R2 or Gemini credentials.
Do not commit actual project/database/account IDs, `.env*`, `.dev.vars`, private
keys or `wrangler.local.jsonc`. Application bindings come from the Wrangler
configuration.

## Storage and voting

- The budget is **200,000,000 UTF-8 bytes** of recipe JSON across both languages,
  with a maximum of 65,536 bytes per recipe. This excludes Worker assets, D1
  metadata/votes and device-local copies. Videos stay on YouTube.
- Each `(video ID, language)` has one immutable object at
  `recipes/{pl|en}/{videoId}.json`. Reopening a recipe avoids another AI request.
- A SQLite trigger reserves capacity in the same transaction as a durable upload
  outbox. Failed/interrupted R2 writes keep their reservation and payload in D1;
  opening that recipe retries the exact same upload. Pending uploads are hidden
  from the public listing. There is no automatic eviction of existing recipes.
- A unique `(recipe, language, browser ID)` vote can be set to `1`, `-1` or removed
  with `0`. Retries do not increment it. This is browser-level voting, not proof
  of a unique person: clearing site data or using a different browser permits a
  new vote. No IP addresses or accounts are collected for this feature.
- D1 leases cap active generation at two requests across Worker instances and
  six attempts per browser per hour. Leases expire after three minutes if a
  request crashes. These limits do not replace provider account quotas.

## Video safeguards and timestamps

The server first asks Gemini to classify the actual video. Acceptance requires
one cooking recipe, ingredients, preparation, confidence of at least 0.85 and at
least two distinct in-range observations. Non-cooking, incomplete, unavailable,
unsafe or uncertain material stops before the recipe-generation call. Videos
over one hour are rejected. Both calls share a two-minute provider deadline.

The second call produces the recipe in the requested language. Quantities need
supporting quotations. Both calls write moments and the video length as player
clock strings (`M:SS`, `H:MM:SS`), parsed by `lib/video-moment.ts`; asked for
plain seconds, the model wrote 1:25 as `125` in some answers and as `85` in
others. A bare number or an impossible clock such as `2:75` is never read as a
moment. The real length from YouTube is passed to the recipe call. Step
timestamps need an observation, chronological order and a position inside the
assessed duration; invalid or missing timestamps become
`null`. Timestamps come from model observations, not independently verified
captions, and can be approximate. The player additionally checks the actual video
duration before seeking. Private/unavailable videos and disabled embedding have
an explicit fallback link to YouTube. Model classification reduces mistakes but
cannot guarantee that every accepted video or generated instruction is correct.

## Language and frontend integration

`lib/locale.ts` selects Polish for `pl` / `pl-*`; other preferred languages fall
back to English. APIs use `Accept-Language`; `?lang=pl|en` or `X-App-Locale` selects
an explicit variant. `hooks/use-app-locale.ts` provides the same browser-language
selection for React without hydration mismatches. Generated `Recipe.language`
records the language; public library entries and votes are separated by language.

The backend and frontend modules have distinct files:

- `lib/library.server.ts`: request-scoped D1/R2 access (never import into client code).
- `lib/local-library.ts`: the browser's saved recipes, shopping and progress.
- `lib/browser-identity.ts`: persistent anonymous UUID used in `X-Voter-Id`.
- `components/app/watch-along.tsx`: embedded YouTube player and clickable timed steps.
- `components/recipe-votes.tsx`: votes for a stored recipe; pass its `id` and `language`.
- `components/shared-recipes.tsx`: public catalogue; its `onOpen(id, recipe)` callback
  lets the interface save locally and navigate to the recipe.
- `components/pwa-status.tsx`: installation, offline feedback and production service-worker registration.

For generation, send `X-Voter-Id: voterId()` and `X-App-Locale` from the locale
hook to `POST /api/recipe` with `{ "url": "<public YouTube URL>" }`. The response
contains `recipe`, `saved` (shared-storage status), and an optional localized
`warning`. Display that warning; still keep a local copy if shared storage fails.
For a shared link, load `GET /api/library?id=<videoId>&lang=<locale>` before offering
to generate the recipe again. `GET /api/library?lang=<locale>&offset=0` returns
20 entries plus `nextOffset`; `POST /api/vote?lang=<locale>` accepts `{ id, value }`
and the browser ID header.

Integration of these components and translation of the existing screens are
deferred while another agent finishes the interface. Mount `PwaStatus` in the
application shell, `WatchAlong` and `RecipeVotes` on a real recipe, and
`SharedRecipes` on the library screen. The service worker only registers after
`PwaStatus` is mounted in a production build. The matching manifest/icons belong
to the interface work. Existing local recipe storage should retain language
variants before switching the UI locale.

The PWA service worker caches same-origin application pages/assets and visited
route responses. API requests, generated POST responses, votes, YouTube videos
and third-party content are never cached. The offline fallback can also read the
validated app library's localStorage format without loading React. Generating,
voting, syncing the shared library and watching YouTube require a connection.
The browser can evict local caches; offline copies are not a cloud backup.

## Verification

```sh
npm test
npx tsc --noEmit
npm run build
npm run build:cloudflare
npm run cloudflare:types
```

Tests cover classification rejection, timestamp bounds, language selection and
cache isolation, byte quotas with real SQLite constraints, upload recovery,
idempotent votes, generation leases, request validation and credential isolation.
Provider responses are mocked in automated tests; a live Gemini smoke test needs
an API key and consumes quota. Test installability and offline navigation over
HTTPS or localhost, with a production build (service workers are disabled in dev).

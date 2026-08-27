# Releasing a new version

This is the checklist for cutting a release so other machines can pick it
up via `/system-mgmt` → "ตรวจสอบอัปเดต" (Check for Updates) → "ติดตั้งอัตโนมัติทันที"
(Apply Update), instead of everyone SSH-ing in and running `git pull` by hand.

## Why both a version bump *and* a tag are required

- The version badge (sidebar, `/system-mgmt`) reads `package.json`'s
  `version` field via `APP_VERSION` (`server.js`) — that's what "current
  version" means everywhere in the UI.
- "Check for Updates" (`GET /api/system/update-check`) does **not** look at
  commits on `main` at all. It calls GitHub's tags API
  (`api.github.com/repos/oatchidol/NurseAid/tags`), picks the highest tag
  matching `^v?\d+\.\d+\.\d+$`, and compares it against `APP_VERSION`.
- "Apply Update" (`POST /api/system/apply-update`, run by
  `compose-collector`) does a plain `git fetch && git pull` on whatever
  branch is checked out (`main`) — it doesn't care about tags at all, it
  just pulls whatever is newest on `main`.

So: commits on `main` alone are enough for Apply Update to have something
to pull, but **Check for Updates won't show anything new, and the sidebar
version won't change, until you both bump `package.json` and push a
matching tag.** Skipping either one is the most common way this silently
doesn't work.

## Steps

Run these on whichever machine has push access to
`github.com/oatchidol/NurseAid` (typically wherever you've been developing,
not the deployed machines themselves).

### 1. Land your changes on `main` first

Normal commits, or a branch merged into `main`. Nothing release-specific
here — do this as many times as you like before cutting a release.

### 2. Rebuild the CSS if any UI class names changed

`public/assets/tailwind.css` is a **committed build artifact** — it's generated
by scanning `server.js` for the utility classes actually used, so a stale file
means any class you just added silently renders with no styling.

```sh
npm run build:css
git add public/assets/tailwind.css
```

Commit the regenerated file (as part of step 1's work, or its own commit)
**before** you tag. Nothing regenerates it at image build time: the Dockerfile's
builder stage runs `npm ci --only=production`, so `tailwindcss` — a
devDependency — isn't installed there.

### 3. Bump the version

Pick the next version per semver (new feature → minor, fix-only → patch).
Update it in **three places**, all of which must agree:

```jsonc
// package.json
"version": "2.19.0",
```

```jsonc
// package-lock.json — TWO occurrences, both must match:
{
  "version": "2.19.0",          // root
  "packages": {
    "": {
      "version": "2.19.0",      // the "" (self) package entry
```

Sanity-check before moving on:

```sh
node -e "console.log(require('./package.json').version)"
node -e "const p=require('./package-lock.json'); console.log(p.version, p.packages[''].version)"
```

Both must print the same version, or `npm ci` will warn/drift out of sync
with `package.json` on the next install.

### 4. Add a CHANGELOG.md entry

Add a new `## [X.Y.Z] - YYYY-MM-DD` section directly under `## [Unreleased]`,
above the previous release. Follow the existing style — Thai descriptions,
`### Added` / `### Changed` / `### Fixed` / `### Known issues` subsections
as needed, one bullet per notable change. Look at the last couple of
entries in `CHANGELOG.md` for the exact tone/format to match.

### 5. Commit and tag

```sh
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
```

The tag **must** start with `v` and be `vMAJOR.MINOR.PATCH` — matches the
existing tags (`v2.14.0`, `v2.16.0`, `v2.17.0`, `v2.18.0`...) and the
regex `update-check` parses tags with.

### 6. Push both the commit and the tag

```sh
git push origin main
git push origin vX.Y.Z
```

**Pushing `main` alone is not enough** — that's the single most common way
to think you've released something and have nothing actually show up on
other machines. `git push --tags` also works if you have other unpushed
tags you want to include, but prefer pushing the one tag explicitly so you
don't accidentally push something half-finished.

### 7. Deploy this machine too

The machine you just pushed from will **never** see its own release as
"available" via Check for Updates — it's already the source. Deploy it the
normal manual way:

```sh
git status --porcelain   # must be empty
docker compose up -d --build nurseaid compose-collector
docker compose ps nurseaid compose-collector   # both must be healthy
curl -s http://localhost:3333/health/ready     # {"ready":true,...}
```

If `package.json`'s version changed, restart `nurseaid` (or just let the
`--build` above recreate it) so the in-memory update-check cache doesn't
serve a stale "up to date" result from before the tag existed.

## On every other machine (Pi, ward stations, etc.)

Nothing to run by hand. Log in as `super_admin`, go to `/system-mgmt`:

1. Click "ตรวจสอบอัปเดต" (Check for Updates) — should show
   "🆕 มีอัปเดตใหม่: vX.Y.Z".
2. Click "ติดตั้งอัตโนมัติทันที" (Apply Update). The pipeline pulls, builds,
   recreates, and health-checks `nurseaid` on its own; if the new version
   fails its health check it **automatically rolls back** to the previous
   working version and shows a clear failure/rollback message instead of
   leaving the machine broken.

Manual fallback (same commands as before this feature existed, still
works, still documented in `DEPLOY.md`):

```sh
git status --porcelain   # must be empty first
git pull origin main
docker compose up -d --build nurseaid compose-collector
```

Or use `scripts/updategit.sh` for the backup+update+rebuild-in-one-go
version (also backs up `.env`; note it does **not** back up
`nginx/certs/` — regenerate with `scripts/generate-certs.sh` if you're
relying on `git clean -fdx` behavior after a restore).

## Common ways this goes wrong

- **Forgot to push the tag.** `main` is up to date on GitHub, but Check for
  Updates still says "up to date" everywhere. Fix: `git push origin
  vX.Y.Z`.
- **`package.json` version and the tag name don't match.** e.g. tagged
  `v2.19.0` but `package.json` still says `2.18.0` (or vice versa). The
  sidebar and the "current version" Apply Update reports will be
  inconsistent with what GitHub says is latest. Always bump the file
  *before* tagging, and double-check both agree before pushing.
- **Target machine has uncommitted local changes.** Apply Update refuses
  immediately with "repo has uncommitted local changes, refusing to
  update" and touches nothing — by design (see
  `.claude/plans/auto-update.md`). The admin running it needs to `git
  status` on that machine, and either commit/stash the change or discard
  it, before retrying.
- **Tag doesn't match `^v?\d+\.\d+\.\d+$`.** Pre-release suffixes like
  `v2.19.0-rc1` won't be picked up by `update-check`'s tag parser — it
  silently skips anything that doesn't parse as a clean three-part
  version. Stick to plain `vMAJOR.MINOR.PATCH` for real releases.
- **Stale update-check cache.** Successful checks are cached in-memory on
  the `nurseaid` process for ~5 minutes to stay under GitHub's
  unauthenticated rate limit (60 req/hr/IP). If you just pushed a tag and
  a machine still reports the old version, wait a few minutes or restart
  `nurseaid` on that machine to clear the cache.

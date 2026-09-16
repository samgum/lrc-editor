# Media Bridge compatibility — v0.4.7

## Scope

- Remove the media loader's blanket minimum-version gate. Validate actual provider results instead.
- An omitted version or Music capability marker does not reject an otherwise compatible result.
- Only an explicit `youtubeMusic: false` reports an unsupported Music capability.
- Missing or malformed song metadata reports an unverified source, not an outdated extension.
- Keep same-window/origin/request matching, HTTPS/provider-host checks, audio MIME checks, and verified Music source requirements. No automatic Music-to-MV fallback.
- Repeated acknowledgements cannot extend the request deadline or leave extra timers.
- Update all nine interface languages and release desktop, Edge Mobile, and Firefox Android packages as v0.4.7, without permission changes.
- Pin AI installer downloads to the page's release version. Existing AI engines do not require reinstallation; their protocol and minimum safety version are unchanged.

## Validation

- Full unit suite: 42 files, 366 tests passed.
- TypeScript, correctness lint, changed-file formatting, and tracked-project formatting passed. The latter excludes pre-existing untracked `.tmp-audit/` and `docs/audits/` files, which were not changed.
- Web and all three extension builds passed; mobile package validation passed.
- Built-web browser checks used a disposable headless Edge profile and a synthetic one-second WAV, with mocked legacy extension messages. All ten cases passed across 1440px and 320px widths: old-version video, unversioned video, verified Music without an ACK capability marker, explicitly unsupported Music, and unverified legacy Music. Valid audio reached the player; rejected sources did not. Draft text remained unchanged and notifications stayed inside the viewport.
- Browser checks test the compatibility bridge, not anonymous live YouTube downloading. Platform login, access restrictions, and extraction failures are not bypassed or claimed resolved.

## Release and rollback

- Previous production source: `59337f886a0197e93f6a49917386cbef98185ea1`; previous Cloudflare deployment: `78c022ac-38d2-4254-a46c-acc1474ba469`.
- Publish a new v0.4.7 release; preserve the existing v0.4.6 release and its assets. Include the unchanged v0.4.6 AI installer filenames in the new release so previously cached pages using `latest/download` keep working.
- Verify production and GitHub Pages asset hashes against the committed build, and published archives against local checksums.

# Select controls and YouTube Music source selection

## Scope

- Replaced all ten native selects in the web app with one shared select-only combobox: interface language, Huhu language, theme mode, timestamp precision, editor export, three utility selectors, preview lead, and beat subdivision.
- Added theme-aware popup surfaces, SVG selection marks, hover/focus states, reduced-motion support, keyboard/type-ahead navigation, scrolling within the menu, and placement bounded by the viewport, header, and player.
- Kept native text editing and the existing timing/export values. Menu keys are excluded from timing shortcuts. Nested settings panels stay open when an option is selected; Escape closes the menu before its parent panel.
- Preserved YouTube Music source intent in the extension request. Official counterpart metadata has priority; the fallback requires a unique exact-title album result with identical artist channel IDs. Regular YouTube URLs retain their original video ID. Token generation and media refresh both use the resolved ID.
- Same-version extensions lacking the capability are detected, rather than accepting their MV result. The original shared URL remains visible and the audio filename reflects the resolved song. No new dependencies, browser permissions, version bump, backend, or AI-installer changes.

## Verification

- 343 tests across 42 files passed, including eight select navigation/placement cases, shortcut guarding, Music matching and rejection cases, capability checks, and resolved file naming.
- Browser checks used an isolated localhost origin, without reading saved provider keys or modifying production lyrics.
- All nine interface locales kept the Korean/English language choice and their eight Huhu options; each opened menu stayed inside a 390 × 844 viewport with no horizontal document overflow.
- Confirmed keyboard preview versus saved choice, Escape cancellation, Enter confirmation, prefix search, Tab confirmation/focus movement, and preference restoration after reload.
- Inspected light/dark menus, narrow utility/export layouts, and nested beat controls at 844 × 390. Selecting a beat option left its parent open; typing `s` and dismissing the menu left playback paused at zero. A second Escape closed the parent settings.
- Verified SRT conversion output, translation splitting, uppercase output, line/word export choices, default LRC restoration, and unchanged lyric text/timestamps across mode changes. Preview-lead selection did not advance the word cursor or stamp a time.
- Browser warning/error log was empty during these checks.

## Live media evidence and limits

The supplied Music URL uses video ID `s466YCiHfKw`. The provider's page identifies it as **FALLEN ANGEL (Official Video)** by JENNIE, lasting **5:43**. An initial public Music search returned the album track **FALLEN ANGEL**, ID `cOARkf5ZmtI`, **3:20**, with the same artist channel `UCAl7xQ6q0PEgZMQD7zr4AKQ` and album `MPREb_k5ySekCYEqV`. These identities are covered by regression fixtures; no ID or artist is hard-coded in the resolver.

Subsequent anonymous live checks stopped returning that song in search, and the player endpoint returned `LOGIN_REQUIRED` / `Sign in to confirm you’re not a bot`. The connected Chrome session then became unavailable. A full live audio download is therefore **not verified** in this pass, and no authentication challenge was bypassed. In this situation the new resolver refuses an unconfirmed replacement rather than selecting another artist or silently loading the MV.

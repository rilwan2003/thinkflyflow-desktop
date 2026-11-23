# Code signing

Windows and macOS installers are currently distributed **unsigned**. Windows
SmartScreen shows "Windows protected your PC" and macOS Gatekeeper blocks the
DMG until the user explicitly allows it.

This document tracks the route to signed builds.

## Why SignPath Foundation

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

The Foundation issues certificates in its own name to open source projects, so the
requirements are strict and non-negotiable.

## Eligibility (all satisfied as of v0.1.0)

| Requirement | Status |
|---|---|
| OSI-approved licence, no proprietary components | AGPL-3.0-only, detected by GitHub |
| Public repository | yes, history included |
| Already released in the form to be signed | v0.1.0, Windows `.exe` published |
| Functionality documented on the download page | README |
| Code signing policy stated on the home page | README, "Code signing policy" |
| Privacy policy stated | README, "Privacy policy" |
| Team roles declared | README, "Code signing policy" |
| MFA on repository and SignPath accounts | **required, must be confirmed** |

## What is needed from the project owner

1. **Enable MFA on the GitHub account** that owns the repository. SignPath
   requires it, and the application asks for confirmation.
2. **Apply**: https://signpath.org/apply
   - Project: ThinkFlyFlow Desktop
   - Repository: https://github.com/rilwan2003/thinkflyflow-desktop
   - Licence: AGPL-3.0-only
   - Home page: https://thinkflyflow.laureljar.com
   - Release: https://github.com/rilwan2003/thinkflyflow-desktop/releases/tag/v0.1.0
   - Download URL: the release page above
3. **When approved**, SignPath issues an organisation id and an API token.

## What happens after approval

1. Store `SIGNPATH_API_TOKEN` and `SIGNPATH_ORGANIZATION_ID` as repository secrets.
2. Set repository variable `SIGNPATH_ENABLED` to `true`.
3. Add the SignPath signing step to the release workflow (submitting the NSIS
   installer, then verifying with `Get-AuthenticodeSignature`).
4. Confirm the resulting file reports the SignPath Foundation subject.
5. Publish a new patch release and check SmartScreen no longer warns.

Until then, releases remain unsigned and the workflow warns about it explicitly
rather than producing something that looks signed.

## Alternative: own certificate

If signing must not depend on Foundation approval, a standard OV or EV code
signing certificate can be used instead. The workflow already supports it through
`CSC_LINK` / `CSC_KEY_PASSWORD` (macOS) and `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD` (Windows). Note that secrets must be **unset** rather than
empty when absent: an empty `CSC_LINK` makes electron-builder resolve the working
directory as the certificate path and abort the build.

# Chrome Web Store listing

Everything the Chrome Web Store dashboard asks for, ready to paste. Images are in this folder; the upload zip comes from `npm run package:extension` (`dist/diarea-extension-<version>.zip`).

## Package

| Field | Value |
|---|---|
| Upload | `dist/diarea-extension-0.4.0.zip` |
| Name | Diarea |
| Version | 0.4.0 (from `extension/manifest.json`) |

## Store listing

**Summary** (from the manifest, 113 of 132 characters)

> Finds what your frontend leaks: keys, source maps, API maps and AI prompts, scored Sealed to Gushing. Local only.

**Description**

```
Your frontend is leaking. Diarea tells you how much.

An AI agent can now read your website and rebuild your product from what it finds. Diarea reads it first. Click the icon on your own site and get a Leak Score from 0 to 100, from Sealed to Gushing, with a one-line fix for every finding.

Ten checks:
• Source maps published in production
• Secrets and tokens in client code (shown as a prefix and a length, never in full)
• Scoring or business logic running in the browser
• Fat hydration payloads carrying fields nobody sees
• Readable, un-minified bundles with the TODOs still attached
• A self-mapping API, GraphQL included
• Your AI system prompt sitting in the bundle
• The browser calling an AI model API directly
• Hidden fields and data attributes carrying prices, roles and flags
• A stack that is easy to fingerprint

Private by design:
• Runs only when you click, only on the current tab
• Reads the page inside your browser and sends nothing anywhere
• No account, no tracking, no storage
• Read-only: never changes the page

Diarea is a diagnosis, not armour. The real fixes are server-side, and every finding tells you which one.

Scan sites you own or are authorised to test. Free and open source (MIT): https://github.com/kriszwart/diarea

Also available as a CLI (npx diarea scan) and a GitHub Action that fails the build and comments the score on pull requests.
```

| Field | Value |
|---|---|
| Category | Developer Tools |
| Language | English (United Kingdom) |
| Homepage URL | https://diarea.tools/ |
| Support URL | https://github.com/kriszwart/diarea/issues |

**Graphics**

| Slot | File |
|---|---|
| Store icon (128×128) | `extension/icons/icon-128.png` |
| Screenshot 1 (1280×800) | `screenshot-1-gushing.png` |
| Screenshot 2 (1280×800) | `screenshot-2-findings.png` |
| Screenshot 3 (1280×800) | `screenshot-3-sealed.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560.png` |
| Promo video (optional) | https://youtu.be/pWG9IXBkpvM |

## Privacy practices tab

**Single purpose**

```
Diarea scans the web page in the current tab for information its frontend exposes (keys, source maps, API endpoints, AI prompts and similar) and shows a scored report with fixes, inside the extension popup.
```

**Permission justifications**

- `activeTab`: `Diarea scans only the tab the user is looking at, and only after the user clicks the extension icon. activeTab grants that one-off access without needing permission for any website.`
- `scripting`: `Used to run Diarea's read-only scan inside the current tab when the user clicks the icon, so it can read the page's scripts, markup and page globals. It never modifies the page.`
- Host permissions: none requested.

**Remote code**: No, I am not using remote code. (All JavaScript ships in the package; the scan re-reads the page's own scripts as text and never executes code from anywhere else.)

**Data usage**: tick none of the data types. Diarea does not collect or transmit user data. Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**: https://diarea.tools/privacy.html

## Distribution

| Field | Value |
|---|---|
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |

## Before you submit

1. `npm run package:extension` and upload the zip.
2. Paste the fields above and upload the images.
3. A one-off developer registration fee applies to new Chrome Web Store developer accounts.
4. Review usually takes from a few days to a couple of weeks. Narrow permissions (no host permissions, no remote code) tend to help.

## Regenerating the images

```
npm install
npm run build:extension
npm run store:assets      # set CHROMIUM_PATH to use a specific Chromium
```

The screenshots are the real popup scanning the PromptPlop demo and a made-up clean site (`clean-site.html`); `scripts/render-store-assets.js` stands in for the `chrome.*` APIs so the popup can run outside Chrome.

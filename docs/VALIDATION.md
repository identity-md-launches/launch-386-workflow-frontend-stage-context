# Frontend validation

## Scope and outcome

Complete for the authorized frontend scope: one React/TypeScript/Vite page, committed static export, implementation-derived ABIs, deployment manifest and worker evidence. The deployed Solidity sources and protected build configuration are unchanged. This report records worker observations, not independent network certification.

The workspace's `.git` directory is mounted read-only: `git add` fails when creating `index.lock`. Delivery is therefore committed in an isolated writable checkout at `/tmp/ratelimit-delivery`, with a complete Git bundle at `/tmp/ratelimit-frontend.bundle`. The authorized files are also left in this workspace for the publisher to collect. Bundle size is checked after the final commit against the 8,388,608-byte limit; the bundle itself and temporary checkout are not copied into the submission tree.

The higher-priority scope permits only `web/**`, `dist/**`, `docs/**` and explicitly `web/.gitignore`. The root `DESIGN.md` requirement is therefore fulfilled at `docs/DESIGN.md` without writing outside scope. Only `web/.gitignore` uses the explicit ignore-file path allowance. No root ignore/configuration file is changed.

The workflow specifically selects PoolSwapTest. Its approved address lives in the manifest routing extension; the supplied network block is unchanged. Quotes use its V4Quoter, prices its StateView and manager verification its PoolManager. Native buys need no approval; RATE approvals target the actual PoolSwapTest spender. The generic Universal Router example is not used for this assignment.

## Commands and evidence

| Check | Outcome / evidence |
| --- | --- |
| `npm ci` / npm dependency installation | Lockfile supplied; normal dependencies, cache outside the repository. Node 24.21.0 / npm 11.19.0. |
| `npm run typecheck` | Pass, also required by the production build. Strict TypeScript covers source and Vite configuration. |
| `npm run build` | Pass. Final Vite export uses relative assets; implementation ABI hashes verified before manifest emission. |
| `npm run verify` | Pass: 11 declared assets, 595,599 total export bytes including the manifest, exact network block and contract set, all SHA-256 hashes, both canonical Keccak hashes, safe paths and size limits. |
| `npm test` | 20 passing interaction/validation scenarios. The production export is served at `/preview/`; signatures, submissions and receipts are mocked. See `evidence/interactions.json`. |
| Axe WCAG 2 A/AA, 2.1 AA and 2.2 AA rules | Zero violations in the tested desktop disconnected state; 29 rules passed. This does not certify full accessibility. |
| Rendered contrast measurements | Eight actual computed pairs meet their recorded thresholds; see `evidence/contrast.json`. |
| `npm run check:chain` | All three supplied RPCs returned Sepolia chain ID, nonempty configured contract code, correct PoolSwapTest manager, pool state and a successful V4Quoter `eth_call`. See `evidence/live-chain.json`. No transaction was broadcast. |
| `npm audit` | Zero reported vulnerabilities after updating viem, React and Vite. |
| Installed browser tool | Final export opened under `/preview/`, desktop and mobile screenshots viewed, public-RPC data observed, console and network inspected. Final navigation had zero console errors/warnings. |

Playwright 1.56.1 initially refused Ubuntu 26.04. Its Ubuntu 24.04 fallback Chromium 141.0.7390.37 ran successfully with the environment settings in `web/README.md`. Browser sessions and the preview are owned and closed by the bounded test script; the optional five-minute review window allowed the installed browser tool to inspect the same export. No production server is part of the deliverable.

The initial harness was corrected to wait for asynchronously loaded history, use accessible button names without decorative arrows, create an explicit browser context for Axe, and provide tsx's name helper to serialized mock callbacks. These were test setup failures, not claimed passing product checks. The final evidence comes from the corrected harness and final export.

## Meaningful interactions

`web/tests/interaction.ts` asserts:

1. Amount precision/range validation, signed BalanceDelta decoding and integer price-limit direction.
2. Disconnected wallet state, latest-block counts, grouping multiple events per block and the three-count flag.
3. Keyboard skip navigation, amount-field focus and the automated accessibility scan.
4. Computed text, focus-ring and input-boundary contrast.
5. No horizontal overflow at 320, 390 and 820 CSS pixels, 200% root-text enlargement, and reduced-motion behavior.
6. Missing-wallet recovery and rejected connection.
7. Wrong-chain disabling and exact supplied add-chain parameters after 4902.
8. Invalid-field focus recovery and disabled quote controls in a full block.
9. ETH buy quote, simulation and mocked confirmation with negative exact input, native transaction value and no approval.
10. RATE sell's exact spender/amount approval followed by a zero-ETH swap.
11. Nested WrappedError/RateLimited decoding that prevents a wallet prompt.
12. A block filling between review and send; the second simulation/slot check refuses signing.
13. Partial-fill disclosure and recoverable wallet signature rejection.
14. Reverted receipt classified as failed instead of confirmed.
15. Hook data forwarding and amount-change invalidation of quote/review.
16. Account-change invalidation and 60-second quote expiration.
17. Empty history, history RPC failure and absent deployed code.
18. RPC failure displaying unavailable data rather than fabricated zero counts.
19. Corrupted ABI rejection before contract operations.
20. Real public-RPC browser reads and successful relative-subpath resource loading.

The mock asserts destination addresses from the generated manifest and decodes actual submitted calldata. These tests validate the application's request construction and decisions; they do not simulate EVM pool execution or establish economic outcomes on the live chain. The supplied protected Solidity tests were read to understand contract semantics; this frontend assignment does not rerun or change the deployed-contract test suite.

## Better Interface review

The pinned workflow and core principles of all six domains were read before implementation. Supporting keyboard, form, responsive and design-document guidance informed the implementation. Attribution is in `THIRD_PARTY_NOTICES.md`.

| Domain | Coverage | Evidence and limits |
| --- | --- | --- |
| Accessibility | Checked | Native landmarks, single h1, labels, scoped table headers, skip link, persistent alert/status regions, keyboard flow, visible amount focus, 44px buttons and disclosure controls. Axe zero violations in the stated state. No screen-reader session, physical touch device or full forced-colors walkthrough. |
| Layout | Checked | Desktop 1440×1080 and mobile/intermediate 320×900, 390×900, 820×900. Populated history, empty history and swap review rendered without horizontal overflow. Long deployment IDs wrap. 200% text enlargement checked, browser-native zoom not checked. |
| Writing | Checked | Explicit action names, field-specific recovery, testnet label, precise approval amount/spender, slot races, reverted-swap semantics and the router's price-limit/partial-fill limitations. Fixed singular slot wording. English only. |
| Typography | Checked | Descending heading hierarchy, system font fallbacks, 16px small inputs, tabular numbers, wrapping addresses and unclipped numeric inputs at tested widths. No web fonts downloaded; computed family is not proof of an installed Inter face. |
| Colors | Checked | Shared semantic roles, text badges supplement color, measured rendered text/focus/control pairs. Light theme only; no dark-theme claim. Error colors source-reviewed; not every error/background combination was measured separately. |
| UI details | Checked | Hover, focus, active, disabled, loading, empty, error and review states exercised or source-reviewed. Next transaction step receives the sole filled action treatment. Reduced motion disables transitions. No modal, autoplay or staged animation to inspect. |

### Findings, fixes and rechecks

| Severity / location | Finding and effect | Correction / recheck |
| --- | --- | --- |
| Medium — `web/src/App.tsx:53` | Invalid-input focus was requested while the submitting fieldset could be disabled; the keyboard assertion reproduced lost focus. | Restore focus after the busy state clears. Final invalid-field interaction passes. |
| Medium — `web/src/styles.css:8`, `:98`, `:102`, `:112` | Quiet separator borders were also used around editable fields. This did not provide a clear enough control boundary. | Dedicated `--control-border` applied to fields. Measured 3.40:1 against page and 3.71:1 against white; rendered screenshots rechecked. |
| Medium — `web/src/App.tsx:231` | Refresh quote could compete with confirmation as a second filled action. | Demote refresh after a quote, emphasize only the next approval/simulation/confirmation step. Final review screenshot checked. |
| Low — `web/src/App.tsx:230` | A one-slot state said “1 slots remaining.” | Singular/plural wording corrected and rendered with one available slot. |
| Low — `web/index.html:7` | The installed browser tool requested an absent favicon, causing a resource/console 404. | Added a local three-stroke SVG icon. Final tool navigation reports zero console errors; icon receives HTTP 200. |
| Medium — `web/package.json` | Initial dependency audit reported transitive websocket and Vite advisories. | Updated the affected dependency set and lockfile; audit reports zero vulnerabilities. Production build and interactions rerun. |

No unresolved finding blocks the authorized page. Root design-file location remains an explicit assignment constraint conflict, resolved in favor of the write-scope rule.

### Rendered artifacts

- `evidence/desktop.png`: mocked, populated desktop history and two used slots.
- `evidence/focus.png`: keyboard-focused amount input.
- `evidence/viewport-320.png`, `viewport-390.png`, `viewport-820.png`: populated responsive states.
- `evidence/swap-review.png`: successful simulated buy review (mocked).
- `evidence/live-desktop.png`: test-run browser with real public-RPC state.
- `evidence/browser-live-desktop.png`, `browser-live-mobile.png`: installed browser tool viewing the final export at 1440 and 320 pixels.
- `evidence/browser-console.txt`, `browser-network.txt`, `browser-mobile.json`: final tool console, resource requests and measured 320px layout. The measurement sampled the initial loading state; the saved screenshots subsequently show live data.

Screenshots are actual browser output, not design mockups. The agent viewed desktop, mobile, focus and review artifacts; automated measurements supplement the visual inspection.

## Remaining limits

No real wallet approval or swap was sent. Wallet extension UI, real signing, gas estimation at execution time, pending-transaction replacement, long receipt timeouts, public-RPC failover under every failure mode and behavior across a real chain reorganization remain untested. The UI blocks duplicate submission after unknown confirmation, but this is not a wallet-wide transaction lock.

PoolSwapTest has no minimum-output or onchain deadline. A 60-second UI quote expiry does not expire a signed transaction. Price limits can partially fill, and slot counts can change before inclusion. Public chain reads can be delayed or unavailable; code-presence and binding checks do not constitute a bytecode audit. Browser support was exercised in Chromium, not Firefox, Safari, physical devices or assistive technology.

Publication, IPFS pinning, naming and control-plane checks are the publisher's subsequent work. They were not run and are not used as evidence of browser behavior.

# Ratelimit design

## Overview

Ratelimit is an observatory and swap form for visitors trying a Sepolia contract experiment. A quiet, warm background and large numeric counter make the shared three-slot limit the first thing to understand. The desktop layout places observation on the left and the transaction flow in a white card on the right. The source of truth is `web/src/styles.css`; markup and component state live in `web/src/App.tsx`.

## Colors

The existing implementation uses hex primitives mapped to semantic CSS properties. Reuse semantic properties in components.

| Role | Token | Value |
| --- | --- | --- |
| Page | `--page` | `#f5f5f0` |
| Surface | `--surface` | `#ffffff` |
| Secondary surface | `--subtle` | `#eceee7` |
| Body text | `--text` | `#202d24` |
| Supporting text | `--muted` | `#5b655a` |
| Structural separator | `--border` | `#d5d9ce` |
| Input boundary | `--control-border` | `#7c8879` |
| Primary action / occupied slot | `--accent` | `#36513a` |
| Action hover | `--accent-hover` | `#283f2c` |
| Availability surface | `--accent-soft` | `#e5eddd` |
| Warning text / surface | `--warning` / `--warning-bg` | `#71501b` / `#fbf0d8` |
| Error text / surface | `--error` / `--error-bg` | `#8a3029` / `#fbece8` |

Occupied slots use the same green as the transaction action, but are explicitly labeled Counted and contain no click affordance. Available slots use dashed borders and the Available label. Limits also have a text badge; color never carries status alone. The page has one light theme. Focus uses a 3px accent outline with 3px offset, or 4px around primary buttons; forced-colors mode uses system Highlight.

Measured rendered pairs are recorded in `docs/evidence/contrast.json`: muted/page 5.56:1, muted/white 6.08:1, white/primary 8.77:1, warning/badge 6.48:1, input border/page 3.40:1, input border/white 3.71:1, focused input outline/page 8.02:1. These measurements cover the listed states, not every possible wallet/browser rendering.

## Typography

The sans stack is `Inter, 'Helvetica Neue', Arial, sans-serif`. There is no downloaded font: installed fonts determine the final face; the worker's browser uses its available fallback. Numbers, addresses and technical labels use `SFMono-Regular`, Consolas or Liberation Mono fallbacks. These are system fonts, with no required font asset or external request.

The base is 16px/1.5 at weight 400. Body, small, caption and heading roles are `1rem`, `.875rem`, `.75rem` and `1.375rem`. Compact overline labels use `.6875rem`, uppercase presentation and `.1em` tracking. Headline size is `clamp(2.75rem, 5.6vw, 4.75rem)`, line-height 1.02, weight 500 and tracking `-.055em`. Section headings are weight 600. The counter is `5.75rem`, becoming `5rem` on small screens. Amount entry is `2.25rem` and remains above 16px on mobile. Small numeric inputs remain 16px.

Tabular numerals stabilize changing counts and prices. Headings use balanced wrapping, prose uses pretty wrapping, and addresses use `overflow-wrap: anywhere`. Truncated header accounts have full values in deployment details. Informational prose is limited to roughly 60–64 characters where the layout allows. Normal body text is not letter-spaced.

## Layout

`.shell` caps content at 1216px with 48px desktop gutters. The dashboard uses `minmax(0, 1.45fr) minmax(0, 1fr)` with a 32px gap. Shared spacing steps are 4, 8, 12, 16, 20, 24, 32, 48 and 72px. Larger separation marks a section change; dense history rows use quiet rules.

At 65rem the shell gutters become 24px and the grid gap becomes 24px. At 53rem the dashboard becomes one column, preserving DOM order: status, history, then swap. The swap card caps at 560px. At 36rem gutters become 16px; the intro and explanation stack, typography scales down, history usage wraps vertically, and the contract grid becomes one column. No sticky element obscures content. Buttons remain at least 44px tall and all inputs remain reachable in normal document flow.

The production export was rendered at 1440, 820, 390 and 320 CSS pixels. All tested widths fit without horizontal document overflow, including populated history. A separate 200% root-text-size check passed; that is not a browser-native zoom test. Long contract values wrap when expanded. The only locale is English; translated and RTL variants are not supplied.

## Elevation & Depth

The page is predominantly flat. The white swap card is distinguished by its border and subtle two-layer shadow (`0 2px 3px #202d2403`, `0 12px 30px #202d2405`). Structural boundaries remain borders. Secondary field backgrounds and empty-history panels group information without introducing extra floating cards. The skip link is the only deliberately raised navigation layer.

## Shapes

The main swap card radius is 16px. Amount fields and review groups use 10px; general buttons, empty states and messages use 8px. Segmented controls have 10px outer and 6px inner radii with 4px inset. Badges use 4px; compact slot markers use 2px. Large slots have 6px radii, 10px gaps on desktop and 8px on small screens. The locally authored `web/public/mark.svg` repeats the brand's three-stroke motif in the favicon.

## Components

- `Slots({ used, large })` in `App.tsx` is a decorative three-part usage graphic. Its parent provides the accessible numeric count; `large` adds Counted/Available labels.
- `.section-heading` aligns section titles and secondary state. Permit both children to shrink and wrap; do not give text a fixed height.
- `.primary`, `.full-width`, `.text-button` and ordinary native buttons distinguish the next transaction step from refresh/cancel actions. A quoted form demotes Refresh quote, so the active approval, simulation or confirmation step has the filled treatment.
- `.amount-box`, `.percent-input` and labeled inputs use persistent labels and visible boundaries. Invalid fields reference the adjacent alert and receive focus after the pending fieldset is enabled again.
- `.direction-switch` uses native buttons with `aria-pressed`. It is not a tab interface. Switching direction invalidates the quote and review.
- `.review` is an inline confirmation section with spend, receive, slot availability and fee context. It requires no modal focus trap. Cancel returns to simulation; wallet rejection shows a persistent recovery message.
- `.message.error`, `.message.warning`, `.action-status` and `.transaction` carry unavailable, error, wrong-network, loading and receipt states. Error/status regions announce changes. Unknown confirmation disables another submission and offers Check transaction.
- The history is a native table with scoped headers and a caption. Only blocks with SwapCounted events appear, and transaction links are separate from block links. Empty and failed history have different messages.
- Native `details`/`summary` disclose optional hook data and full deployment information. They retain keyboard behavior and visible focus.

Buttons transition only background and press transform for 120ms with `cubic-bezier(.2, 0, 0, 1)`; press scale is `.96`. Motion is enabled only for `prefers-reduced-motion: no-preference`. There are no entrance animations, autoplay, overlays or animation dependencies.

## Do's and Don'ts

- Start additions with `.shell`, semantic headings and the shared spacing steps. Use the existing color roles rather than inventing a second palette.
- Keep current block, update age and unavailable state visible alongside the counter. Never display a zero as a substitute for an RPC error.
- Use a single filled transaction step at a time. Explain signing consequences before opening the wallet.
- Keep approval, simulation and signing distinct. Do not describe this router's price limit as a guaranteed minimum output.
- Use native controls and underlined descriptive links. Preserve zoom, paste, keyboard focus, reduced motion and full-address access.
- Do not introduce mock market data into production or use the launch's initial price as a current price.

For another static page, reuse `.shell`, the header/footer and semantic tokens; add a clear heading and native controls; check 320px reflow and the main keyboard path. Keep any new route exportable without server rewrites. This is guidance for reuse, not an additional implemented page.

Design guidance attribution is in `docs/THIRD_PARTY_NOTICES.md`. This document lives under `docs/` because the assignment's allowed-path rule prohibits creating the requested root `DESIGN.md`.

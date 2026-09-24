# @t-lingual/ui — authoring conventions

This package is the **framework layer**. It knows nothing about interpretation
sessions, passkeys, the API client, or routing. If a component needs to import
from `../../src/features`, `../../src/api`, or `../../src/app`, it does not
belong here — that is the signal to keep it in the feature layer instead.

## Layout

```
src/
  styles/       layers, reset, tokens (primitive -> semantic -> motion), base
  utils/        cx
  hooks/        useControllableState, useEventCallback, useMediaQuery,
                useReducedMotion, useScrollLock, useDismiss, useFocusTrap
  primitives/   Slot (asChild), VisuallyHidden, Portal
  providers/    ThemeProvider
  icons/        Icon (name registry)
  components/
    Button/
      Button.tsx
      Button.css
  index.ts      the ONLY public surface
```

One directory per component. Co-located CSS, imported from the `.tsx`.
Sub-components that are never used alone (`CardHeader`) live in their parent's
file. A pure helper with real logic worth testing gets its own module beside the
component (`cardA11y.ts`).

## The six rules

1. **Tokens only.** A component references tier-2 semantic tokens
   (`--tl-text-secondary`), never tier-1 primitives (`--tl-sand-700`) and never
   a literal colour. If a role is missing, add it to `tokens.semantic.css` in
   both the light and dark blocks — do not reach past the tier.

2. **Attributes, not modifier classes.** Variants are `data-*` attributes:
   `data-variant`, `data-size`, `data-state`, `data-loading`. Every component
   also carries `data-tl="<name>"`, which is what the base focus ring and the
   test suite select on. One class per element, BEM-style for parts
   (`tl-button__label`).

3. **Private custom properties are the styling contract.** Declare `--_bg`,
   `--_fg`, `--_border` (etc.) at the top of the block and have every variant do
   nothing but reassign them. Retheming one instance then means setting three
   properties instead of out-specifying a selector.

4. **Everything lives in `@layer tl.components`.** Unlayered consumer CSS beats
   every layer, so an app can override any component without `!important`.

5. **Accessibility is part of the component, not the consumer's problem.**
   Correct roles and ARIA wiring, labels associated by `id`, keyboard
   interaction per the WAI-ARIA Authoring Practices, a visible focus ring, and
   a `console.error` in `import.meta.env?.DEV` when a required accessible name
   is missing. Colour is never the only carrier of meaning.

6. **Comment the *why*, never the *what*.** `// Set the background` is noise.
   The comments worth writing explain a decision a reader would otherwise undo:
   why `loading` does not set `disabled`, why `pointerdown` instead of `click`,
   why a token sits below AA on purpose. Prose in comments, no bullet lists.

## Component skeleton

```tsx
import { forwardRef, type HTMLAttributes } from 'react'
import { cx } from '../../utils/cx'
import './Thing.css'

export type ThingVariant = 'default' | 'subtle'

export interface ThingProps extends HTMLAttributes<HTMLDivElement> {
  variant?: ThingVariant
}

export const Thing = forwardRef<HTMLDivElement, ThingProps>(function Thing(
  { variant = 'default', className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-tl="thing"
      data-variant={variant}
      className={cx('tl-thing', className)}
      {...rest}
    />
  )
})
```

```css
@layer tl.components {
  .tl-thing {
    --_bg: var(--tl-surface);
    --_fg: var(--tl-text);

    color: var(--_fg);
    background: var(--_bg);
    border-radius: var(--tl-radius-md);
  }

  .tl-thing[data-variant='subtle'] {
    --_bg: var(--tl-surface-sunken);
    --_fg: var(--tl-text-secondary);
  }
}
```

Non-negotiables in that skeleton: `forwardRef` with a **named** function (it is
what shows in React DevTools and in a component stack trace), `...rest` spread
so every native attribute passes through, `className` merged rather than
replaced, and exported prop types alongside the value so a consumer can type a
wrapper without reaching into `dist/`.

## Controlled and uncontrolled

Anything with internal state supports both, through `useControllableState`:
`value` / `defaultValue` / `onChange` — `open` / `defaultOpen` / `onOpenChange`
for disclosure. Never only-controlled; never only-uncontrolled.

## Sizes

`xs | sm | md | lg`, defaulting to `md`, and only where a size genuinely
changes. A component with one sensible size should not invent four.

## Icons

Components accept icons as `ReactNode` props, never as an icon-name string.
That keeps the framework from depending on its own icon registry and lets a
consumer pass any glyph. Wrap decorative icons in `aria-hidden="true"`.

## Motion

Read `styles/tokens.motion.css` before animating anything; its header is the
policy. In practice:

Use the paired recipes, never a hand-written duration list. Resting state carries
`--tl-transition-overlay-enter` or `--tl-transition-popover-enter`; the exiting
state carries the matching `-exit`. Both list `transform` and `opacity` — animate
`transform`, not the individual `translate`/`scale` properties, which the recipes
do not cover and which would snap.

Anything that mounts and unmounts goes through `usePresence` and renders
`data-state={status}`. From-values live in
`@starting-style { .tl-x[data-state='entering'] { … } }`; the exiting rule
restates them and adds `pointer-events: none`. The hook waits on
`getAnimations({ subtree: true })`, so a finite child animation still running
while exiting — a toast's countdown — holds the node in the DOM until it ends:
cancel it under `[data-state='exiting']`. Infinite loops are skipped by the
hook itself, but still cancel them there (as Mark, Progress and Skeleton do),
because a loop that keeps running on a surface that is fading out reads as a
thing that has not noticed it is leaving.

Movement amounts come from `--tl-lift-*`, `--tl-slide` and `--tl-zoom-*`, which
are already multiplied by the reduced-motion multipliers. Never write a literal
pixel or scale for movement, and never add a `prefers-reduced-motion` block for a
transition — the multipliers are the mechanism. A loop is the one exception: it
never reads `--tl-motion-scale` (halving a period doubles the rate), and is
either kept at its own tempo because the motion is the message, or declared only
under `(prefers-reduced-motion: no-preference)`.

No `var()` inside a `@keyframes` block. It makes the animation discrete. Put
the per-instance variation in `animation-delay` or `animation-duration` outside
the keyframes, as `Mark.css` does.

## Dark theme and forced colors

Never write a `[data-theme='dark']` block in a component file — if the dark
theme needs a different value, that is a missing semantic token. Do add a
`@media (forced-colors: active)` block whenever a component conveys state
through `background-color` alone, because that declaration is stripped in high
contrast mode and the state disappears with it.

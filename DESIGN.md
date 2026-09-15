# Account controls

This scoped contract preserves the existing AWQ account surface, as approved by the user.

## Tokens

Use the existing system-ui font, slate surface #0f172a, border #334155, text #e2e8f0 and secondary text #cbd5e1. Logout uses #fda4af. Spacing uses 4, 8, 12 and 16 px. Radius is 10 px, matching the existing bar. Focus uses a 2 px #cbd5e1 outline with 2 px offset.

## Component and placement

The account trigger is a 44 px square with a 20 px outlined user SVG, placed in the header actions after the theme button. The bottom-right corner belongs to Flight bulk actions. At mobile widths up to 480 px, header actions occupy their own full-width row. The account panel is 208 px wide, capped to the viewport minus 32 px, and opens 8 px below the trigger, aligned to its right edge and clamped 16 px inside the viewport. Scrolling or resizing dismisses the panel so it cannot detach from the trigger. It retains the existing slate surface, border and subtle shadow. Role appears above two full-width, minimum 44 px actions.

## Interaction and accessibility

Use an auto popover with native outside-click and Escape dismissal. The labelled trigger exposes expanded state. Actions retain native button keyboard behavior and visible focus. Opening and closing is immediate; no motion dependency or reduced-motion override is needed. Opening the password dialog closes the panel. Logout failure remains visible in the panel and allows retry.

## Validation and scope

Check closed/open, keyboard, outside click, Escape, password dialog, failed/successful logout, and login again at 375, 768 and 1280 px. Preserve the rest of the application. Existing global styling and performance are outside this small component change.

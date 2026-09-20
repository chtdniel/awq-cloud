# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are inferred from the product modules: aviation operations staff who monitor and prepare operational information such as flights, NOTAMs, TAF, weather warnings, FIR notices, checklists, and reports. Administrators also manage internal login accounts and access roles.

## Product Purpose

AWQ OCC is an internal aviation operations console that brings operational monitoring, preparation, and release workflows into one web application. Success means operators can find current operational information quickly and administrators can manage access safely.

## Operating Context

The product is used as an operational dashboard with live status indicators, data-entry workflows, reports, and role-gated Settings. Internal Users is an administrator-only surface for managing login accounts, profiles, roles, status, password resets, and security-sensitive audit history.

## Capabilities and Constraints

- Core areas include Flight, Data, TAF, NOTAM, Report, WX, Route, FIR, FIR NOTAM, Checklist, and Settings.
- Settings uses D1-backed internal authentication with admin, registered, and readonly roles.
- Passwords are temporary and write-only; sensitive admin actions require confirmation and are audited.
- The existing web implementation and operational behavior are the authority for narrow UI refinements.
- Do not expose or invent operational data, credentials, tokens, or user profile values in design work.

## Brand Commitments

The existing product name is AWQ OCC and the interface is an internal AirAsia aviation operations surface. Preserve the incumbent operational-console visual language for narrow refinements.

## Evidence on Hand

- Existing implementation: `src/Settings_Ui.html` and related application modules.
- Existing design contract: `DESIGN.md`.
- Settings workflow and acceptance record: `docs/SETTINGS-IMPROVEMENT-EXECUTION-PLAN.md`.
- No user research, testimonials, or external brand guidelines were provided.

## Product Principles

- Make operational information quick to scan.
- Keep authorization clear and fail closed.
- Make sensitive changes deliberate and auditable.
- Preserve trustworthy system status and recovery feedback.
- Prefer focused workflows over unnecessary configuration complexity.


# E-ink dashboards: integration plan

Status: repository and manufacturer documentation reviewed on 2026-10-26.
This is an implementation proposal, not a deployed feature or hardware test.

## Hardware and agreed behaviour

Two Seeed Studio TRMNL 7.5-inch OG DIY kits: 800 × 480 monochrome landscape
displays, XIAO ESP32-S3 Plus controllers, 2.4 GHz Wi-Fi and 2,000 mAh batteries.
Both run the same firmware with independent identity, dashboard and refresh
settings. They run on battery and recharge over USB-C. Begin at 30 minutes per
wake; retain the last image on network failure and skip unchanged images.

The kitchen display is for shared calendars, meals, shopping, chores and weather.
The desk display is for a selected person's schedule, tasks and reminders.
Desk location (home or office) remains to be confirmed before choosing ingress.

## Fit with the current application

The app already has scoped task, shopping, recipe, project and calendar
repositories. `taskWidgetSnapshot` and the task/calendar contract helpers provide
existing date, ordering and attention semantics. Reuse these rather than creating
a parallel household database or recreating task scheduling in firmware.

The current human cache endpoint returns far more than a display needs. Existing
integration credentials are designed around integration actors and capture;
they do not yet grant a carefully bounded dashboard read. Add explicit display
authorization and a narrow projection rather than handing a device a browser
session or making it impersonate a human.

## Proposed implementation

1. **Display settings.** Add device registration, revocation and rotation,
   selected dashboard owner/audience, calendar allowlist, sections and row limits,
   resolution, refresh interval, last contact and optional battery telemetry.
   Secrets are shown only during provisioning and stored as verifiers. Scope and
   calendar choices are enforced before rendering, not hidden afterwards in CSS.
2. **Read projection.** Kitchen defaults to shared home information. Desk uses
   its explicitly selected profile and calendars. Recheck authorization on every
   image/manifest request, including conditional requests. Device tokens cannot
   use the ordinary cache, media library, command or profile-switch endpoints.
3. **Renderer and preview.** Build a small deterministic server renderer with a
   resolution/palette interface. It produces one canonical monochrome raster;
   the browser preview and device download encode those same pixels. Start with
   large text, two columns and bounded overflow rather than shrinking the normal
   application UI. Keep font/assets local. Select the rendering library after a
   small font, wrapping and container-build compatibility check; the server
   currently has no image-rendering dependency.
4. **Image protocol.** Prefer a versioned manifest plus a content-addressed
   1-bit BMP for compatibility with the documented TRMNL path. Its pixel payload
   is 48,000 bytes, plus BMP headers and palette. Raw framebuffer transport can
   be added if a custom client needs it. Hash canonical pixels; changing telemetry
   or a poll timestamp must not manufacture a new image. Return bounded download
   sizes, dimensions, format and refresh settings.
5. **Device client.** First check a pinned, kit-compatible TRMNL BYOS release
   against the required offline/unchanged-image behaviour. Reuse it if suitable;
   otherwise retain the manufacturer's display driver and implement a minimal
   fetch/validate/draw/sleep client. Validate the complete new frame before
   touching the panel, persist the last successful image identity, bound Wi-Fi
   and download time, and back off after failures. Never clear the panel merely
   because a fetch failed. Update the accepted image identity only after a
   completed display refresh.

Dashboard data and layout stay inside Our Place. Using the TRMNL wire protocol
does not require installing a separate household management application or
sending household content to TRMNL's hosted service.

## Initial layouts to preview

| Kitchen | Desk |
| --- | --- |
| Today and tomorrow's selected shared events | Next appointment and selected personal calendar |
| Shared chores needing attention | Chosen priorities and tasks needing attention |
| Recipes pinned to make soon | Upcoming deadlines, targets and review dates |
| Grocery highlights and overflow count | Optional project next actions |
| Small weather and battery strip | Small date and battery strip |

These are starting layouts, not a claim that meal planning or weather ingestion
already exists. Recipes pinned to make soon can supply the initial meals section.
Weather needs a separately chosen provider, location setting, cache and failure
policy; household content is never needed by that provider.

## Network and power decisions

The existing household endpoint is reachable through Tailscale. Do not assume an
ESP32 can use that route directly. For home devices, propose a separately scoped
LAN display listener/proxy serving only display endpoints, with authenticated
requests and verified TLS. Keep the general app listener protected. Office use
requires a different connectivity design; resolve this before opening listeners
or changing firewall rules. Hostnames, addresses, Wi-Fi secrets and device tokens
belong in ignored local provisioning files.

Use full refresh first; test partial refresh only after confirming the actual
panel and driver combination. Keep an image-content timestamp stable until the
image changes; show successful contact and stale status in app settings. A
sleeping/offline display cannot learn that data changed or that a credential was
revoked until it reconnects. Do not promise remote erasure of a retained image.
Measure real current draw and Wi-Fi/refresh duration before estimating battery
life. Do not use battery estimates from the different TRMNL ESP32-C3 hardware.

## Manufacturer references and initial driver facts

- [Kit product page](https://www.seeedstudio.com/TRMNL-7-5-Inch-OG-DIY-Kit-p-6481.html).
- [Kit Arduino guide](https://wiki.seeedstudio.com/ogdiy_kit_works_with_arduino/):
  current example selects Seeed_GFX combo 502 (UC8179), with the EE04 board flag.
- [Kit ESPHome guide](https://wiki.seeedstudio.com/ogdiy_kit_works_with_esphome/):
  its example uses SPI clock GPIO7, MOSI GPIO9, CS GPIO44, DC GPIO10,
  reset GPIO38 and inverted busy GPIO4. Battery ADC is GPIO1, gated by GPIO6.
  Reconcile these examples with the delivered board revision before flashing.
- [TRMNL firmware](https://github.com/usetrmnl/trmnl-firmware) provides a
  `TRMNL_7inch5_OG_DIY_Kit` build. Its device model is `xiao_epaper_display`,
  so do not blindly apply every `og` example or binary to this board.
- [BYOS protocol](https://docs.trmnl.com/go/diy/byos) documents setup, display,
  logging, battery headers, image formats and stable filenames. Verify actual
  release behaviour, particularly error screens and unchanged-frame handling.

## Delivery and verification

Build renderer fixtures and exact browser previews first, then registration and
read-only endpoints, then flash one device and measure it before provisioning
the second. Test scope/calendar isolation, cross-device access, revocation,
unchanged frames, corrupt/truncated downloads, offline retention and retry
bounds. Use synthetic data and isolated databases. Any live schema upgrade must
follow the backup-verified upgrade procedure in AGENTS.md; no live data resets.

No firmware has been flashed, live credentials issued, network listeners opened
or household schema changed as part of this review.

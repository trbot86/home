# Trusted-network profiles

Accepted 2026-09-26 at the user's request. This supersedes password entry for the current VPN-only household trial and the loopback demo.

The VPN supplies the access boundary. On first use, choose a household profile; this device remembers it. A profile dropdown switches between the two people. The app still creates a session internally so edits, history, undo, cached records and queued captures retain their owner and device identity. Each profile keeps its existing client ID when revisited. Switching requires server access; existing offline capture remains available for the remembered profile.

Private items are filtered from the other profile. They are not protected against someone with network access deliberately selecting their owner's profile. Administrator actions likewise follow the selected profile. This is a convenience/privacy-by-selection model, not independent identity verification. The user was informed of this tradeoff before implementation.

Enable with `AUTHENTICATION_MODE=trusted-network`; it is explicit in the private trial Compose file. The general server default remains `password`, which does not publish the profile directory or accept password-free selection. Both modes retain origin checks, session revocation, client/person binding, and restore-epoch rules. Existing password verifiers are preserved, so enabling the profile picker requires no data migration.

The visual default is the original mockup's dark sage palette, regardless of the device's light/dark setting. Web and installer share CSS tokens; Android native resources mirror them. A future appearance preference must preserve dark as the user's selected default.

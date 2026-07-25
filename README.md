# Kasa Studio

A local web console for running TP-Link Kasa smart bulbs as studio lighting: auto-discovery, per-light and group control (power, intensity, color temperature, hue/saturation), typed-in precise intensities, labeling, identify-blink, and a full set of Aputure/amaran-style FX effects. Mobile-friendly with large touch targets, so it works from a phone on the same network.

Everything runs locally — the browser UI talks to a small Node server on your machine, and that server talks directly to the bulbs over your LAN (TP-Link's local protocol, port 9999/UDP+TCP). No cloud account, no internet dependency.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:4173`. The startup log also prints a LAN address (e.g. `http://192.168.0.2:4173`) — open that from a phone or tablet on the same Wi-Fi network to control the lights from anywhere in the studio.

Bulbs are discovered automatically via UDP broadcast and should appear within a few seconds. If nothing shows up:
- Confirm this machine and the bulbs are on the same subnet/VLAN (discovery relies on broadcast, which doesn't cross subnets or most guest-network isolation).
- Check that a firewall isn't blocking UDP port 9999.
- Click "Rescan Network" to force an immediate re-broadcast.

## What it does

- **Discovery** — continuous background scan (via `tplink-smarthome-api`), no manual IP entry needed.
- **Per-light control** — power, brightness/intensity (slider + type-in numeric %, plus quick preset buttons for common stops), color temperature (for tunable-white bulbs), hue/saturation (for color bulbs, with a White/Color tab when a bulb supports both).
- **Groups** — create named groups (Key, Fill, Rim, Background, whatever fits your set), assign lights via the pill buttons on each card, and drive a whole group's power/intensity/temperature from one master control bar. "All Lights" is a standing virtual group.
- **Identify** — the ◎ button blinks a bulb a few times, then restores its exact prior state, so you can find which physical fixture a card corresponds to.
- **Labels** — click any light's name to rename it (e.g. "Softbox Camera Left").
- **Effects** — Kasa bulbs don't expose their scene presets over the local protocol, so these are driven directly by the server sending timed commands, modeled after the FX library on Aputure/amaran lights (Sidus Link). Each has 1-3 tunable parameters. Starting an effect snapshots the light's prior state and restores it on stop; any manual control action (power/brightness/color/temp) automatically stops a running effect on that light.
  - **Classic FX** (any dimmable/tunable bulb): Strobe, Pulsing, Candle, Fire, Paparazzi, Fireworks, Faulty Bulb, Lightning, TV, Explosion, Welding.
  - **Color FX** (needs a color bulb): Colors Chase, Cop Car, Party Lights, Club Lights.

## Notes / limits

- Only tested against Kasa **bulbs** (KL-series); Kasa **plugs** are also discovered and get basic power/dimmer/identify support, but no color controls.
- Effects are software-timed over the network, not firmware presets — expect Strobe to look more like a fast attention-flash than a precise photographic strobe; Wi-Fi round-trip and bulb processing time limit how fast state changes can land.
- Labels and group membership are stored locally in `data/store.json`.

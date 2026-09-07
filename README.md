# Light Calibration

Two bulbs of the same model, sent the same settings, do not produce the same
light. Cheap fixtures are worse: one runs green, another runs magenta, a third
is a third dimmer than the rest at the same percentage. Adaptive Lighting or a
scene will happily send them identical commands, and the room still looks wrong.

This integration fixes that by **calibrating a light against one you trust**,
using nothing but your eyes. No colorimeter, no extra hardware, no external
software.

It creates a **virtual light entity that takes over the original's entity ID**,
so everything already pointing at that light — scenes, Adaptive Lighting,
automations, dashboards, voice — keeps working unchanged and starts getting
corrected output.

## How calibration works

Pick a reference light: one you consider correct. Then run the guided
calibration from the integration's settings page.

At each step the integration drives the reference to a chosen setting and the
target as close as it can compute, and shows you sliders. You adjust until the
two match by eye, then move on. Sliders are live — the light follows as you
drag, with no submit button.

**White steps** give you three controls: warm/cool (a Kelvin offset),
green/magenta (a tint), and brightness. **Colour steps** give you hue shift,
saturation, and brightness.

| Depth | Points | Roughly |
|---|---|---|
| Colours only | 6 hues | 5 min |
| Quick | 5 whites | 3 min |
| Standard | 9 whites | 8 min |
| Standard + colours | 9 whites, 6 hues | 13 min |
| Thorough | 15 whites | 15 min |
| Thorough + colours | 15 whites, 6 hues | 20 min |

When you finish, the reference light is put back exactly as it was.

## What it does with the measurements

Corrections are interpolated, not looked up, so any request lands somewhere
sensible:

- **Whites** interpolate over the (Kelvin, brightness) plane by inverse-distance
  weighting, with both axes normalised so neither dominates.
- **Colours** interpolate between the two measured hues either side, the short
  way around the wheel — so red blends magenta and yellow rather than being
  dragged by green on the far side.

An incoming request is routed by **how far it sits from the blackbody curve**. A
near-white RGB value is treated as a colour temperature and corrected along the
curve. A saturated colour is corrected from the hue points. This distinction
matters: projecting saturated colours onto the blackbody curve collapses them —
pure red and pure green both land on the low end and come out as the same
orange.

If a light has never had colour points measured, saturated colours pass through
with their hue untouched and only brightness is corrected.

## Entities

Per calibrated light:

- `light.<original_id>` — the virtual light. It claims the original entity ID;
  the real light is renamed aside and driven behind the scenes.
- `switch.<name>_calibration` — turn the correction off to A/B it against raw
  output. Flipping it re-applies immediately, so you can see the difference on
  a live light.
- `sensor.<name>_calibration` — status, e.g. "Calibrated (9 whites, 6 colours)".

Removing a config entry gives the original light its entity ID back.

## Re-running

Running calibration again **fine-tunes rather than resets**. Each step is seeded
with the stored value, so you are adjusting from where you left off. "Finish
now" saves what you have measured this pass and merges it into the stored
profile — anything you did not revisit is kept. So a Quick pass can touch up
five whites without disturbing a Thorough profile.

## Installing

HACS → ⋮ → Custom repositories → this repo URL, category **Integration**.
Download, restart Home Assistant, then **Settings → Devices & Services → Add
integration → Light Calibration**.

Adding a light opens the calibration dialog straight away. You can reopen it any
time from the entry's **Configure** button — the panel is scoped to the entry
you clicked.

The frontend module is served by the integration itself and registered
automatically. There is no Lovelace resource to add and no card to place on a
dashboard.

## Services

All take an `entry_id`.

| Service | |
|---|---|
| `start_calibration` | Begin a session, optional `depth` |
| `adjust` | Set live values for the current point |
| `save_point` | Record and advance |
| `previous_point` | Step back |
| `finish_calibration` | Save what has been measured and stop |
| `cancel_calibration` | Abandon; the stored profile is untouched |
| `set_reference` | Change the reference light |
| `clear_profile` | Discard the profile, leaving the light uncorrected |

## Notes

- The correction is applied to what the light is *sent*. It cannot make a
  fixture exceed its own limits — asking for 1800 K from a bulb whose floor is
  2000 K still gives 2000 K.
- Calibration is only as good as the reference. It matches lights to each
  other, not to a colorimetric standard.
- The frontend URL contains a hash of the file's contents. Home Assistant is
  often behind a CDN that caches `.js` for hours, and a stale module shows up as
  a blank panel. A content-addressed URL cannot go stale.

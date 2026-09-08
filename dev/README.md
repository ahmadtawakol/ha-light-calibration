# Frontend harness

`light-calibration-card.js` only renders inside Home Assistant, which makes the
dialog awkward to look at: every change means a deploy, a restart, and a real
pair of lights doing whatever the sliders say. This renders the module against a
mock `hass` in an ordinary browser instead.

```bash
python3 -m http.server 8777 --directory "$(git rev-parse --show-toplevel)"
```

Then open <http://localhost:8777/dev/harness.html>.

It loads `../custom_components/light_calibration/www/light-calibration-card.js`
directly — **never a copy**. Edit the component, reload the page, see the change.
A copy would go stale the first time somebody forgot to sync it, which is the
same class of bug the content-addressed frontend URL exists to prevent.

For the same reason both the component and `harness.js` are imported with a
cache-busting query. In Home Assistant the module URL carries a hash of the file
and cannot go stale; here there is no hash, and without busting it you edit the
component, reload, and spend a while studying the old interface. They are
awaited in order from a single module, because the harness constructs a
`<light-calibration-panel>` immediately and the component has to have defined it
first — two separate module scripts do not reliably give that ordering.

Note that `harness.html` itself can still be cached by the browser. If a change
to the page (rather than to the harness logic) does not show up, hard-reload.

## What it covers

The mock answers `callService`, `callWS` and `callApi`, so the measurements
table and the whole add-a-light flow work end to end — including its failure
path. Set `window.__flowError` to an error key (`same_light`,
`no_color_control`, …) to see what the form does when the config flow rejects
something.

Buttons along the bottom switch between every state the panel and dialog have:
the empty panel, a light nobody has calibrated, a calibrated one, a white step,
a colour step, a comparison flash, a tunable-white fixture (no tint slider, no
colour depths), a run with steps skipped because the reference could not reach
them, the check at the end, and the saved screen. There is a light/dark toggle,
and every service call the interface would make is logged rather than sent.

Worth doing at a phone width as well — the action row is five controls and it is
snug at 375px.

## What it cannot show you

- **The reference picker.** In Home Assistant that is `ha-entity-picker`, pulled
  in via `loadCardHelpers()`. That does not exist here, so the module falls back
  to a plain `<select>`, which is left empty. The fallback path is real code and
  worth seeing; the picker itself is not testable here.
- **Anything about actual colour.** The swatch is sRGB on a monitor. Whether a
  correction looks right is a question about a room, and only a deploy answers it.
- **Real state timing.** `hass` updates here are instant and hand-driven. In
  Home Assistant they arrive over a websocket while a slider is mid-drag, which
  is its own source of bugs.

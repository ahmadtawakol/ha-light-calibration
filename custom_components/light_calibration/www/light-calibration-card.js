/*
 * Light Calibration frontend.
 *
 * Three elements, all sharing one dialog:
 *   light-calibration-dialog  the modal itself; sliders drive the light live
 *   light-calibration-panel   the page the integration's Configure button opens
 *   light-calibration-card    optional dashboard card
 *
 * A config-flow form can only react when you press Submit, which makes matching
 * a colour by eye miserable -- hence a real dialog with continuous sliders.
 */

/* Ordered so the first entry is the right default for a light nobody has
   calibrated yet -- it is what a fresh dialog selects. Colours-only is a top-up
   for a light that already has whites, so it sits at the bottom rather than
   being the thing a first run falls into.

   Third field: needs a fixture that can show a colour. A tunable-white one is
   only offered the white-only depths. */
const DEPTHS = [
  ["standard", "Standard - 9 whites, ~8 min", false],
  ["quick", "Quick - 5 whites, ~3 min", false],
  ["standard_color", "Standard + colours - 9 whites, 6 hues, ~13 min", true],
  ["thorough", "Thorough - 15 whites, ~15 min", false],
  ["thorough_color", "Thorough + colours - 15 whites, 12 hues, ~25 min", true],
  ["colors", "Colours only - 6 hues, ~5 min", true],
];

/* Whites and colours need different adjustments: warm/cool and tint are
   meaningless on pure red, and a hue rotation is meaningless on a white. */
const WHITE_SLIDERS = [
  { key: "warm_cool", label: "Warm / cool", min: -1200, max: 1200, step: 25, unit: "K",
    hint: "orange ↔ blue" },
  { key: "green_magenta", label: "Magenta / green", min: -60, max: 60, step: 1, unit: "%",
    hint: "looks purple? push right" },
  { key: "brightness", label: "Brightness", min: 1, max: 100, step: 1, unit: "%",
    hint: "match the reference" },
];

const COLOR_SLIDERS = [
  { key: "hue_shift", label: "Hue", min: -60, max: 60, step: 1, unit: "°",
    hint: "rotate until it is the same colour" },
  { key: "saturation", label: "Saturation", min: 0, max: 100, step: 1, unit: "%",
    hint: "how pure the colour reads" },
  { key: "brightness", label: "Brightness", min: 1, max: 100, step: 1, unit: "%",
    hint: "match the reference" },
];

const ALL_SLIDERS = [...WHITE_SLIDERS, ...COLOR_SLIDERS.filter(
  (c) => !WHITE_SLIDERS.some((w) => w.key === c.key)
)];

const BUTTONS = `
  button.primary {
    background: var(--primary-color); color: var(--text-primary-color, #fff);
    border: none; border-radius: 8px; padding: 9px 16px; font-size: 0.95rem;
    cursor: pointer; font-family: inherit;
  }
  button.flat {
    background: none; border: none; color: var(--primary-color);
    padding: 9px 12px; font-size: 0.95rem; cursor: pointer; border-radius: 8px;
    font-family: inherit;
  }
  button.flat:hover:not(:disabled) { background: rgba(127,127,127,0.12); }
  /* Used constantly mid-step, so it needs to read as a control rather than as
     one more link in a row of links. */
  button.tonal {
    background: rgba(127,127,127,0.14); border: none; color: var(--primary-text-color);
    padding: 9px 14px; font-size: 0.95rem; cursor: pointer; border-radius: 8px;
    font-family: inherit;
  }
  button.tonal:hover:not(:disabled) { background: rgba(127,127,127,0.22); }
  button.quiet { color: var(--secondary-text-color); }
  button:disabled { opacity: 0.4; cursor: default; }
`;

const DIALOG_STYLE = `
  ${BUTTONS}
  :host { display: contents; }
  .scrim {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: none; align-items: center; justify-content: center; z-index: 9999;
  }
  .scrim.open { display: flex; }
  .dialog {
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
    border-radius: var(--ha-card-border-radius, 12px);
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100vh - 64px); overflow: auto;
    box-shadow: 0 8px 32px rgba(0,0,0,0.35);
    padding: 24px;
    font-family: var(--paper-font-body1_-_font-family, inherit);
  }
  .titlebar { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; }
  .dialog h2 { margin: 0; font-size: 1.35rem; font-weight: 400; flex: 1; }
  .sub { color: var(--secondary-text-color); font-size: 0.9rem; margin-bottom: 20px; }
  /* What the fixture is being driven with. Sat inline before the instructions it
     read as a bullet point; out here it reads as a sample. */
  .swatch {
    flex: 0 0 auto; width: 34px; height: 34px; border-radius: 8px;
    border: 1px solid rgba(127,127,127,0.35); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25);
  }
  .swatch[hidden] { display: none; }
  .field { margin: 18px 0; }
  .field[hidden] { display: none; }
  .field-head {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 0.9rem; margin-bottom: 2px;
  }
  .field-head .lbl { font-weight: 500; }
  .field-head .val { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .hint { color: var(--secondary-text-color); font-size: 0.78rem; margin-top: 2px; }
  input[type=range] { width: 100%; margin: 6px 0 0; accent-color: var(--primary-color); }
  select {
    width: 100%; padding: 10px; border-radius: 8px; font-size: 0.95rem;
    background: var(--secondary-background-color, #f0f0f0);
    color: var(--primary-text-color);
    border: 1px solid var(--divider-color, #ccc); font-family: inherit;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px;
             flex-wrap: wrap; align-items: center; }
  .actions .left { margin-right: auto; }
  /* Five controls in one row is snug on a phone; tighten before wrapping. */
  @media (max-width: 430px) {
    .actions { gap: 2px; }
    .actions button { padding: 9px 7px; font-size: 0.88rem; }
    .dialog { padding: 20px 16px; }
  }
  .progress {
    height: 4px; border-radius: 2px; background: var(--divider-color, #ddd);
    overflow: hidden; margin-bottom: 20px;
  }
  .progress > div { height: 100%; background: var(--primary-color); transition: width .2s; }
  .warn {
    margin: 0 0 16px; font-size: 0.85rem; color: var(--secondary-text-color);
    border-left: 3px solid var(--warning-color, #ffa726); padding-left: 12px;
  }
  .warn[hidden] { display: none; }
  button.compare[aria-pressed="true"] { opacity: 0.5; }
`;

/* ------------------------------------------------------------------ dialog */

class LightCalibrationDialog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._dragging = null;
    this._pending = null;
    this._lastSend = 0;
    this._local = {};
    this._build();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  get _attrs() {
    const st = this._hass && this.entityId ? this._hass.states[this.entityId] : null;
    return st ? st.attributes : {};
  }

  /* Entity ids are for automations, not for people. The displaced fixture keeps
     its name through the rename, so this reads back the same thing the user
     called the light before it was calibrated. */
  _name(entityId) {
    if (!entityId) return "";
    const st = this._hass && this._hass.states[entityId];
    if (st && st.attributes.friendly_name) return st.attributes.friendly_name;
    return entityId.replace(/^[^.]+\./, "").replace(/_raw$/, "").replace(/_/g, " ");
  }

  get _sliders() {
    const a = this._attrs;
    if (a.step_type === "color") return COLOR_SLIDERS;
    // Tint is a green/magenta shift off the blackbody curve, which a
    // tunable-white fixture cannot render at all.
    return a.supports_color === false
      ? WHITE_SLIDERS.filter((s) => s.key !== "green_magenta")
      : WHITE_SLIDERS;
  }

  open(entityId) {
    this.entityId = entityId;
    this._done = false;
    this._wasActive = false;
    this.shadowRoot.querySelector(".scrim").classList.add("open");
    this._render();
  }

  close() {
    this.shadowRoot.querySelector(".scrim").classList.remove("open");
  }

  /* Every way out of the dialog has to go through here. An active session has
     both lights parked on the current step, and only cancel_calibration puts
     them back -- closing the dialog on its own would leave the reference stuck
     at whatever colour temperature it was last driven to. */
  _dismiss() {
    if (this._attrs.active) this._call("cancel_calibration");
    this.close();
  }

  connectedCallback() {
    window.addEventListener("keydown", this._onKey);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this._onKey);
  }

  _build() {
    const style = document.createElement("style");
    style.textContent = DIALOG_STYLE;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="progress"><div id="bar" style="width:0%"></div></div>
        <div class="titlebar">
          <h2 id="title"></h2>
          <div class="swatch" id="swatch" title="What the light is being sent" hidden></div>
        </div>
        <div class="sub" id="sub"></div>
        <div class="warn" id="skipped" hidden></div>
        <div id="setup">
          <div class="field">
            <div class="field-head"><span class="lbl">How thorough</span></div>
            <select id="depth">
              ${DEPTHS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
            </select>
            <div class="hint">Each step is one colour and brightness to match.</div>
          </div>
        </div>
        <div id="sliders">
          ${ALL_SLIDERS.map(
            (s) => `
            <div class="field" id="field-${s.key}">
              <div class="field-head">
                <span class="lbl">${s.label}</span>
                <span class="val" id="val-${s.key}"></span>
              </div>
              <input type="range" id="in-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">
              <div class="hint">${s.hint}</div>
            </div>`
          ).join("")}
        </div>
        <div class="actions">
          <button class="flat quiet left" id="cancel">Cancel</button>
          <button class="flat quiet" id="finish">Finish now</button>
          <button class="flat" id="back">Back</button>
          <button class="tonal compare" id="compare" title="Flash the light back to no correction, then return">Compare</button>
          <button class="primary" id="next">Start calibration</button>
        </div>
      </div>`;
    this.shadowRoot.append(style, scrim);

    const q = (sel) => scrim.querySelector(sel);
    this._els = {
      scrim, title: q("#title"), sub: q("#sub"), bar: q("#bar"),
      setup: q("#setup"), sliders: q("#sliders"), depth: q("#depth"),
      cancel: q("#cancel"), back: q("#back"), next: q("#next"),
      finish: q("#finish"), compare: q("#compare"), skipped: q("#skipped"),
      swatch: q("#swatch"),
    };

    this._els.cancel.addEventListener("click", () => this._dismiss());
    this._els.back.addEventListener("click", () => this._call("previous_point"));
    this._els.compare.addEventListener("click", () => this._call("compare"));
    this._els.finish.addEventListener("click", () => this._call("finish_calibration"));
    this._els.next.addEventListener("click", () => {
      if (this._done) { this.close(); return; }
      if (this._attrs.active) this._call("save_point");
      else this._call("start_calibration", { depth: this._els.depth.value });
    });
    scrim.addEventListener("click", (e) => {
      if (e.target === scrim) this._dismiss();
    });
    // Added and removed in connected/disconnectedCallback, not here, so it does
    // not outlive the element.
    this._onKey = (e) => {
      if (e.key === "Escape" && scrim.classList.contains("open")) this._dismiss();
    };

    for (const s of ALL_SLIDERS) {
      const input = q(`#in-${s.key}`);
      input.addEventListener("input", () => {
        this._dragging = s.key;
        this._local[s.key] = Number(input.value);
        this._paint();
        this._send();
      });
      const done = () => { this._dragging = null; this._send(true); };
      input.addEventListener("change", done);
      input.addEventListener("pointerup", done);
    }
  }

  _render() {
    if (!this._hass || !this.entityId) return;
    const a = this._attrs;
    const active = !!a.active;
    const open = this._els.scrim.classList.contains("open");

    // Finishing the last step ends the session. Without this the dialog would
    // fall back to its idle state and invite you to calibrate all over again.
    if (open && this._wasActive && !active) this._done = true;
    this._wasActive = active;

    if (this._done) {
      // Everything that belongs to a running session has to be put away here,
      // or the saved screen keeps whichever bits were showing when it ended.
      this._els.setup.style.display = "none";
      this._els.sliders.style.display = "none";
      this._els.back.style.display = "none";
      this._els.cancel.style.display = "none";
      this._els.finish.style.display = "none";
      this._els.compare.style.display = "none";
      this._els.swatch.hidden = true;
      this._els.skipped.hidden = true;
      this._els.next.textContent = "Done";
      this._els.bar.style.width = "100%";
      this._els.title.textContent = `${this._name(a.calibrating)} is calibrated`;
      const whites = (a.stored_points || 0) - (a.stored_colors || 0);
      const colours = a.stored_colors ? ` and ${a.stored_colors} colours` : "";
      this._els.sub.innerHTML =
        `Stored ${whites} whites${colours}. Anything you did not revisit this ` +
        `time was kept, and both lights have been put back the way they were.` +
        `<br><br>Everything already pointing at this light is now getting ` +
        `corrected output. Turn the <b>Calibration</b> switch off to see what it ` +
        `looked like before.`;
      return;
    }

    // Only offer depths the fixture can actually be measured at.
    const allowColor = a.supports_color !== false;
    if (this._allowColor !== allowColor) {
      this._allowColor = allowColor;
      this._els.depth.innerHTML = DEPTHS.filter(([, , needsColor]) => allowColor || !needsColor)
        .map(([v, l]) => `<option value="${v}">${l}</option>`)
        .join("");
    }

    // The lights are parked on a step whenever a session is running, so the
    // compare flash is meaningful right through the check as well.
    const verifying = !!a.verifying;
    this._els.compare.style.display = active ? "" : "none";
    this._els.compare.setAttribute("aria-pressed", a.comparing ? "true" : "false");
    this._els.compare.disabled = !!a.comparing;

    const skipped = a.skipped || [];
    this._els.skipped.hidden = skipped.length === 0;
    if (skipped.length) {
      this._els.skipped.textContent =
        `Skipped ${skipped.join("; ")}. Those points are left as they were.`;
    }

    this._els.cancel.style.display = "";
    this._els.setup.style.display = active ? "none" : "block";
    // Nothing to adjust while checking: this is the finished profile, replayed.
    this._els.sliders.style.display = active && !verifying ? "block" : "none";
    this._els.back.style.display = active ? "" : "none";
    this._els.next.textContent = verifying
      ? "Looks right"
      : active ? "Save point and next" : "Start calibration";
    this._els.back.textContent = verifying ? "Fix that one" : "Back";
    this._els.back.disabled = !active || (!verifying && (a.step || 1) <= 1);
    this._els.finish.textContent = verifying ? "Save now" : "Finish now";
    // Only offer an early finish once something has actually been measured.
    this._els.finish.style.display =
      active && (verifying || (a.measured_this_run || 0) > 0) ? "" : "none";

    // Swap the slider set for colour steps. The fields are built once in a
    // fixed order, so they have to be re-sorted as well as shown and hidden --
    // otherwise a colour step leads with Brightness, which is the last thing you
    // should reach for and the opposite of what the instructions say.
    const shown = this._sliders;
    for (const s of ALL_SLIDERS) {
      this.shadowRoot.querySelector(`#field-${s.key}`).hidden =
        !shown.some((x) => x.key === s.key);
    }
    // Only when the set actually changes: appendChild moves live DOM nodes, and
    // moving a range input mid-drag drops the pointer capture, so re-sorting on
    // every state update would make the sliders impossible to drag.
    const order = shown.map((x) => x.key).join(",");
    if (this._sliderOrder !== order) {
      this._sliderOrder = order;
      for (const x of shown) {
        this._els.sliders.appendChild(this.shadowRoot.querySelector(`#field-${x.key}`));
      }
    }

    this._els.swatch.hidden = !(active && a.sending_rgb);
    if (active && a.sending_rgb) {
      this._els.swatch.style.background = `rgb(${a.sending_rgb.join(",")})`;
    }

    if (verifying) {
      this._els.title.textContent =
        `Check ${a.verify_step} of ${a.verify_total} - ${a.step_title || ""}`;
      this._els.sub.textContent = a.instructions || "";
      this._els.bar.style.width = "100%";
    } else if (active) {
      this._els.title.textContent = `Step ${a.step} of ${a.total} - ${a.step_title || ""}`;
      this._els.sub.textContent = a.instructions || "";
      this._els.bar.style.width = `${((a.step - 1) / a.total) * 100}%`;
    } else {
      const stored = (a.stored_points || 0) > 0;
      const light = this._name(a.calibrating);
      this._els.title.textContent = stored ? `Fine-tune ${light}` : `Calibrate ${light}`;
      this._els.sub.innerHTML = stored
        ? `Each step starts from what you measured last time, so this adjusts ` +
          `from where you left off rather than starting over. Anything you do ` +
          `not revisit is kept.<br><br>Both lights will change while you work -- ` +
          `pause anything that adapts them automatically first, or it will fight you.`
        : `Both lights will be driven to the same setting, one step at a time. ` +
          `Adjust until they look the same to you, then move on -- there is no ` +
          `right answer but your own eyes.<br><br>Matching against ` +
          `<b>${this._name(a.reference_light) || "the reference"}</b>. Pause ` +
          `anything that adapts these lights automatically first, or it will ` +
          `fight you.`;
      this._els.bar.style.width = "0%";
    }

    if (this._dragging === null) {
      for (const s of ALL_SLIDERS) {
        const v = a[s.key];
        if (v === undefined || v === null) continue;
        this._local[s.key] = Number(v);
        this.shadowRoot.querySelector(`#in-${s.key}`).value = v;
      }
      this._paint();
    }
  }

  _paint() {
    for (const s of ALL_SLIDERS) {
      const v = this._local[s.key];
      if (v === undefined) continue;
      const signed = s.key === "warm_cool" || s.key === "green_magenta" || s.key === "hue_shift";
      const sign = signed && v > 0 ? "+" : "";
      this.shadowRoot.querySelector(`#val-${s.key}`).textContent = `${sign}${v}${s.unit}`;
    }
  }

  _call(service, data = {}) {
    const entry_id = this._attrs.entry_id;
    if (!entry_id) return Promise.resolve();
    return this._hass.callService("light_calibration", service, { entry_id, ...data });
  }

  /* Throttled: a drag sends a steady stream rather than a flood. Zigbee bulbs
     choke well before a browser does. */
  _send(force = false) {
    const now = Date.now();
    const wait = 130;
    clearTimeout(this._pending);
    if (force || now - this._lastSend >= wait) {
      this._lastSend = now;
      const data = {};
      for (const s of this._sliders) data[s.key] = this._local[s.key];
      this._call("adjust", data);
    } else {
      this._pending = setTimeout(() => this._send(true), wait - (now - this._lastSend));
    }
  }
}

/* ------------------------------------------------------- shared discovery */

function calibrationSensors(hass) {
  return Object.keys(hass.states)
    .filter((e) => e.startsWith("sensor.") && hass.states[e].attributes.entry_id
                   && hass.states[e].attributes.calibrating)
    .sort();
}

/* ------------------------------------------------------------------- panel */

const HUE_NAMES = { 0: "red", 60: "yellow", 120: "green",
                    180: "cyan", 240: "blue", 300: "magenta" };

const signed = (n) => (n > 0 ? "+" : n < 0 ? "\u2212" : "") + Math.abs(Math.round(n));

/* What a profile actually measured. The stored numbers are corrections, not
   settings -- "asked for 2700K, this fixture needed -250K and a push towards
   green" -- so the table says which is which rather than listing raw fields. */
function renderPoints(points) {
  const whites = points.filter((p) => (p.type || "white") === "white")
    .sort((a, b) => a.brightness - b.brightness || a.kelvin - b.kelvin);
  const colours = points.filter((p) => p.type === "color")
    .sort((a, b) => a.brightness - b.brightness || a.hue - b.hue);
  let html = "";
  if (whites.length) {
    html += `<table><thead><tr><th>Asked for</th><th>Colour</th><th>Tint</th>
      <th>Brightness</th></tr></thead><tbody>` +
      whites.map((p) => `<tr>
        <td>${p.kelvin}K at ${p.brightness}%</td>
        <td>${signed(p.kelvin_offset || 0)}K</td>
        <td>${signed(p.tint || 0)}%</td>
        <td>${Math.round(p.brightness_actual ?? p.brightness)}%</td></tr>`).join("") +
      `</tbody></table>`;
  }
  if (colours.length) {
    html += `<table><thead><tr><th>Asked for</th><th>Hue</th><th>Saturation</th>
      <th>Brightness</th></tr></thead><tbody>` +
      colours.map((p) => `<tr>
        <td>${HUE_NAMES[p.hue] || p.hue + "\u00b0"} at ${p.brightness}%</td>
        <td>${signed(p.hue_shift || 0)}\u00b0</td>
        <td>${Math.round(p.saturation ?? 100)}%</td>
        <td>${Math.round(p.brightness_actual ?? p.brightness)}%</td></tr>`).join("") +
      `</tbody></table>`;
  }
  return html || "<p>Nothing measured yet.</p>";
}

const PANEL_STYLE = `
  ${BUTTONS}
  :host { display: block; background: var(--primary-background-color); min-height: 100vh; }
  .head {
    background: var(--app-header-background-color, var(--primary-color));
    color: var(--app-header-text-color, #fff);
    padding: 0 8px; height: 56px; font-size: 1.25rem; font-weight: 400;
    display: flex; align-items: center; gap: 8px;
    position: sticky; top: 0; z-index: 2;
  }
  .head .back {
    background: none; border: none; cursor: pointer; color: inherit;
    width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
    flex: 0 0 auto;
  }
  .head .back:hover { background: rgba(255,255,255,0.12); }
  .head .back svg { width: 24px; height: 24px; fill: currentColor; }
  .body { padding: 24px; max-width: 1040px; margin: 0 auto; }
  .grid {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  }
  .item {
    background: var(--card-background-color, #fff);
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.12));
    padding: 16px; color: var(--primary-text-color);
    display: flex; flex-direction: column;
  }
  .item .top { display: flex; align-items: flex-start; gap: 9px; }
  /* Whether a light is corrected right now, before reading a word of it. */
  .dot {
    flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; margin-top: 6px;
    background: var(--divider-color, #ccc);
    box-shadow: 0 0 0 3px transparent;
  }
  .dot.on     { background: var(--success-color, #43a047); }
  .dot.off    { background: var(--warning-color, #ffa726); }
  .dot.busy   { background: var(--primary-color); }
  .item h3 {
    margin: 0; font-size: 1rem; font-weight: 500; line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .meta { color: var(--secondary-text-color); font-size: 0.85rem; margin-top: 2px; }
  .meta .flag { color: var(--warning-color, #ffa726); }
  /* Pushed to the bottom so the actions line up across the row however much
     status text a card happens to carry. */
  .item .row { display: flex; gap: 4px; align-items: center;
               margin-top: auto; padding-top: 14px; }
  .item .row .spacer { flex: 1; }
  .item .row button { padding: 7px 11px; font-size: 0.88rem; }
  .copy { margin-top: 12px; }
  .copy[hidden] { display: none; }
  label.tiny { display: block; font-size: 0.78rem; margin-bottom: 3px;
               color: var(--secondary-text-color); }
  ha-entity-picker { display: block; width: 100%; }
  select {
    width: 100%; padding: 8px; border-radius: 8px; font-size: 0.88rem;
    background: var(--secondary-background-color, #f0f0f0);
    color: var(--primary-text-color);
    border: 1px solid var(--divider-color, #ccc); font-family: inherit;
  }
  .empty { color: var(--secondary-text-color); line-height: 1.5; }
  .empty h3 { font-size: 1.1rem; margin: 0 0 6px; }
  /* details modal */
  .section { margin: 18px 0; }
  .section > label.tiny { margin-bottom: 5px; }
  .state-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 0;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .state-row .grow { flex: 1; }
  /* button.flat sets a colour, so this has to out-specify it. */
  button.flat.danger { color: var(--error-color, #db4437); }
  .measurements { margin-top: 14px; font-size: 0.85rem; overflow-x: auto; }
  .measurements[hidden] { display: none; }
  .measurements table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  .measurements th, .measurements td {
    text-align: left; padding: 5px 10px 5px 0; white-space: nowrap;
    border-bottom: 1px solid var(--divider-color, #e0e0e0);
  }
  .measurements th { color: var(--secondary-text-color); font-weight: 500; }
  .measurements td { font-variant-numeric: tabular-nums; }
  .scrim {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: none; align-items: center; justify-content: center; z-index: 9998;
  }
  .scrim.open { display: flex; }
  .scrim .dialog {
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border-radius: var(--ha-card-border-radius, 12px); padding: 24px;
    width: min(520px, calc(100vw - 32px)); max-height: calc(100vh - 64px);
    overflow: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.35);
  }
  .scrim h2 { margin: 0 0 4px; font-size: 1.35rem; font-weight: 400; }
  .scrim h2.ask { margin: 0 0 20px; }
  .scrim .field { margin: 16px 0 4px; }
  /* Wordless progress: the question is the only text on the step, and a
     "1 of 2" would be more prose to read past. */
  .scrim .dots { display: flex; gap: 6px; margin-bottom: 16px; }
  .scrim .dots span {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--divider-color, #ddd);
  }
  .scrim .dots span.on { background: var(--primary-color); }
  .scrim .err {
    color: var(--error-color, #db4437); font-size: 0.88rem; margin-top: 12px;
    border-left: 3px solid currentColor; padding-left: 12px;
  }
  .scrim .err[hidden] { display: none; }
  .scrim .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  .scrim .actions .left { margin-right: auto; }
  .add { display: flex; justify-content: center; margin: 4px 0 24px; }
  .add button { font-size: 0.95rem; }
  .add a {
    color: var(--primary-color); text-decoration: none; font-size: 0.95rem;
    padding: 9px 16px; border-radius: 8px;
  }
  .add a:hover { background: rgba(127,127,127,0.12); }
  .note {
    margin-top: 8px; font-size: 0.85rem; color: var(--secondary-text-color);
    border-left: 3px solid var(--warning-color, #ffa726); padding-left: 12px;
  }
`;

/* Home Assistant does not load ha-entity-picker on every page. The reliable way
   to pull it in from a custom element is to ask the card helpers for an entities
   card editor, which imports it as a side effect. */
async function loadEntityPicker() {
  if (customElements.get("ha-entity-picker")) return true;
  try {
    const helpers = await window.loadCardHelpers();
    const card = await helpers.createCardElement({ type: "entities", entities: [] });
    await card.constructor.getConfigElement();
    await customElements.whenDefined("ha-entity-picker");
    return true;
  } catch (err) {
    console.warn("light-calibration: ha-entity-picker unavailable, using a plain select", err);
    return false;
  }
}

class LightCalibrationPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._items = new Map();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._render();
    if (this._dialog) this._dialog.hass = hass;
  }

  set narrow(v) { this._narrow = v; }
  set route(v) {
    this._route = v;
    if (this._built && this._hass) this._render();
  }
  set panel(v) { this._panel = v; }

  /* Clicking Configure on one entry sends us here with ?config_entry=<id>.
     Scope the page to that light rather than listing every calibrated light. */
  _scopedEntryId() {
    try {
      const search = window.location.search || "";
      const id = new URLSearchParams(search).get("config_entry");
      return id || null;
    } catch (err) {
      return null;
    }
  }

  _build() {
    const style = document.createElement("style");
    style.textContent = PANEL_STYLE;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="head">
        <button class="back" title="Back" aria-label="Back">
          <svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z"/></svg>
        </button>
        <span>Light Calibration</span>
      </div>
      <div class="body" id="body"></div>`;
    const adder = document.createElement("div");
    adder.className = "scrim add-scrim";
    adder.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dots"><span></span><span></span></div>
        <h2 class="ask"></h2>
        <div class="field"><div class="pick"></div></div>
        <div class="err" hidden></div>
        <div class="actions">
          <button class="flat quiet left" data-act="cancel">Cancel</button>
          <button class="flat" data-act="back">Back</button>
          <button class="primary" data-act="go"></button>
        </div>
      </div>`;
    this._adder = adder;

    const details = document.createElement("div");
    details.className = "scrim details-scrim";
    details.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <h2 class="dname"></h2>
        <div class="sub"><code class="did"></code></div>
        <div class="state-row">
          <div class="grow">Correction<div class="meta dstate"></div></div>
          <button class="tonal dtoggle"></button>
        </div>
        <div class="section dref">
          <label class="tiny">Reference light</label>
          <div class="dpick"></div>
        </div>
        <div class="section dcopy" hidden>
          <label class="tiny">Copy calibration from</label>
          <select class="dcopyfrom"></select>
        </div>
        <div class="section dmeasure">
          <button class="flat dshow">Show measurements</button>
          <div class="measurements" hidden></div>
        </div>
        <div class="actions">
          <button class="flat danger left dclear">Clear profile</button>
          <button class="primary dclose">Close</button>
        </div>
      </div>`;
    this._details = details;
    details.addEventListener("click", (e) => {
      if (e.target === details) this._closeDetails();
    });
    details.querySelector(".dclose").addEventListener(
      "click", () => this._closeDetails());
    details.querySelector(".dtoggle").addEventListener("click", () => {
      const a = this._detailsAttrs();
      if (a) this._hass.callService("switch", "toggle",
        { entity_id: this._detailsEntity.replace(/^sensor\./, "switch.") });
    });
    details.querySelector(".dclear").addEventListener(
      "click", () => this._clearProfile(this._detailsEntity));
    details.querySelector(".dcopyfrom").addEventListener(
      "change", (e) => this._copyFrom(this._detailsEntity, e.target));
    details.querySelector(".dshow").addEventListener(
      "click", () => this._toggleMeasurements(details));

    this._dialog = document.createElement("light-calibration-dialog");
    this.shadowRoot.append(style, wrap, adder, details, this._dialog);
    adder.addEventListener("click", (e) => {
      if (e.target === adder) this._closeAdd();
    });
    adder.querySelector('[data-act="cancel"]').addEventListener(
      "click", () => this._closeAdd());
    adder.querySelector('[data-act="back"]').addEventListener(
      "click", () => this._addBack());
    adder.querySelector('[data-act="go"]').addEventListener(
      "click", () => this._addNext());
    this._body = wrap.querySelector("#body");
    wrap.querySelector(".back").addEventListener("click", () => this._goBack());
    this._pickerReady = loadEntityPicker();
    // The add buttons are written into .body as markup whenever the list is
    // rebuilt, so the click is caught here rather than re-bound each time.
    this._body.addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) this._openAdd();
    });
    this._built = true;
  }

  /* A custom panel gets no toolbar of its own, so it needs to provide the way
     out. Prefer real history; fall back to the integration page for a deep link
     or a fresh tab. */
  _goBack() {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    const path = "/config/integrations/integration/light_calibration";
    window.history.pushState(null, "", path);
    this.dispatchEvent(
      new CustomEvent("location-changed", { bubbles: true, composed: true })
    );
  }

  _render() {
    let sensors = calibrationSensors(this._hass);
    const scoped = this._scopedEntryId();
    if (scoped) {
      const only = sensors.filter(
        (e) => this._hass.states[e].attributes.entry_id === scoped
      );
      if (only.length) sensors = only;
    }

    if (!sensors.length) {
      if (this._empty !== true) {
        this._empty = true;
        this._items.clear();
        this._body.innerHTML =
          `<div class="item empty">
             <h3>No lights calibrated yet</h3>
             <p>Pick a light you trust as the reference and a light that doesn't
             match it, and you'll be matching them by eye a few seconds later.</p>
           </div>
           <div class="add"><button class="primary" data-add>Calibrate a light</button></div>`;
      }
      return;
    }
    this._empty = false;

    // Rebuild only when the set of calibrated lights changes -- never while
    // someone is interacting with a picker.
    const key = sensors.join("|");
    if (key !== this._key) {
      this._key = key;
      this._items.clear();
      this._body.innerHTML = "";
      const grid = document.createElement("div");
      grid.className = "grid";
      for (const entity of sensors) {
        const item = this._buildItem(entity);
        this._items.set(entity, item);
        grid.appendChild(item.el);
      }
      this._body.appendChild(grid);
      const add = document.createElement("div");
      add.className = "add";
      add.innerHTML = `<button class="flat" data-add>+ Calibrate another light</button>`;
      this._body.appendChild(add);
    }
    for (const [entity, item] of this._items) this._updateItem(entity, item);
    if (this._details.classList.contains("open")) this._renderDetails();

    // A light that has just been added has no profile yet -- drop straight into
    // calibration rather than making them find the button. Keyed on "has no
    // profile", not "is the only light", which is what broke this before.
    if (!this._autoOpened) {
      const fresh = sensors.find((e) => {
        const a = this._hass.states[e].attributes;
        return !a.active && a.stored_points === 0;
      });
      if (fresh) {
        this._autoOpened = true;
        this._dialog.hass = this._hass;
        this._dialog.open(fresh);
      }
    }
  }

  /* Home Assistant's config flow is drivable over its own HTTP API, and this
     integration owns both ends of it: the form is always the same two lights.
     So the panel asks for them here and submits, instead of sending people out
     to Settings, through a flow dialog, and back again to start calibrating. */
  async _openAdd() {
    this._addPicked = ["", ""];
    this._addStep = 0;
    this._setAddError("");
    this._adder.classList.add("open");
    await this._renderAddStep();
  }

  /* One question per step. The heading is the whole prompt -- a light that
     looks wrong, then a light to match it against -- so there is nothing else
     on the step to read. */
  async _renderAddStep() {
    const step = this._addStep;
    const dialog = this._adder;
    dialog.querySelector(".ask").textContent = step === 0
      ? "Which light looks wrong?"
      : "Which light should it match?";
    dialog.querySelectorAll(".dots span").forEach(
      (dot, i) => dot.classList.toggle("on", i <= step));
    dialog.querySelector('[data-act="back"]').style.display =
      step === 0 ? "none" : "";
    const go = dialog.querySelector('[data-act="go"]');
    go.textContent = step === 0 ? "Next" : "Start calibrating";
    go.disabled = false;
    this._setAddError("");

    // The displaced fixtures are never an answer to either question: they are
    // the uncorrected output of a light already calibrated, so matching against
    // one throws away the correction, and calibrating one again is nonsense.
    const raw = new Set();
    const calibrated = new Set();
    for (const e of calibrationSensors(this._hass)) {
      const behind = this._hass.states[e].attributes.calibrating || "";
      raw.add(behind);
      calibrated.add(behind.replace(/_raw$/, ""));
    }
    // Step one also hides lights this integration already stands in front of;
    // step two hides the light being calibrated, so the two can never be the
    // same and that rejection can never come up. A calibrated light is a fine
    // reference, though -- often the best one.
    const skip = step === 0
      ? new Set([...raw, ...calibrated])
      : new Set([...raw, this._addPicked[0]]);
    await this._mountAddPicker(skip, this._addPicked[step]);
  }

  async _mountAddPicker(skip, value) {
    const native = await this._pickerReady;
    const holder = this._adder.querySelector(".pick");
    // Rebuilt each step, so it never hands back an answer to a different
    // question and its exclusions are never stale.
    holder.replaceChildren();
    if (native) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.includeDomains = ["light"];
      picker.allowCustomEntity = false;
      picker.excludeEntities = [...skip].filter(Boolean);
      picker.value = value || "";
      holder.appendChild(picker);
      return;
    }
    const select = document.createElement("select");
    select.innerHTML =
      `<option value="">Choose a light...</option>` +
      Object.keys(this._hass.states)
        .filter((e) => e.startsWith("light.") && !skip.has(e))
        .sort()
        .map((e) => `<option value="${e}"${e === value ? " selected" : ""}>` +
                    `${this._name(e)}</option>`)
        .join("");
    holder.appendChild(select);
  }

  async _addBack() {
    this._addStep = 0;
    await this._renderAddStep();
  }

  async _addNext() {
    const holder = this._adder.querySelector(".pick").firstChild;
    const value = (holder && holder.value) || "";
    if (!value) {
      this._setAddError("Pick a light.");
      return;
    }
    this._addPicked[this._addStep] = value;
    if (this._addStep === 0) {
      this._addStep = 1;
      await this._renderAddStep();
      return;
    }
    await this._submitAdd();
  }

  _closeAdd() {
    this._adder.classList.remove("open");
  }

  _setAddError(text) {
    const box = this._adder.querySelector(".err");
    box.textContent = text;
    box.hidden = !text;
  }

  /* The flow answers with error keys, which are the same ones the translations
     already carry -- so the message is whatever the setup form would have said. */
  _addErrorText(code) {
    const key = `component.light_calibration.config.error.${code}`;
    const localized = this._hass.localize && this._hass.localize(key);
    return localized && localized !== key
      ? localized : `That light cannot be calibrated (${code}).`;
  }

  async _submitAdd() {
    const [target, reference] = this._addPicked;
    const go = this._adder.querySelector('[data-act="go"]');
    go.disabled = true;
    this._setAddError("");
    let flow = null;
    try {
      flow = await this._hass.callApi("POST", "config/config_entries/flow", {
        handler: "light_calibration", show_advanced_options: false,
      });
      const result = await this._hass.callApi(
        "POST", `config/config_entries/flow/${flow.flow_id}`,
        { reference_entity: reference, target_entity: target },
      );
      if (result.type === "create_entry") {
        this._closeAdd();
        await this._openWhenReady(result.result.entry_id);
        return;
      }
      // Came back with the form: say why, and drop the half-finished flow so it
      // does not sit in Settings as something in progress.
      this._setAddError(this._addErrorText(
        (result.errors && result.errors.base) || result.reason || "unknown"));
    } catch (err) {
      this._setAddError(
        (err && (err.message || (err.body && err.body.message))) || String(err));
    }
    if (flow) {
      try {
        await this._hass.callApi(
          "DELETE", `config/config_entries/flow/${flow.flow_id}`);
      } catch (err) { /* already gone */ }
    }
    go.disabled = false;
  }

  /* The entry exists before its entities do. Wait for the sensor, then drop
     straight into calibration -- which is the whole point of adding one. */
  async _openWhenReady(entryId) {
    for (let i = 0; i < 40; i++) {
      const found = calibrationSensors(this._hass).find(
        (e) => this._hass.states[e].attributes.entry_id === entryId);
      if (found) {
        this._autoOpened = true;   // this is the auto-open; do not also fire it
        this._dialog.hass = this._hass;
        this._dialog.open(found);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /* Entity ids are for automations, not for people. */
  _name(entityId) {
    if (!entityId) return "";
    const st = this._hass && this._hass.states[entityId];
    if (st && st.attributes.friendly_name) return st.attributes.friendly_name;
    return entityId.replace(/^[^.]+\./, "").replace(/_raw$/, "").replace(/_/g, " ");
  }

  /* A card is a glance: which light, whether it is corrected right now, and how
     much was measured. Everything you might change lives behind Details, so the
     grid stays readable when there are eight of these. */
  _buildItem(entity) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="top">
        <span class="dot"></span>
        <div>
          <h3></h3>
          <div class="meta"></div>
        </div>
      </div>
      <div class="copy" hidden>
        <label class="tiny">Copy calibration from</label>
        <select class="copyfrom"></select>
      </div>
      <div class="row">
        <button class="primary calibrate"></button>
        <div class="spacer"></div>
        <button class="flat details">Details</button>
      </div>`;

    el.querySelector(".calibrate").addEventListener("click", () => {
      this._dialog.hass = this._hass;
      this._dialog.open(entity);
    });
    el.querySelector(".details").addEventListener(
      "click", () => this._openDetails(entity));
    const copy = el.querySelector(".copyfrom");
    copy.addEventListener("change", () => this._copyFrom(entity, copy));

    return {
      el,
      dot: el.querySelector(".dot"),
      title: el.querySelector("h3"),
      meta: el.querySelector(".meta"),
      calibrate: el.querySelector(".calibrate"),
      copyRow: el.querySelector(".copy"),
      copy,
    };
  }

  /* Only offered on a light with nothing to lose. Once one is calibrated,
     replacing its measurements is a thing you go looking for, not something
     sitting next to the button you press every day. */
  _copySources(entity) {
    return calibrationSensors(this._hass).filter(
      (e) => e !== entity && this._hass.states[e].attributes.stored_points > 0
    );
  }

  _fillCopyOptions(select, sources) {
    select.innerHTML =
      `<option value="">Choose a light...</option>` +
      sources.map((e) => {
        const sa = this._hass.states[e].attributes;
        return `<option value="${e}">${this._name(sa.calibrating)} - ` +
               `${sa.profile_summary || sa.stored_points + " points"}</option>`;
      }).join("");
  }

  _copyFrom(entity, select) {
    const other = select.value;
    select.value = "";
    if (!other) return;
    const to = this._hass.states[entity].attributes;
    const from = this._hass.states[other].attributes;
    const losing = to.stored_points > 0
      ? `\n\n${this._name(to.calibrating)}'s own measurements ` +
        `(${to.profile_summary}) are discarded.`
      : "";
    if (!window.confirm(
      `Give ${this._name(to.calibrating)} the calibration measured for ` +
      `${this._name(from.calibrating)} ` +
      `(${from.profile_summary || from.stored_points + " points"})?\n\n` +
      `Only worth it if they are the same model -- a profile describes one ` +
      `fixture's particular errors.${losing}`)) return;
    this._hass.callService("light_calibration", "copy_profile", {
      entry_id: to.entry_id, source_entry_id: from.entry_id,
    });
  }

  _clearProfile(entity) {
    const a = this._hass.states[entity].attributes;
    if (!window.confirm(
      `Discard the calibration for ${this._name(a.calibrating)}?\n\n` +
      `It goes back to uncorrected output, and measuring it again means ` +
      `another pass with the sliders.`)) return;
    this._hass.callService("light_calibration", "clear_profile",
      { entry_id: a.entry_id });
  }

  async _toggleMeasurements(root) {
    const box = root.querySelector(".measurements");
    const button = root.querySelector(".dshow");
    if (!box.hidden) {
      box.hidden = true;
      button.textContent = "Show measurements";
      return;
    }
    button.disabled = true;
    try {
      const result = await this._hass.callWS({
        type: "light_calibration/profile",
        entry_id: this._detailsAttrs().entry_id,
      });
      box.innerHTML = renderPoints(result.points || []);
      button.textContent = "Hide measurements";
    } catch (err) {
      box.textContent = `Could not read the profile: ${(err && err.message) || err}`;
    }
    box.hidden = false;
    button.disabled = false;
  }

  // ------------------------------------------------------------------ details
  _detailsAttrs() {
    const st = this._detailsEntity && this._hass.states[this._detailsEntity];
    return st ? st.attributes : null;
  }

  async _openDetails(entity) {
    this._detailsEntity = entity;
    const box = this._details.querySelector(".measurements");
    box.hidden = true;
    this._details.querySelector(".dshow").textContent = "Show measurements";
    this._details.classList.add("open");
    this._renderDetails();

    const holder = this._details.querySelector(".dpick");
    holder.replaceChildren();
    const native = await this._pickerReady;
    const a = this._detailsAttrs();
    if (!a) return;
    const exclude = [a.calibrating, (a.calibrating || "").replace(/_raw$/, "")];
    const set = (value) => {
      if (!value || value === this._detailsAttrs().reference_light) return;
      this._hass.callService("light_calibration", "set_reference",
        { entry_id: a.entry_id, entity_id: value });
    };
    if (native) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.includeDomains = ["light"];
      picker.excludeEntities = exclude;
      picker.allowCustomEntity = false;
      picker.value = a.reference_light || "";
      picker.addEventListener("value-changed", (e) => set(e.detail.value));
      holder.appendChild(picker);
      return;
    }
    const select = document.createElement("select");
    select.innerHTML = Object.keys(this._hass.states)
      .filter((e) => e.startsWith("light.") && !exclude.includes(e))
      .sort()
      .map((e) => `<option value="${e}"` +
                  `${e === a.reference_light ? " selected" : ""}>` +
                  `${this._name(e)}</option>`).join("");
    select.addEventListener("change", (e) => set(e.target.value));
    holder.appendChild(select);
  }

  _closeDetails() {
    this._details.classList.remove("open");
    this._detailsEntity = null;
  }

  _renderDetails() {
    const a = this._detailsAttrs();
    if (!a) {
      this._closeDetails();
      return;
    }
    const d = this._details;
    const calibrated = a.stored_points > 0;
    d.querySelector(".dname").textContent = this._name(a.calibrating);
    d.querySelector(".did").textContent =
      (a.calibrating || "").replace(/_raw$/, "");

    const sw = this._hass.states[this._detailsEntity.replace(/^sensor\./, "switch.")];
    const on = sw && sw.state === "on";
    const toggle = d.querySelector(".dtoggle");
    toggle.hidden = !calibrated;
    toggle.textContent = on ? "Turn off" : "Turn on";
    d.querySelector(".dstate").textContent = !calibrated
      ? "Nothing measured yet"
      : on ? "Applied" : "Off -- the light is running uncorrected";

    // Hidden on the card once a light is calibrated, but still reachable here.
    const sources = this._copySources(this._detailsEntity);
    const copyBox = d.querySelector(".dcopy");
    copyBox.hidden = sources.length === 0;
    if (sources.length) this._fillCopyOptions(d.querySelector(".dcopyfrom"), sources);

    d.querySelector(".dmeasure").hidden = !calibrated;
    d.querySelector(".dclear").hidden = !calibrated;
  }

  _updateItem(entity, item) {
    const st = this._hass.states[entity];
    const a = st.attributes;
    const calibrated = a.stored_points > 0;
    const sw = this._hass.states[entity.replace(/^sensor\./, "switch.")];
    const on = sw && sw.state === "on";

    item.title.textContent = this._name(a.calibrating) || entity;
    item.calibrate.textContent = calibrated ? "Fine-tune" : "Calibrate";

    if (a.active) {
      item.dot.className = "dot busy";
      item.meta.textContent = st.state;
    } else if (!calibrated) {
      item.dot.className = "dot";
      item.meta.textContent = "Not calibrated";
    } else if (on) {
      item.dot.className = "dot on";
      item.meta.textContent = a.profile_summary;
    } else {
      item.dot.className = "dot off";
      item.meta.innerHTML =
        `${a.profile_summary} &middot; <span class="flag">correction off</span>`;
    }

    // Only on a light that has nothing to lose; otherwise it lives in Details.
    const sources = calibrated ? [] : this._copySources(entity);
    item.copyRow.hidden = sources.length === 0;
    const key = sources.map(
      (e) => e + ":" + this._hass.states[e].attributes.stored_points).join(",");
    if (sources.length && item.copyKey !== key) {
      item.copyKey = key;
      this._fillCopyOptions(item.copy, sources);
    }
  }
}

/* -------------------------------------------------------------------- card */

const CARD_STYLE = `
  ${BUTTONS}
  :host { display: block; }
  ha-card { padding: 16px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .name { font-size: 1.1rem; font-weight: 500; color: var(--primary-text-color); }
  .status { color: var(--secondary-text-color); font-size: 0.9rem; margin-top: 4px; }
`;

class LightCalibrationCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("Set 'entity' to a Light Calibration status sensor");
    }
    this._config = config;
  }

  static getStubConfig(hass) {
    return { entity: calibrationSensors(hass)[0] || "" };
  }

  getCardSize() { return 2; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    const st = hass.states[this._config.entity];
    if (!st) return;
    this._name.textContent = st.attributes.friendly_name || this._config.entity;
    this._status.textContent = st.state;
    this._dialog.hass = hass;
  }

  _build() {
    const style = document.createElement("style");
    style.textContent = CARD_STYLE;
    const card = document.createElement("ha-card");
    card.innerHTML = `
      <div class="row">
        <div><div class="name"></div><div class="status"></div></div>
        <button class="primary" id="open">Calibrate</button>
      </div>`;
    this._dialog = document.createElement("light-calibration-dialog");
    this.shadowRoot.append(style, card, this._dialog);
    this._name = card.querySelector(".name");
    this._status = card.querySelector(".status");
    card.querySelector("#open").addEventListener("click", () => {
      this._dialog.hass = this._hass;
      this._dialog.open(this._config.entity);
    });
    this._built = true;
  }
}

/* Loaded on every HA page, so never throw if it somehow runs twice. */
if (customElements.get("light-calibration-dialog")) {
  /* A different build already claimed these names in this page, and a custom
     element name cannot be redefined -- so everything above is inert and the
     page will keep rendering whichever build got here first.

     Content-addressing the module URL stops a stale file being *fetched*; it
     cannot help once a page has registered an older one, and Home Assistant's
     frontend is a single page app that survives a restart. Updating without
     reloading the tab therefore leaves the old interface in place, looking
     exactly like an update that did not work. Say so instead of going quiet. */
  console.warn(
    "%c LIGHT-CALIBRATION ", "background:#e65100;color:#fff",
    "another build of this panel is already loaded in this page, so this one " +
    "is doing nothing. Reload the page to pick up the new version."
  );
} else {
  customElements.define("light-calibration-dialog", LightCalibrationDialog);
  customElements.define("light-calibration-panel", LightCalibrationPanel);
  customElements.define("light-calibration-card", LightCalibrationCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "light-calibration-card",
    name: "Light Calibration",
    description: "Guided, live colour matching for a miscalibrated light.",
  });

  console.info("%c LIGHT-CALIBRATION ", "background:#03a9f4;color:#fff", "loaded");
}

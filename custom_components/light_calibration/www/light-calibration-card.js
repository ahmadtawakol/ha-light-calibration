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

const DEPTHS = [
  ["colors", "Colours only - 6 hues, ~5 min"],
  ["quick", "Quick - 5 whites, ~3 min"],
  ["standard", "Standard - 9 whites, ~8 min"],
  ["standard_color", "Standard + colours - 9 whites, 6 hues, ~13 min"],
  ["thorough", "Thorough - 15 whites, ~15 min"],
  ["thorough_color", "Thorough + colours - 15 whites, 6 hues, ~20 min"],
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
  .dialog h2 { margin: 0 0 4px; font-size: 1.35rem; font-weight: 400; }
  .sub { color: var(--secondary-text-color); font-size: 0.9rem; margin-bottom: 20px; }
  .swatch {
    display: inline-block; width: 14px; height: 14px; border-radius: 50%;
    vertical-align: middle; margin-right: 6px; border: 1px solid rgba(127,127,127,0.4);
  }
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
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  .actions .left { margin-right: auto; }
  .progress {
    height: 4px; border-radius: 2px; background: var(--divider-color, #ddd);
    overflow: hidden; margin-bottom: 20px;
  }
  .progress > div { height: 100%; background: var(--primary-color); transition: width .2s; }
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

  get _sliders() {
    return this._attrs.step_type === "color" ? COLOR_SLIDERS : WHITE_SLIDERS;
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

  _build() {
    const style = document.createElement("style");
    style.textContent = DIALOG_STYLE;
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="progress"><div id="bar" style="width:0%"></div></div>
        <h2 id="title"></h2>
        <div class="sub" id="sub"></div>
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
          <button class="flat left" id="cancel">Cancel</button>
          <button class="flat" id="back">Back</button>
          <button class="flat" id="finish">Finish now</button>
          <button class="primary" id="next">Start calibration</button>
        </div>
      </div>`;
    this.shadowRoot.append(style, scrim);

    const q = (sel) => scrim.querySelector(sel);
    this._els = {
      scrim, title: q("#title"), sub: q("#sub"), bar: q("#bar"),
      setup: q("#setup"), sliders: q("#sliders"), depth: q("#depth"),
      cancel: q("#cancel"), back: q("#back"), next: q("#next"),
      finish: q("#finish"),
    };

    this._els.cancel.addEventListener("click", () => {
      if (this._attrs.active) this._call("cancel_calibration");
      this.close();
    });
    this._els.back.addEventListener("click", () => this._call("previous_point"));
    this._els.finish.addEventListener("click", () => this._call("finish_calibration"));
    this._els.next.addEventListener("click", () => {
      if (this._done) { this.close(); return; }
      if (this._attrs.active) this._call("save_point");
      else this._call("start_calibration", { depth: this._els.depth.value });
    });
    scrim.addEventListener("click", (e) => {
      if (e.target === scrim) this.close();
    });
    this._onKey = (e) => {
      if (e.key === "Escape" && scrim.classList.contains("open")) this.close();
    };
    window.addEventListener("keydown", this._onKey);

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
      this._els.setup.style.display = "none";
      this._els.sliders.style.display = "none";
      this._els.back.style.display = "none";
      this._els.cancel.style.display = "none";
      this._els.finish.style.display = "none";
      this._els.next.textContent = "Done";
      this._els.bar.style.width = "100%";
      this._els.title.textContent = "Calibration saved";
      const colours = a.stored_colors
        ? ` (${a.stored_colors} of them hues)` : "";
      this._els.sub.innerHTML =
        `${a.stored_points || 0} points stored${colours}, merged into the profile - ` +
        `anything you did not revisit was kept. The lights have been put back the ` +
        `way they were.<br><br>Toggle <b>Calibration</b> to flip between raw and ` +
        `corrected output and see the difference.`;
      return;
    }

    this._els.cancel.style.display = "";
    this._els.setup.style.display = active ? "none" : "block";
    this._els.sliders.style.display = active ? "block" : "none";
    this._els.back.style.display = active ? "" : "none";
    this._els.next.textContent = active ? "Save point and next" : "Start calibration";
    this._els.back.disabled = !active || (a.step || 1) <= 1;
    // Only offer an early finish once something has actually been measured.
    this._els.finish.style.display =
      active && (a.measured_this_run || 0) > 0 ? "" : "none";

    // Swap the slider set for colour steps.
    const shown = this._sliders;
    for (const s of ALL_SLIDERS) {
      this.shadowRoot.querySelector(`#field-${s.key}`).hidden =
        !shown.some((x) => x.key === s.key);
    }

    if (active) {
      const swatch = a.sending_rgb
        ? `<span class="swatch" style="background: rgb(${a.sending_rgb.join(",")})"></span>`
        : "";
      this._els.title.textContent = `Step ${a.step} of ${a.total} - ${a.step_title || ""}`;
      this._els.sub.innerHTML = `${swatch}${a.instructions || ""}`;
      this._els.bar.style.width = `${((a.step - 1) / a.total) * 100}%`;
    } else {
      this._els.title.textContent = "Calibrate this light";
      const already = (a.stored_points || 0) > 0
        ? ` The sliders start from your stored calibration, so this fine-tunes it rather than starting over.`
        : "";
      this._els.sub.textContent =
        `Matching ${a.calibrating || ""} against ${a.reference_light || "the reference"}. ` +
        `Pause Adaptive Lighting on both first, or it will fight you.${already}`;
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
  .body { padding: 24px; max-width: 720px; margin: 0 auto; }
  .item {
    background: var(--card-background-color, #fff);
    border-radius: var(--ha-card-border-radius, 12px);
    box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.12));
    padding: 20px; margin-bottom: 16px; color: var(--primary-text-color);
  }
  .item h3 { margin: 0 0 2px; font-size: 1.1rem; font-weight: 500; }
  .meta { color: var(--secondary-text-color); font-size: 0.9rem; }
  .ref { margin-top: 16px; }
  .ref label { display: block; font-size: 0.85rem; margin-bottom: 4px;
               color: var(--secondary-text-color); }
  ha-entity-picker { display: block; width: 100%; }
  select {
    width: 100%; padding: 9px; border-radius: 8px; font-size: 0.9rem;
    background: var(--secondary-background-color, #f0f0f0);
    color: var(--primary-text-color);
    border: 1px solid var(--divider-color, #ccc); font-family: inherit;
  }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
  .row .spacer { flex: 1; }
  .empty { color: var(--secondary-text-color); }
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
    this._dialog = document.createElement("light-calibration-dialog");
    this.shadowRoot.append(style, wrap, this._dialog);
    this._body = wrap.querySelector("#body");
    wrap.querySelector(".back").addEventListener("click", () => this._goBack());
    this._pickerReady = loadEntityPicker();
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
          `<div class="item empty">No calibrated lights yet. Add one from
           Settings &rarr; Devices &amp; services &rarr; Add integration &rarr;
           Light Calibration.</div>`;
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
      for (const entity of sensors) {
        const item = this._buildItem(entity);
        this._items.set(entity, item);
        this._body.appendChild(item.el);
      }
    }
    for (const [entity, item] of this._items) this._updateItem(entity, item);

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

  _buildItem(entity) {
    const a = this._hass.states[entity].attributes;
    const entry_id = a.entry_id;

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <h3></h3>
      <div class="meta"></div>
      <div class="ref"><div class="picker"></div></div>
      <div class="row">
        <button class="primary calibrate">Calibrate</button>
        <button class="flat toggle" hidden></button>
        <div class="spacer"></div>
        <button class="flat clear">Clear profile</button>
      </div>
      <div class="note">Pause Adaptive Lighting on both lights before calibrating,
        or it will re-adapt them every 180s while you work.</div>`;

    el.querySelector(".calibrate").addEventListener("click", () => {
      this._dialog.hass = this._hass;
      this._dialog.open(entity);
    });
    el.querySelector(".clear").addEventListener("click", () => {
      this._hass.callService("light_calibration", "clear_profile", { entry_id });
    });

    // The switch shares the sensor's object_id; both are named "Calibration"
    // on the same device.
    const switchId = entity.replace(/^sensor\./, "switch.");
    const toggle = el.querySelector(".toggle");
    toggle.addEventListener("click", () => {
      this._hass.callService("switch", "toggle", { entity_id: switchId });
    });

    const item = {
      el,
      title: el.querySelector("h3"),
      meta: el.querySelector(".meta"),
      pickerSlot: el.querySelector(".picker"),
      picker: null,
      toggle,
      switchId,
      entry_id,
    };

    this._pickerReady.then((ok) => this._mountPicker(entity, item, ok));
    return item;
  }

  _mountPicker(entity, item, native) {
    const a = this._hass.states[entity].attributes;
    const setReference = (value) => {
      if (!value || value === this._hass.states[entity].attributes.reference_light) return;
      this._hass.callService("light_calibration", "set_reference", {
        entry_id: item.entry_id, entity_id: value,
      });
    };

    if (native) {
      const picker = document.createElement("ha-entity-picker");
      picker.hass = this._hass;
      picker.label = "Reference light (the one that looks right)";
      picker.includeDomains = ["light"];
      picker.excludeEntities = [a.calibrating, a.calibrating.replace(/_raw$/, "")];
      picker.allowCustomEntity = false;
      picker.value = a.reference_light || "";
      picker.addEventListener("value-changed", (ev) => setReference(ev.detail.value));
      item.pickerSlot.replaceChildren(picker);
      item.picker = picker;
      return;
    }

    // Fallback if the picker could not be loaded.
    const label = document.createElement("label");
    label.textContent = "Reference light (the one that looks right)";
    const select = document.createElement("select");
    select.addEventListener("change", (ev) => setReference(ev.target.value));
    item.pickerSlot.replaceChildren(label, select);
    item.picker = select;
    item.isSelect = true;
  }

  _updateItem(entity, item) {
    const st = this._hass.states[entity];
    const a = st.attributes;
    item.title.textContent = a.friendly_name || entity;
    item.meta.innerHTML = `${st.state} &middot; correcting <code>${a.calibrating || ""}</code>`;

    const sw = this._hass.states[item.switchId];
    if (sw && sw.state !== "unavailable") {
      item.toggle.hidden = false;
      item.toggle.textContent =
        sw.state === "on" ? "Calibration on - tap to compare" : "Calibration OFF - showing raw";
    } else {
      item.toggle.hidden = true;
    }

    if (!item.picker) return;
    if (item.isSelect) {
      const lights = Object.keys(this._hass.states).filter((e) => e.startsWith("light.")).sort();
      if (item.picker.options.length !== lights.length) {
        item.picker.replaceChildren(...lights.map((l) => {
          const o = document.createElement("option");
          o.value = l;
          o.textContent = this._hass.states[l].attributes.friendly_name || l;
          return o;
        }));
      }
      item.picker.value = a.reference_light || "";
    } else {
      item.picker.hass = this._hass;
      if (document.activeElement !== item.picker) {
        item.picker.value = a.reference_light || "";
      }
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
if (!customElements.get("light-calibration-dialog")) {
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

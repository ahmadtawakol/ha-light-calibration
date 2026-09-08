/* Mock Home Assistant for dev/harness.html. Nothing here talks to a real
   instance: service calls are logged, not sent. */
/* A mock `hass` good enough to render every state the dialog and panel have.
   Nothing here talks to Home Assistant -- service calls are logged, not sent. */

const SENSOR = "sensor.living_room_light_stand_calibration";
const SWITCH = "switch.living_room_light_stand_calibration";
const TARGET = "light.living_room_light_stand_raw";
const REFERENCE = "light.bookcase_light_bars";

/* A second, always-calibrated entry. Two entries is the realistic case, and it
   is what makes the "copy calibration from" control appear at all. */
const SENSOR2 = "sensor.hallway_downlight_calibration";
const TARGET2 = "light.hallway_downlight_raw";

/* Matches CalibrationSession.extra_attributes() plus the sensor's own two. */
const IDLE = {
  entry_id: "01JDEV", active: false, depth: "standard",
  step: null, total: null, step_type: null, step_title: "",
  nominal_kelvin: null, nominal_hue: null, nominal_brightness: null,
  sending_rgb: null, instructions: "Press 'Start calibration' to begin.",
  reference_light: REFERENCE, calibrating: TARGET,
  warm_cool: 0, green_magenta: 0, hue_shift: 0, saturation: 100, brightness: 40,
  calibration_enabled: true, supports_color: true,
  verifying: false, verify_step: null, verify_total: null,
  comparing: false, skipped: [], measured_this_run: 0,
  stored_points: 0, stored_colors: 0,
  friendly_name: "Living Room Light Stand Calibration",
};

const STATES = {
  "no lights": { empty: true },

  "fresh (just added)": { state: "Not calibrated", a: {} },

  "idle, calibrated": { state: "Calibrated (9 whites, 6 colours)",
    a: { stored_points: 15, stored_colors: 6 } },

  "white step": { state: "Step 3/9 - 2700K at 40%", a: {
    active: true, step: 3, total: 9, step_type: "white", step_title: "2700K at 40%",
    nominal_kelvin: 2700, nominal_brightness: 40, sending_rgb: [255, 167, 87],
    measured_this_run: 2, warm_cool: -250, green_magenta: 12, brightness: 45,
    instructions: "Reference is at 2700K, 40%. Move the sliders until the light being calibrated looks the same. Purple or pink means push Magenta/green towards green." } },

  "colour step": { state: "Step 11/15 - red at 60%", a: {
    active: true, step: 11, total: 15, step_type: "color", step_title: "red at 60%",
    nominal_hue: 0, nominal_brightness: 60, sending_rgb: [255, 85, 51],
    measured_this_run: 10, hue_shift: 10, saturation: 82, brightness: 55,
    instructions: "The reference is showing red. Rotate the hue until the two read as the same colour, then pull saturation and brightness to match. Colours are harder to judge than whites -- step back and compare, do not stare." } },

  "comparing": { state: "Step 3/9 - 2700K at 40%", a: {
    active: true, step: 3, total: 9, step_type: "white", step_title: "2700K at 40%",
    sending_rgb: [255, 167, 87], measured_this_run: 2, comparing: true,
    warm_cool: -250, green_magenta: 12, brightness: 45,
    instructions: "Reference is at 2700K, 40%. Move the sliders until the light being calibrated looks the same." } },

  "tunable white": { state: "Step 2/9 - 2700K at 40%", a: {
    active: true, step: 2, total: 9, step_type: "white", step_title: "2700K at 40%",
    supports_color: false, sending_rgb: [255, 167, 87], measured_this_run: 1,
    warm_cool: -150, brightness: 44,
    instructions: "Reference is at 2700K, 40%. Move the sliders until the light being calibrated looks the same." } },

  "steps skipped": { state: "Step 1/6 - 2700K at 10%", a: {
    active: true, step: 1, total: 6, step_type: "white", step_title: "2700K at 10%",
    sending_rgb: [255, 167, 87], measured_this_run: 0,
    skipped: ["3 steps at 2000K: the reference light only covers 2200-6500K"],
    instructions: "Reference is at 2700K, 10%. Move the sliders until the light being calibrated looks the same." } },

  "verifying": { state: "Checking 2/3 - 2700K at 40%", a: {
    active: true, verifying: true, verify_step: 2, verify_total: 3,
    step: 9, total: 9, step_type: "white", step_title: "2700K at 40%",
    measured_this_run: 9,
    instructions: "This is the finished calibration, replayed. Both lights should now look the same. If one of these is off, go back and redo it -- everything measured so far is kept either way." } },

  "saved": { state: "Calibrated (9 whites, 6 colours)", done: true,
    a: { stored_points: 15, stored_colors: 6 } },
};

/* A realistic Standard + colours profile, for the measurements table. */
const SAMPLE_POINTS = [
  ...[10, 40, 80].flatMap((b, i) => [2000, 2700, 4000].map((k, j) => ({
    type: "white", kelvin: k, brightness: b,
    kelvin_offset: -320 + j * 70 + i * 15, tint: 14 - j * 4,
    brightness_actual: b + 5 - i * 2,
  }))),
  ...[0, 60, 120, 180, 240, 300].map((h) => ({
    type: "color", hue: h, brightness: 60,
    hue_shift: h === 0 ? 9 : h === 120 ? -6 : 3,
    saturation: 88 - (h % 90) / 10, brightness_actual: 55,
  })),
];

let current = "fresh (just added)";

function log(line) {
  const el = document.createElement("div");
  el.className = "call";
  el.textContent = `${new Date().toLocaleTimeString()}  ${line}`;
  const box = document.getElementById("log");
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function hass() {
  const s = STATES[current];
  const states = {
    [REFERENCE]: { entity_id: REFERENCE, state: "on",
      attributes: { friendly_name: "Bookcase Light Bars",
                    supported_color_modes: ["color_temp", "hs"],
                    min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6535 } },
    [TARGET]: { entity_id: TARGET, state: "on",
      attributes: { friendly_name: "Living Room Light Stand",
                    supported_color_modes: ["color_temp", "rgb"] } },
    "light.living_room_light_stand": { entity_id: "light.living_room_light_stand",
      state: "on", attributes: { friendly_name: "Living Room Light Stand" } },
    "light.kitchen_downlights": { entity_id: "light.kitchen_downlights", state: "off",
      attributes: { friendly_name: "Kitchen Downlights" } },
  };
  if (!s.empty) {
    const attrs = { ...IDLE, ...(s.a || {}) };
    attrs.stored_whites = attrs.stored_points - attrs.stored_colors;
    attrs.profile_summary = [
      attrs.stored_whites ? `${attrs.stored_whites} whites` : "",
      attrs.stored_colors ? `${attrs.stored_colors} colours` : "",
    ].filter(Boolean).join(", ");
    states[SENSOR] = { entity_id: SENSOR, state: s.state, attributes: attrs };
    states[SWITCH] = { entity_id: SWITCH,
      // The switch is unavailable until there is something to switch.
      state: attrs.stored_points > 0 ? "on" : "unavailable",
      attributes: { friendly_name: "Living Room Light Stand Calibration" } };
  }
  if (!s.empty) {
    states[TARGET2] = { entity_id: TARGET2, state: "on",
      attributes: { friendly_name: "Hallway Downlight",
                    supported_color_modes: ["color_temp", "rgb"] } };
    states[SENSOR2] = { entity_id: SENSOR2, state: "Calibrated (5 whites)",
      attributes: { ...IDLE, entry_id: "01JDEV2", calibrating: TARGET2,
                    stored_points: 5, stored_colors: 0, stored_whites: 5,
                    profile_summary: "5 whites",
                    friendly_name: "Hallway Downlight Calibration" } };
    states["switch.hallway_downlight_calibration"] = {
      entity_id: "switch.hallway_downlight_calibration", state: "on",
      attributes: { friendly_name: "Hallway Downlight Calibration" } };
  }
  return {
    states,
    callService: (domain, service, data) =>
      log(`${domain}.${service} ${JSON.stringify(data)}`),
    /* The panel drives Home Assistant's config flow over the HTTP API to add a
       light without leaving the page. Simulated here so the add dialog, its
       error handling and the hand-off into calibration can all be exercised.
       Set window.__flowError to a key to see the failure path. */
    callApi: async (method, path, body) => {
      log(`API ${method} ${path} ${body ? JSON.stringify(body) : ""}`);
      if (method === "POST" && path === "config/config_entries/flow") {
        return { flow_id: "flow-1", type: "form", step_id: "user" };
      }
      if (method === "POST" && path.startsWith("config/config_entries/flow/")) {
        if (window.__flowError) {
          return { type: "form", step_id: "user",
                   errors: { base: window.__flowError } };
        }
        return { type: "create_entry", result: { entry_id: "01JDEVNEW" } };
      }
      return {};
    },
    localize: (key) => ({
      "component.light_calibration.config.error.same_light":
        "The reference and the light being calibrated have to be two different lights.",
      "component.light_calibration.config.error.no_color_control":
        "That light has no colour control at all -- it can't be set to a colour or a colour temperature, so there's nothing to calibrate.",
    })[key] || key,
    /* The panel fetches measured points over the websocket rather than reading
       them off the sensor, so the mock has to answer that too. */
    callWS: async (msg) => {
      log(`WS ${msg.type} ${JSON.stringify({ entry_id: msg.entry_id })}`);
      if (msg.type !== "light_calibration/profile") throw new Error("unknown");
      return { points: SAMPLE_POINTS };
    },
  };
}

/* The panel's back arrow navigates Home Assistant; in here that would just
   strand you on a blank page. */
history.pushState = () => {};

/* Home Assistant answers hass-more-info by opening the entity's dialog. Nothing
   here does, so log it -- it is the only way to see that a tile fired the right
   event for the right light. */
window.addEventListener("hass-more-info", (e) =>
  log(`more-info ${e.detail && e.detail.entityId}`));

const panel = document.createElement("light-calibration-panel");
document.getElementById("mount").appendChild(panel);
// The panel builds its shadow tree lazily, on the first hass assignment, so
// there is no dialog to reach for until it has had one.
panel.hass = hass();
const dialog = () => panel.shadowRoot.querySelector("light-calibration-dialog");

function show(name) {
  current = name;
  const s = STATES[name];
  const attrs = { ...IDLE, ...(s.a || {}) };
  panel._key = null;            // force the card list to rebuild
  panel._autoOpened = false;    // so the panel's own auto-open can fire again
  dialog()._done = false;
  dialog().close();

  // Setting hass is what the panel reacts to, and for a light with no profile
  // that is where it opens the dialog by itself -- the behaviour worth seeing,
  // so it is left to happen rather than driven from here.
  panel.hass = hass();

  if (s.done) { dialog().open(SENSOR); dialog()._done = true; }
  else if (attrs.active) { dialog().open(SENSOR); }
  panel.hass = hass();
  for (const b of bar.querySelectorAll("button")) b.classList.toggle("on", b.textContent === name);
}

const bar = document.getElementById("states");
const label = document.createElement("div");
label.className = "label";
label.textContent = "state (the panel auto-opens the dialog for an uncalibrated light)";
bar.appendChild(label);
for (const name of Object.keys(STATES)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => show(name);
  bar.appendChild(b);
}
const sep = document.createElement("div"); sep.className = "sep"; bar.appendChild(sep);
const theme = document.createElement("button");
theme.textContent = "toggle dark";
theme.onclick = () => document.documentElement.classList.toggle("dark");
bar.appendChild(theme);
const close = document.createElement("button");
close.textContent = "close dialog";
close.onclick = () => dialog().close();
bar.appendChild(close);

show(current);

/* Module scope, so nothing is global by default. These are the handles worth
   driving the harness with from a console or an automated browser. */
Object.assign(window, { show, hass, panel, dialog, STATES });

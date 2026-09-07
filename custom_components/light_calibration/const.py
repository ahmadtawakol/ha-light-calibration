"""Constants for the Light Calibration integration."""
from __future__ import annotations

DOMAIN = "light_calibration"

CONF_REFERENCE = "reference_entity"
CONF_TARGET = "target_entity"
CONF_NAME = "name"
CONF_DEPTH = "depth"
CONF_POINTS = "points"
CONF_TAKEOVER = "takeover_entity_id"
CONF_ORIGINAL_ID = "original_entity_id"
CONF_RENAMED_ID = "renamed_entity_id"

# Per-step form fields
FIELD_WARM_COOL = "warm_cool"
FIELD_TINT = "green_magenta"
FIELD_BRIGHTNESS = "brightness"
FIELD_NEXT = "matches"

# Slider bounds
WARM_COOL_MIN = -1200
WARM_COOL_MAX = 1200
WARM_COOL_STEP = 25
TINT_MIN = -60
TINT_MAX = 60
TINT_STEP = 2

DEFAULT_TRANSITION = 0.4

"""Diagnostics: the stored calibration, in full.

The profile lives in config entry data, which is not visible from anywhere in
Home Assistant's interface. Downloading diagnostics is the idiomatic way to get
at an integration's internal state, and it is the only way to see every measured
point at once -- useful for a bug report, and for keeping a copy before doing
something irreversible to a profile.
"""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .calibration import CalibrationProfile, count_points
from .const import CONF_ORIGINAL_ID, CONF_POINTS, CONF_REFERENCE, CONF_TARGET


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Everything this entry knows. None of it is sensitive."""
    points = entry.data.get(CONF_POINTS) or []
    whites, colors = count_points(points)
    profile = CalibrationProfile.from_list(points)

    return {
        "entry": {
            "title": entry.title,
            "version": f"{entry.version}.{entry.minor_version}",
            "calibrated_light": entry.data.get(CONF_ORIGINAL_ID),
            "real_light": entry.data.get(CONF_TARGET),
            "reference_light": entry.data.get(CONF_REFERENCE),
        },
        "profile": {
            "whites": whites,
            "colours": colors,
            "points": points,
        },
        # What the profile actually does, sampled across the range it covers --
        # easier to sanity check than the raw measurements.
        "corrections": {
            f"{kelvin}K at {brightness}%": {
                "kelvin_offset": round(offset, 1),
                "tint": round(tint, 1),
                "brightness_scale": round(scale, 3),
            }
            for kelvin in (2000, 2700, 4000)
            for brightness in (10, 40, 80)
            for offset, tint, scale in [profile.correction(kelvin, brightness)]
        },
    }

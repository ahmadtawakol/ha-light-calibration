"""What a target fixture can actually be driven with.

A tunable-white fixture has no way to render a colour off the blackbody curve.
Sending it an RGB value does not fail -- Home Assistant quietly converts the RGB
back to a colour temperature, which throws the green/magenta tint away and
mangles the kelvin on the way through: ask for 2700K with no correction at all
and the fixture receives about 1868K, because Tanner Helland's curve and core's
``color_xy_to_temperature`` are not inverses of each other.

So the drive path follows the fixture, and calibration stops offering the axes
it cannot measure.
"""
from __future__ import annotations

from homeassistant.components.light import ATTR_SUPPORTED_COLOR_MODES, ColorMode
from homeassistant.core import HomeAssistant

# The modes that can carry a colour off the blackbody curve.
OFF_CURVE_MODES = frozenset(
    {ColorMode.RGB, ColorMode.RGBW, ColorMode.RGBWW, ColorMode.HS, ColorMode.XY}
)


def color_modes(hass: HomeAssistant, entity_id: str) -> set[str]:
    """The fixture's colour modes, or an empty set if it is not around."""
    state = hass.states.get(entity_id)
    if state is None:
        return set()
    return set(state.attributes.get(ATTR_SUPPORTED_COLOR_MODES) or [])


def supports_color(hass: HomeAssistant, entity_id: str) -> bool:
    """Whether the fixture can be driven off the blackbody curve.

    Unknown counts as yes: an entity that has not loaded yet should keep the
    ordinary RGB path rather than silently drop to colour temperature and lose
    the tint correction for the rest of the session.
    """
    modes = color_modes(hass, entity_id)
    return not modes or bool(modes & OFF_CURVE_MODES)


def is_calibratable(modes: set[str]) -> bool:
    """Whether there is any colour behaviour here to correct.

    Either a real colour mode, or colour temperature on its own. An on/off or
    brightness-only fixture has nothing this integration can calibrate.
    """
    return bool(modes & OFF_CURVE_MODES) or ColorMode.COLOR_TEMP in modes

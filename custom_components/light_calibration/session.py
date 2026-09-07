"""The live calibration session.

Walks a list of steps. A step is either a **white** (a colour temperature at a
brightness) or a **colour** (a hue at a brightness), and each kind gets its own
set of adjustments -- warm/cool and tint make no sense on pure red, and a hue
rotation makes no sense on a white.

Moving a slider applies to the light immediately, so you adjust and watch rather
than adjust and submit.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant

from .calibration import (
    COLOR_NAMES,
    DEPTH_POINTS,
    TYPE_COLOR,
    CalibrationPoint,
    CalibrationProfile,
    ColorPoint,
)
from .color_math import corrected_rgb, hs_to_rgb
from .const import CONF_POINTS, CONF_REFERENCE, CONF_TARGET, DEFAULT_TRANSITION

_LOGGER = logging.getLogger(__name__)


class CalibrationSession:
    """Holds the in-progress calibration for one entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.reference: str = entry.data.get(CONF_REFERENCE, "")
        self.target: str = entry.data.get(CONF_TARGET, "")

        self.active = False
        self.depth = "standard"
        self.points: list[dict] = []
        self.results: list[Any] = []
        self.index = 0

        # live values for a white step
        self.warm_cool = 0.0
        self.tint = 0.0
        # live values for a colour step
        self.hue_shift = 0.0
        self.saturation = 100.0
        # shared
        self.brightness = 40.0

        self._listeners: list[Callable[[], None]] = []
        self._snapshot: dict[str, dict] = {}
        # Whether the stored profile is applied. The switch flips this so the
        # before/after can be seen directly on the light.
        self.enabled = True

    # ------------------------------------------------------------- plumbing
    def add_listener(self, cb: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(cb)

        def _remove() -> None:
            if cb in self._listeners:
                self._listeners.remove(cb)

        return _remove

    def _notify(self) -> None:
        for cb in list(self._listeners):
            cb()

    # ---------------------------------------------------------------- state
    @property
    def total(self) -> int:
        return len(self.points)

    @property
    def current(self) -> dict | None:
        if not self.active or self.index >= len(self.points):
            return None
        return self.points[self.index]

    @property
    def step_type(self) -> str | None:
        step = self.current
        return step["type"] if step else None

    @property
    def is_color_step(self) -> bool:
        return self.step_type == TYPE_COLOR

    @property
    def step_label(self) -> str:
        return f"{self.index + 1}/{self.total}" if self.active else "idle"

    @property
    def step_title(self) -> str:
        step = self.current
        if not step:
            return ""
        if step["type"] == TYPE_COLOR:
            name = COLOR_NAMES.get(step["hue"], f"{step['hue']}°")
            return f"{name} at {step['brightness']}%"
        return f"{step['kelvin']}K at {step['brightness']}%"

    @property
    def instructions(self) -> str:
        step = self.current
        if not step:
            return "Press 'Start calibration' to begin."
        if step["type"] == TYPE_COLOR:
            name = COLOR_NAMES.get(step["hue"], "this colour")
            return (
                f"The reference is showing {name}. Rotate the hue until the two "
                f"read as the same colour, then pull saturation and brightness to "
                f"match. Colours are harder to judge than whites -- step back and "
                f"compare, do not stare."
            )
        return (
            f"Reference is at {step['kelvin']}K, {step['brightness']}%. Move the "
            f"sliders until the light being calibrated looks the same. Purple or "
            f"pink means push Magenta/green towards green."
        )

    # --------------------------------------------------------------- actions
    def _take_snapshot(self) -> None:
        """Remember how the lights looked so calibrating can put them back."""
        self._snapshot = {}
        for entity in (self.reference, self.target):
            state = self.hass.states.get(entity)
            if state is None:
                continue
            a = state.attributes
            self._snapshot[entity] = {
                "on": state.state == "on",
                "brightness": a.get("brightness"),
                "color_temp_kelvin": a.get("color_temp_kelvin"),
                "rgb_color": a.get("rgb_color"),
            }

    async def _async_restore_snapshot(self) -> None:
        """Put the lights back the way they were before calibration started."""
        for entity, snap in self._snapshot.items():
            if not snap["on"]:
                await self.hass.services.async_call(
                    "light", "turn_off",
                    {ATTR_ENTITY_ID: entity, "transition": DEFAULT_TRANSITION},
                    blocking=False,
                )
                continue
            data: dict = {ATTR_ENTITY_ID: entity, "transition": DEFAULT_TRANSITION}
            if snap["brightness"] is not None:
                data["brightness"] = snap["brightness"]
            if snap["color_temp_kelvin"]:
                data["color_temp_kelvin"] = snap["color_temp_kelvin"]
            elif snap["rgb_color"]:
                data["rgb_color"] = list(snap["rgb_color"])
            await self.hass.services.async_call("light", "turn_on", data, blocking=False)
        self._snapshot = {}

    async def async_set_enabled(self, enabled: bool) -> None:
        self.enabled = bool(enabled)
        self._notify()

    def _seed_values_for_step(self) -> None:
        """Pre-load the sliders for the current step.

        With a stored profile this is what makes a re-run a *fine tune*: the
        light already sits where the last calibration put it, and only the
        difference needs correcting. Without one, corrections carry forward from
        the previous step, which is usually close.
        """
        step = self.current
        if not step:
            return
        self.brightness = float(step["brightness"])

        profile = self.profile
        if not profile.is_calibrated:
            if step["type"] == TYPE_COLOR and not self._came_from_color():
                self.hue_shift = 0.0
                self.saturation = 100.0
            return

        if step["type"] == TYPE_COLOR:
            shift, sat_scale, bright_scale = profile.color_correction(step["hue"])
            self.hue_shift = shift
            self.saturation = min(100.0, max(0.0, 100.0 * sat_scale))
            self.brightness = min(100.0, max(1.0, step["brightness"] * bright_scale))
        else:
            offset, tint, scale = profile.correction(step["kelvin"], step["brightness"])
            self.warm_cool = offset
            self.tint = tint
            self.brightness = min(100.0, max(1.0, step["brightness"] * scale))

    def _came_from_color(self) -> bool:
        return self.index > 0 and self.points[self.index - 1]["type"] == TYPE_COLOR

    def _merged_points(self) -> list[dict]:
        """Fold this run's results into the stored profile.

        Points are keyed on what they measure, so re-doing a step replaces just
        that step and everything untouched survives. A colours-only run keeps the
        whites; a partial re-run keeps whatever it did not revisit.
        """
        def key(d: dict) -> tuple:
            if d.get("type") == TYPE_COLOR:
                return (TYPE_COLOR, d.get("hue"), d.get("brightness"))
            return ("white", d.get("kelvin"), d.get("brightness"))

        merged = {key(d): d for d in (self.entry.data.get(CONF_POINTS) or [])}
        for point in self.results:
            d = point.as_dict()
            merged[key(d)] = d
        return list(merged.values())

    async def async_start(self, depth: str | None = None) -> None:
        self._take_snapshot()
        self.depth = depth or self.depth
        self.points = list(DEPTH_POINTS[self.depth])
        self.results = []
        self.index = 0
        self.active = True
        self.warm_cool = 0.0
        self.tint = 0.0
        self.hue_shift = 0.0
        self.saturation = 100.0
        self._seed_values_for_step()
        _LOGGER.info(
            "Calibration started: %s against %s, %d steps",
            self.target, self.reference, len(self.points),
        )
        await self.async_apply()
        self._notify()

    async def async_cancel(self) -> None:
        self.active = False
        self.points = []
        self.results = []
        self.index = 0
        await self._async_restore_snapshot()
        self._notify()

    async def async_next(self) -> None:
        """Record the current step and move on; save the profile at the end."""
        step = self.current
        if not step:
            return

        if step["type"] == TYPE_COLOR:
            self.results.append(
                ColorPoint(
                    hue=step["hue"],
                    brightness=step["brightness"],
                    hue_shift=self.hue_shift,
                    saturation=self.saturation,
                    brightness_actual=self.brightness,
                )
            )
        else:
            self.results.append(
                CalibrationPoint(
                    kelvin=step["kelvin"],
                    brightness=step["brightness"],
                    kelvin_offset=self.warm_cool,
                    tint=self.tint,
                    brightness_actual=self.brightness,
                )
            )
        self.index += 1

        if self.index >= len(self.points):
            await self._async_save()
            return

        self._seed_values_for_step()
        await self.async_apply()
        self._notify()

    async def async_back(self) -> None:
        """Step back to redo the previous step."""
        if not self.active or self.index == 0:
            return
        self.index -= 1
        if self.results:
            previous = self.results.pop()
            self.brightness = previous.brightness_actual
            if isinstance(previous, ColorPoint):
                self.hue_shift = previous.hue_shift
                self.saturation = previous.saturation
            else:
                self.warm_cool = previous.kelvin_offset
                self.tint = previous.tint
        await self.async_apply()
        self._notify()

    async def async_finish(self) -> None:
        """Save what has been measured so far and stop.

        For fine-tuning: fix the one point that drifted, then finish, instead of
        clicking through every remaining step.
        """
        if not self.active:
            return
        await self._async_save()

    async def _async_save(self) -> None:
        points = self._merged_points()
        self.active = False
        self.finished_points = len(points)
        _LOGGER.info(
            "Calibration finished for %s: %d measured this run, %d points stored",
            self.target, len(self.results), len(points),
        )
        await self._async_restore_snapshot()
        self._notify()
        self.hass.config_entries.async_update_entry(
            self.entry, data={**self.entry.data, CONF_POINTS: points}
        )

    # ----------------------------------------------------------------- apply
    async def async_apply(self) -> None:
        """Push the current values to both lights right now."""
        step = self.current
        if not step:
            return

        if step["type"] == TYPE_COLOR:
            reference_rgb = hs_to_rgb(step["hue"], 100.0)
            target_rgb = hs_to_rgb(step["hue"] + self.hue_shift, self.saturation)
            reference_data = {
                ATTR_ENTITY_ID: self.reference,
                "rgb_color": list(reference_rgb),
                "brightness_pct": step["brightness"],
                "transition": DEFAULT_TRANSITION,
            }
        else:
            target_rgb = corrected_rgb(step["kelvin"], self.warm_cool, self.tint)
            reference_data = {
                ATTR_ENTITY_ID: self.reference,
                "color_temp_kelvin": step["kelvin"],
                "brightness_pct": step["brightness"],
                "transition": DEFAULT_TRANSITION,
            }

        await self.hass.services.async_call(
            "light", "turn_on", reference_data, blocking=False
        )
        await self.hass.services.async_call(
            "light", "turn_on",
            {
                ATTR_ENTITY_ID: self.target,
                "rgb_color": list(target_rgb),
                "brightness_pct": int(round(self.brightness)),
                "transition": DEFAULT_TRANSITION,
            },
            blocking=False,
        )

    async def async_set_values(
        self,
        warm_cool: float | None = None,
        tint: float | None = None,
        brightness: float | None = None,
        hue_shift: float | None = None,
        saturation: float | None = None,
    ) -> None:
        """Set any combination of the axes in one go, then apply once.

        The dialog sends the whole set while you drag, so this keeps it to a
        single light command per update instead of one per slider.
        """
        if warm_cool is not None:
            self.warm_cool = float(warm_cool)
        if tint is not None:
            self.tint = float(tint)
        if brightness is not None:
            self.brightness = float(brightness)
        if hue_shift is not None:
            self.hue_shift = float(hue_shift)
        if saturation is not None:
            self.saturation = float(saturation)
        if self.active:
            await self.async_apply()
        self._notify()

    # ------------------------------------------------------------- preview
    @property
    def profile(self) -> CalibrationProfile:
        return CalibrationProfile.from_list(self.entry.data.get(CONF_POINTS))

    def preview_rgb(self) -> tuple[int, int, int]:
        step = self.current
        if not step:
            return (255, 167, 87)
        if step["type"] == TYPE_COLOR:
            return hs_to_rgb(step["hue"] + self.hue_shift, self.saturation)
        return corrected_rgb(step["kelvin"], self.warm_cool, self.tint)

    def extra_attributes(self) -> dict[str, Any]:
        step = self.current
        return {
            "active": self.active,
            "depth": self.depth,
            "step": self.index + 1 if self.active else None,
            "total": self.total or None,
            "step_type": self.step_type,
            "step_title": self.step_title,
            "nominal_kelvin": step.get("kelvin") if step else None,
            "nominal_hue": step.get("hue") if step else None,
            "nominal_brightness": step.get("brightness") if step else None,
            "sending_rgb": list(self.preview_rgb()) if self.active else None,
            "instructions": self.instructions,
            "reference_light": self.reference,
            "calibrating": self.target,
            "warm_cool": self.warm_cool,
            "green_magenta": self.tint,
            "hue_shift": self.hue_shift,
            "saturation": self.saturation,
            "brightness": self.brightness,
            "entry_id": self.entry.entry_id,
            "calibration_enabled": self.enabled,
            "measured_this_run": len(self.results),
        }

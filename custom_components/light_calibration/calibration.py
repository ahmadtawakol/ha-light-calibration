"""The calibration profile: measurement points and interpolation between them.

Two kinds of point:

* a **white** point -- "asked for 2700K at 40%, this fixture needed its colour
  shifted by -250K, tinted +20% towards green, and driven at 45%".
* a **colour** point -- "asked for pure red, this fixture needed its hue rotated
  +8 degrees, driven at 85% saturation and 55% brightness".

Whites are corrected along the blackbody curve; colours around the hue wheel.
They are stored in one list and told apart by a ``type`` key, which defaults to
white so profiles written before colour calibration existed still load.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from .color_math import (
    WHITE_TOLERANCE,
    blackbody_distance,
    clamp,
    corrected_rgb,
    hs_to_rgb,
    rgb_to_hs,
    rgb_to_kelvin,
)

TYPE_WHITE = "white"
TYPE_COLOR = "color"

# The six hue anchors, evenly spaced around the wheel.
COLOR_HUES = [0, 60, 120, 180, 240, 300]
COLOR_NAMES = {0: "red", 60: "yellow", 120: "green",
               180: "cyan", 240: "blue", 300: "magenta"}
COLOR_BRIGHTNESS = 60


def _white(kelvin: int, brightness: int) -> dict:
    return {"type": TYPE_WHITE, "kelvin": kelvin, "brightness": brightness}


def _color(hue: int, brightness: int = COLOR_BRIGHTNESS) -> dict:
    return {"type": TYPE_COLOR, "hue": hue, "brightness": brightness}


_QUICK = [_white(2700, 40), _white(2000, 40), _white(4000, 40),
          _white(2700, 10), _white(2700, 80)]
_STANDARD = [_white(k, b) for b in (40, 10, 80) for k in (2000, 2700, 4000)]
_THOROUGH = [_white(k, b) for b in (15, 45, 85)
             for k in (2000, 2400, 2700, 3200, 4000)]
_COLORS = [_color(h) for h in COLOR_HUES]

DEPTH_POINTS: dict[str, list[dict]] = {
    "colors": _COLORS,
    "quick": _QUICK,
    "standard": _STANDARD,
    "standard_color": _STANDARD + _COLORS,
    "thorough": _THOROUGH,
    "thorough_color": _THOROUGH + _COLORS,
}

DEPTH_LABELS = {
    "colors": "Colours only - 6 hues, about 5 minutes",
    "quick": "Quick - 5 whites, about 3 minutes",
    "standard": "Standard - 9 whites, about 8 minutes",
    "standard_color": "Standard + colours - 9 whites and 6 hues, about 13 minutes",
    "thorough": "Thorough - 15 whites, about 15 minutes",
    "thorough_color": "Thorough + colours - 15 whites and 6 hues, about 20 minutes",
}


@dataclass
class CalibrationPoint:
    """A white point: what this fixture needed at one colour temperature."""

    kelvin: int
    brightness: int
    kelvin_offset: float = 0.0
    tint: float = 0.0
    brightness_actual: float = 0.0

    def __post_init__(self) -> None:
        if not self.brightness_actual:
            self.brightness_actual = float(self.brightness)

    @property
    def brightness_scale(self) -> float:
        return self.brightness_actual / float(self.brightness or 1)

    def as_dict(self) -> dict:
        return {"type": TYPE_WHITE, **asdict(self)}

    @classmethod
    def from_dict(cls, data: dict) -> "CalibrationPoint":
        return cls(
            kelvin=int(data["kelvin"]),
            brightness=int(data["brightness"]),
            kelvin_offset=float(data.get("kelvin_offset", 0.0)),
            tint=float(data.get("tint", 0.0)),
            brightness_actual=float(data.get("brightness_actual", data["brightness"])),
        )


@dataclass
class ColorPoint:
    """A colour point: what this fixture needed at one hue.

    ``saturation`` is the absolute saturation the target had to be driven at
    while the reference sat at a fully saturated 100%.
    """

    hue: int
    brightness: int
    hue_shift: float = 0.0
    saturation: float = 100.0
    brightness_actual: float = 0.0

    def __post_init__(self) -> None:
        if not self.brightness_actual:
            self.brightness_actual = float(self.brightness)

    @property
    def brightness_scale(self) -> float:
        return self.brightness_actual / float(self.brightness or 1)

    @property
    def saturation_scale(self) -> float:
        return self.saturation / 100.0

    def as_dict(self) -> dict:
        return {"type": TYPE_COLOR, **asdict(self)}

    @classmethod
    def from_dict(cls, data: dict) -> "ColorPoint":
        return cls(
            hue=int(data["hue"]),
            brightness=int(data["brightness"]),
            hue_shift=float(data.get("hue_shift", 0.0)),
            saturation=float(data.get("saturation", 100.0)),
            brightness_actual=float(data.get("brightness_actual", data["brightness"])),
        )


def _hue_gap(a: float, b: float) -> float:
    """Shortest distance between two hues, in degrees."""
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


class CalibrationProfile:
    """Interpolates corrections across the calibrated points."""

    def __init__(
        self,
        points: list[CalibrationPoint],
        color_points: list[ColorPoint] | None = None,
    ) -> None:
        self.points = points
        self.color_points = color_points or []

    # ---------------------------------------------------------------- storage
    def as_list(self) -> list[dict]:
        return [p.as_dict() for p in self.points] + [
            c.as_dict() for c in self.color_points
        ]

    @classmethod
    def from_list(cls, data: list[dict] | None) -> "CalibrationProfile":
        whites: list[CalibrationPoint] = []
        colors: list[ColorPoint] = []
        for entry in data or []:
            # No type key means a profile written before colours existed.
            if entry.get("type") == TYPE_COLOR:
                colors.append(ColorPoint.from_dict(entry))
            else:
                whites.append(CalibrationPoint.from_dict(entry))
        return cls(whites, colors)

    @property
    def is_calibrated(self) -> bool:
        return bool(self.points or self.color_points)

    @property
    def has_color(self) -> bool:
        return bool(self.color_points)

    # ---------------------------------------------------------- interpolation
    def correction(self, kelvin: float, brightness: float) -> tuple[float, float, float]:
        """(kelvin_offset, tint, brightness_scale) for a white request.

        Inverse-distance weighted over the (kelvin, brightness) plane, both axes
        normalised first so neither dominates.
        """
        if not self.points:
            return (0.0, 0.0, 1.0)
        weighted: list[tuple[CalibrationPoint, float]] = []
        for point in self.points:
            dk = (kelvin - point.kelvin) / 1500.0
            db = (brightness - point.brightness) / 50.0
            dist_sq = dk * dk + db * db
            if dist_sq < 1e-9:
                weighted = [(point, 1.0)]
                break
            weighted.append((point, 1.0 / dist_sq))
        total = sum(w for _, w in weighted)
        return (
            sum(p.kelvin_offset * w for p, w in weighted) / total,
            sum(p.tint * w for p, w in weighted) / total,
            sum(p.brightness_scale * w for p, w in weighted) / total,
        )

    def color_correction(self, hue: float) -> tuple[float, float, float]:
        """(hue_shift, saturation_scale, brightness_scale) for a hue.

        Interpolated between the two measured hues either side, the short way
        round the wheel, so red sitting between magenta and yellow blends those
        two rather than being pulled by green on the far side.
        """
        pts = self.color_points
        if not pts:
            return (0.0, 1.0, 1.0)
        if len(pts) == 1:
            p = pts[0]
            return (p.hue_shift, p.saturation_scale, p.brightness_scale)

        ordered = sorted(pts, key=lambda p: p.hue)
        lower = max(
            (p for p in ordered if p.hue <= hue), key=lambda p: p.hue, default=None
        )
        upper = min(
            (p for p in ordered if p.hue >= hue), key=lambda p: p.hue, default=None
        )
        if lower is None:
            lower = ordered[-1]      # wrap below the smallest measured hue
        if upper is None:
            upper = ordered[0]       # wrap above the largest
        if lower is upper:
            return (lower.hue_shift, lower.saturation_scale, lower.brightness_scale)

        span = _hue_gap(lower.hue, upper.hue) or 1.0
        t = clamp(_hue_gap(lower.hue, hue) / span, 0.0, 1.0)
        blend = lambda a, b: a + (b - a) * t  # noqa: E731
        return (
            blend(lower.hue_shift, upper.hue_shift),
            blend(lower.saturation_scale, upper.saturation_scale),
            blend(lower.brightness_scale, upper.brightness_scale),
        )

    # -------------------------------------------------------------- the point
    def command_for_kelvin(
        self, kelvin: float, brightness: float
    ) -> tuple[tuple[int, int, int], int]:
        """Translate a white request into what the fixture should be sent."""
        offset, tint, scale = self.correction(kelvin, brightness)
        return corrected_rgb(kelvin, offset, tint), int(
            round(clamp(brightness * scale, 1, 100))
        )

    def command_for_rgb(
        self, rgb: tuple[int, int, int], brightness: float
    ) -> tuple[tuple[int, int, int], int]:
        """Translate an explicit RGB request.

        A near-white goes down the blackbody path. A saturated colour is
        corrected from the hue points if there are any, and otherwise passes
        through with its hue untouched -- projecting it onto the blackbody curve
        would collapse it (pure red and pure green both land on the 1000K floor
        and come out as the same orange).
        """
        if blackbody_distance(rgb) <= WHITE_TOLERANCE:
            return self.command_for_kelvin(rgb_to_kelvin(rgb), brightness)

        hue, sat = rgb_to_hs(rgb)

        if not self.color_points:
            _, _, scale = self.correction(rgb_to_kelvin(rgb), brightness)
            return rgb, int(round(clamp(brightness * scale, 1, 100)))

        shift, sat_scale, bright_scale = self.color_correction(hue)
        out = hs_to_rgb((hue + shift) % 360.0, clamp(sat * sat_scale, 0.0, 100.0))
        return out, int(round(clamp(brightness * bright_scale, 1, 100)))

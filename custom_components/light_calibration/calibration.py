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
    MAX_KELVIN,
    MIN_KELVIN,
    WHITE_TOLERANCE,
    blackbody_distance,
    _peak,
    apply_tint,
    apply_tint_v1,
    clamp,
    corrected_brightness_factor,
    corrected_rgb,
    hs_to_rgb,
    kelvin_to_rgb,
    relative_luminance,
    rgb_to_hs,
    rgb_to_kelvin,
)
from .const import TINT_MAX, TINT_MIN

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


def _serpentine(kelvins: tuple[int, ...], brightnesses: tuple[int, ...]) -> list[dict]:
    """Walk the grid so consecutive steps change as little as possible.

    The eye re-adapts on every jump, and re-adapting costs accuracy, so the
    kelvin sweep reverses on alternate rows rather than snapping back to the
    start. Brightness climbs steadily for the same reason.
    """
    steps: list[dict] = []
    for row, brightness in enumerate(brightnesses):
        order = kelvins if row % 2 == 0 else tuple(reversed(kelvins))
        steps += [_white(k, brightness) for k in order]
    return steps


_QUICK = [_white(2700, 40), _white(2000, 40), _white(4000, 40),
          _white(2700, 10), _white(2700, 80)]
_STANDARD = _serpentine((2000, 2700, 4000), (10, 40, 80))
_THOROUGH = _serpentine((2000, 2400, 2700, 3200, 4000), (15, 45, 85))
_COLORS = [_color(h) for h in COLOR_HUES]
# A fixture can be wrong about a colour differently at different levels -- red
# that runs dim at 20% but not at 80%. Measuring two levels is the only way to
# say so; the shorter colour depths still measure one, for time.
_COLORS_DEEP = [_color(h, b) for b in (25, 75) for h in COLOR_HUES]

DEPTH_POINTS: dict[str, list[dict]] = {
    "colors": _COLORS,
    "quick": _QUICK,
    "standard": _STANDARD,
    "standard_color": _STANDARD + _COLORS,
    "thorough": _THOROUGH,
    "thorough_color": _THOROUGH + _COLORS_DEEP,
}

DEPTH_LABELS = {
    "colors": "Colours only - 6 hues, about 5 minutes",
    "quick": "Quick - 5 whites, about 3 minutes",
    "standard": "Standard - 9 whites, about 8 minutes",
    "standard_color": "Standard + colours - 9 whites and 6 hues, about 13 minutes",
    "thorough": "Thorough - 15 whites, about 15 minutes",
    "thorough_color": "Thorough + colours - 15 whites and 12 hues, about 25 minutes",
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


# How far apart two measurements have to be before they stop informing each
# other. Both axes are divided by their span so neither dominates the distance.
KELVIN_SPAN = 1500.0
# Chosen so the full 1-100% range spans about the same distance as it did on the
# old linear scale, keeping the balance between the two axes where it was.
BRIGHTNESS_SPAN = (100.0 ** (1 / 3) - 1.0) / 2.0


def _brightness_axis(brightness: float) -> float:
    """Brightness on a roughly perceptual scale.

    10% to 20% is about three times the visible change of 70% to 80%. Measuring
    distance on the raw percentage therefore weights the dim end far too
    lightly -- which is exactly the end cheap fixtures get wrong.
    """
    return max(0.0, brightness) ** (1.0 / 3.0)


def migrate_white_point(data: dict) -> dict:
    """Re-express a white point measured against the pre-v2 tint model.

    The old model changed a colour's brightness as a side effect of tinting it,
    and the brightness dialled alongside silently absorbed the difference. The
    new one keeps the two apart, so a stored point has to be restated: the same
    green/magenta appearance under the new tint curve, and the brightness the
    old model was quietly contributing handed back explicitly.

    Approximate -- it assumes the fixture responds like sRGB, which no fixture
    exactly does -- but far closer than leaving the numbers as they are, and a
    re-run still fine-tunes from wherever this lands.
    """
    tint = float(data.get("tint", 0.0))
    if not tint:
        return dict(data)

    kelvin = int(data["kelvin"])
    offset = float(data.get("kelvin_offset", 0.0))
    brightness = int(data["brightness"])
    actual = float(data.get("brightness_actual", brightness))

    base = kelvin_to_rgb(kelvin + offset)
    was = _peak(apply_tint_v1(base, tint))

    # The nearest tint under the new curve, by colour. A scan rather than a
    # solve: the curve is cheap and this runs once per point, ever.
    # The old units were about three times as potent -- its red/blue
    # compensation amplified the green move once the result was normalised -- so
    # anything past a modest old tint lands outside what the slider can express.
    # Clamped rather than silently exceeded; the check at the end of a run shows
    # up anything that lost too much, and re-running fine-tunes from here.
    best, best_distance = 0.0, None
    step = int(TINT_MIN * 10)
    while step <= int(TINT_MAX * 10):
        candidate = apply_tint(base, step / 10.0)
        distance = max(abs(a - b) for a, b in zip(candidate, was))
        if best_distance is None or distance < best_distance:
            best, best_distance = step / 10.0, distance
        step += 5

    # Delivered brightness under the new pipeline is brightness x the untinted
    # luminance, so the old tint's contribution goes straight into brightness.
    reference = relative_luminance(_peak(base))
    scaled = actual * (relative_luminance(was) / reference if reference else 1.0)

    migrated = dict(data)
    migrated["tint"] = best
    migrated["brightness_actual"] = round(clamp(scaled, 1.0, 100.0), 1)
    return migrated


def _hue_gap(a: float, b: float) -> float:
    """Shortest distance between two hues, in degrees."""
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def _weighted_plane(
    weighted: list[tuple["CalibrationPoint", float]], value
) -> tuple[float, float, float] | None:
    """Weighted least-squares fit of ``value`` to a plane in (kelvin, brightness).

    Three normal equations solved by Gaussian elimination with partial pivoting.
    Returns None when the measured points do not span a plane -- every point at
    one colour temperature, say -- and the caller falls back to a plain average.
    """
    matrix = [[0.0] * 4 for _ in range(3)]
    for point, weight in weighted:
        row = (
            1.0,
            point.kelvin / KELVIN_SPAN,
            _brightness_axis(point.brightness) / BRIGHTNESS_SPAN,
        )
        y = value(point)
        for i in range(3):
            for j in range(3):
                matrix[i][j] += weight * row[i] * row[j]
            matrix[i][3] += weight * row[i] * y

    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(matrix[r][col]))
        if abs(matrix[pivot][col]) < 1e-9:
            return None
        matrix[col], matrix[pivot] = matrix[pivot], matrix[col]
        for row_i in range(3):
            if row_i != col:
                f = matrix[row_i][col] / matrix[col][col]
                for c in range(col, 4):
                    matrix[row_i][c] -= f * matrix[col][c]
    return tuple(matrix[i][3] / matrix[i][i] for i in range(3))


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
        """(kelvin_offset, tint, brightness_scale) for a white request."""
        if not self.points:
            return (0.0, 0.0, 1.0)
        return (
            self._fit(kelvin, brightness, lambda p: p.kelvin_offset),
            self._fit(kelvin, brightness, lambda p: p.tint),
            self._fit(kelvin, brightness, lambda p: p.brightness_scale),
        )

    def _fit(self, kelvin: float, brightness: float, value) -> float:
        """Distance-weighted local linear fit over the (kelvin, brightness) plane.

        Plain inverse-distance weighting has zero gradient at every measured
        point, so the surface plateaus at each one and has to swing between
        them; measured on a linear trend it was out by 23K in the middle of the
        Standard grid. Fitting a plane instead follows the trend, is exact when
        the response is linear in either axis, and averages out the scatter that
        matching by eye inevitably produces.

        Outside the measured points the query is pulled back to the edge of
        them. Extrapolating a fitted plane diverges -- 325K adrift at 6500K on a
        curved response -- and no correction anybody measured lives out there.
        Holding the last measured value is bounded and continuous.
        """
        points = self.points
        if len(points) == 1:
            return value(points[0])

        kelvins = [p.kelvin for p in points]
        brightnesses = [p.brightness for p in points]
        k = clamp(kelvin, min(kelvins), max(kelvins))
        b = _brightness_axis(clamp(brightness, min(brightnesses), max(brightnesses)))

        weighted: list[tuple[CalibrationPoint, float]] = []
        for point in points:
            dk = (k - point.kelvin) / KELVIN_SPAN
            db = (b - _brightness_axis(point.brightness)) / BRIGHTNESS_SPAN
            dist_sq = dk * dk + db * db
            if dist_sq < 1e-9:
                return value(point)
            weighted.append((point, 1.0 / dist_sq))

        mean = sum(value(p) * w for p, w in weighted) / sum(w for _, w in weighted)
        plane = _weighted_plane(weighted, value)
        if plane is None:
            return mean          # points all in a line: no plane to fit
        c0, ck, cb = plane
        return c0 + ck * (k / KELVIN_SPAN) + cb * (b / BRIGHTNESS_SPAN)

    def _at_hue(
        self, points: list[ColorPoint], brightness: float
    ) -> tuple[float, float, float]:
        """One hue's correction, blended over whatever levels were measured."""
        if len(points) == 1:
            p = points[0]
            return (p.hue_shift, p.saturation_scale, p.brightness_scale)
        ordered = sorted(points, key=lambda p: p.brightness)
        lower = max(
            (p for p in ordered if p.brightness <= brightness),
            key=lambda p: p.brightness, default=ordered[0],
        )
        upper = min(
            (p for p in ordered if p.brightness >= brightness),
            key=lambda p: p.brightness, default=ordered[-1],
        )
        if lower is upper:
            return (lower.hue_shift, lower.saturation_scale, lower.brightness_scale)
        span = _brightness_axis(upper.brightness) - _brightness_axis(lower.brightness)
        t = clamp(
            (_brightness_axis(brightness) - _brightness_axis(lower.brightness))
            / (span or 1.0), 0.0, 1.0,
        )
        return tuple(
            a + (b - a) * t
            for a, b in zip(
                (lower.hue_shift, lower.saturation_scale, lower.brightness_scale),
                (upper.hue_shift, upper.saturation_scale, upper.brightness_scale),
            )
        )

    def color_correction(
        self, hue: float, brightness: float = COLOR_BRIGHTNESS
    ) -> tuple[float, float, float]:
        """(hue_shift, saturation_scale, brightness_scale) for a hue.

        Interpolated between the two measured hues either side, the short way
        round the wheel, so red sitting between magenta and yellow blends those
        two rather than being pulled by green on the far side. Within each hue,
        blended over whatever brightness levels were measured there.
        """
        pts = self.color_points
        if not pts:
            return (0.0, 1.0, 1.0)

        by_hue: dict[int, list[ColorPoint]] = {}
        for p in pts:
            by_hue.setdefault(p.hue, []).append(p)
        hues = sorted(by_hue)
        if len(hues) == 1:
            return self._at_hue(by_hue[hues[0]], brightness)

        lower = max((h for h in hues if h <= hue), default=hues[-1])   # wraps below
        upper = min((h for h in hues if h >= hue), default=hues[0])    # wraps above
        if lower == upper:
            return self._at_hue(by_hue[lower], brightness)

        low = self._at_hue(by_hue[lower], brightness)
        high = self._at_hue(by_hue[upper], brightness)
        span = _hue_gap(lower, upper) or 1.0
        t = clamp(_hue_gap(lower, hue) / span, 0.0, 1.0)
        return tuple(a + (b - a) * t for a, b in zip(low, high))

    # -------------------------------------------------------------- the point
    def command_for_kelvin(
        self, kelvin: float, brightness: float
    ) -> tuple[tuple[int, int, int], int]:
        """Translate a white request into what the fixture should be sent."""
        offset, tint, scale = self.correction(kelvin, brightness)
        # Dividing by the tint's own brightness keeps the two axes independent:
        # a tinted white is delivered at the level that was asked for, not the
        # level the tint happened to bring with it.
        out = brightness * scale / corrected_brightness_factor(kelvin, offset, tint)
        return corrected_rgb(kelvin, offset, tint), int(round(clamp(out, 1, 100)))

    def kelvin_command_for_kelvin(
        self, kelvin: float, brightness: float
    ) -> tuple[int, int]:
        """Translate a white request for a fixture that can only take a kelvin.

        Tint is dropped, because a tunable-white fixture cannot render off the
        blackbody curve and there is nothing for it to apply to. The colour
        temperature offset and the brightness scale both still work, which is
        the part of a white miscalibration such a fixture can actually have.
        """
        offset, _tint, scale = self.correction(kelvin, brightness)
        return (
            int(round(clamp(kelvin + offset, MIN_KELVIN, MAX_KELVIN))),
            int(round(clamp(brightness * scale, 1, 100))),
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

        shift, sat_scale, bright_scale = self.color_correction(hue, brightness)
        out = hs_to_rgb((hue + shift) % 360.0, clamp(sat * sat_scale, 0.0, 100.0))
        return out, int(round(clamp(brightness * bright_scale, 1, 100)))

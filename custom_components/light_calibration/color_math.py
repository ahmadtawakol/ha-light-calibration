"""Colour maths for light calibration.

Everything here is pure and dependency-free so it can be unit tested without
Home Assistant.
"""
from __future__ import annotations

# Kelvin range we are willing to talk about.
MIN_KELVIN = 1000
MAX_KELVIN = 10000


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def kelvin_to_rgb(kelvin: float) -> tuple[int, int, int]:
    """Approximate a blackbody colour as sRGB.

    Tanner Helland's approximation, which is also what Home Assistant's own
    ``color_temperature_to_rgb`` computes. Reimplemented rather than imported so
    this module stays dependency-free, and pinned to core's output by the tests,
    so a calibrated light lines up with an uncalibrated one driven from the same
    kelvin.
    """
    kelvin = clamp(kelvin, MIN_KELVIN, MAX_KELVIN)
    t = kelvin / 100.0

    if t <= 66:
        red = 255.0
    else:
        red = 329.698727446 * ((t - 60) ** -0.1332047592)

    if t <= 66:
        green = 99.4708025861 * _ln(t) - 161.1195681661 if t > 0 else 0.0
    else:
        green = 288.1221695283 * ((t - 60) ** -0.0755148492)

    if t >= 66:
        blue = 255.0
    elif t <= 19:
        blue = 0.0
    else:
        blue = 138.5177312231 * _ln(t - 10) - 305.0447927307

    return (
        int(round(clamp(red, 0, 255))),
        int(round(clamp(green, 0, 255))),
        int(round(clamp(blue, 0, 255))),
    )


def _ln(x: float) -> float:
    import math

    return math.log(x) if x > 0 else 0.0


def _normalise(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    """Scale so the largest channel is 255, i.e. compare hue, not level."""
    peak = max(rgb) or 1
    return tuple(c * 255.0 / peak for c in rgb)


def rgb_to_kelvin(rgb: tuple[int, int, int]) -> float:
    """The kelvin whose blackbody colour is closest to ``rgb``.

    Done as a nearest-match search over the curve rather than a binary search on
    the blue/red ratio: below about 1900K the blue channel is zero for every
    temperature, so a ratio-based search cannot tell 1000K from 1900K and drags
    every deep warm white down to the floor.
    """
    def distance(kelvin: float) -> float:
        a, b = _normalise(rgb), _normalise(kelvin_to_rgb(kelvin))
        return max(abs(x - y) for x, y in zip(a, b))

    best = MIN_KELVIN
    best_d = float("inf")
    for kelvin in range(MIN_KELVIN, MAX_KELVIN + 1, 100):   # coarse
        d = distance(kelvin)
        if d < best_d:
            best, best_d = kelvin, d
    low = max(MIN_KELVIN, best - 100)
    high = min(MAX_KELVIN, best + 100)
    for kelvin in range(int(low), int(high) + 1, 5):        # refine
        d = distance(kelvin)
        if d < best_d:
            best, best_d = kelvin, d
    return float(best)


def blackbody_distance(rgb: tuple[int, int, int]) -> float:
    """How far ``rgb`` sits from the nearest white on the blackbody curve.

    Near zero for anything the eye reads as white (any colour temperature);
    large for saturated colours. This is what separates "a white that the
    calibration profile knows how to correct" from "an actual colour, which it
    must not touch".
    """
    nearest = kelvin_to_rgb(rgb_to_kelvin(rgb))
    a, b = _normalise(rgb), _normalise(nearest)
    return max(abs(x - y) for x, y in zip(a, b))


# Above this, treat the request as a real colour and leave its hue alone.
WHITE_TOLERANCE = 40.0


# Rec.709 luminance weights, the same ones sRGB is built on.
_LUMA = (0.2126, 0.7152, 0.0722)


def _to_linear(value: float) -> float:
    """Undo the sRGB transfer function. Channel maths has to happen in light."""
    c = value / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _to_srgb(value: float) -> float:
    c = clamp(value, 0.0, 1.0)
    encoded = c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055
    return encoded * 255.0


def relative_luminance(rgb: tuple[int, int, int]) -> float:
    """How bright a colour reads, 0..1, independent of its hue."""
    return sum(w * _to_linear(c) for w, c in zip(_LUMA, rgb))


def _peak(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """Scale so the largest channel is 255 -- the chromaticity on its own."""
    peak = max(rgb) or 1
    return tuple(min(255, int(round(c * 255.0 / peak))) for c in rgb)


def apply_tint(rgb: tuple[int, int, int], tint: float) -> tuple[int, int, int]:
    """Shift a colour along the green/magenta axis.

    ``tint`` is a percentage: positive adds green, negative adds magenta. This
    is the axis ordinary "warm/cool" cannot reach, and the one cheap RGB
    fixtures are usually wrong on -- a bulb that renders warm white with a
    purple cast is simply short of green. Scaling green in linear light and
    renormalising is the whole operation; red and blue are left alone, so it
    moves along one axis and one axis only.

    It deliberately does *not* try to hold brightness. Adding green genuinely
    makes a colour brighter: green carries 71% of luminance and the peak channel
    is pinned to the drive level, so no chromaticity is both greener and equally
    bright. An earlier model tried to compensate inside the colour and only
    moved the problem around -- brightness still swung by up to 29% across the
    slider. It is cancelled where it can actually be cancelled, in the
    brightness command: see ``tint_brightness_factor``.
    """
    if not tint:
        return rgb
    linear = [_to_linear(c) for c in rgb]
    linear[1] = max(0.0, linear[1] * (1.0 + tint / 100.0))
    peak = max(linear) or 1.0
    return tuple(int(round(_to_srgb(c / peak))) for c in linear)


def tint_brightness_factor(rgb: tuple[int, int, int], tint: float) -> float:
    """How much brighter the tinted colour renders at the same drive level.

    Divide a brightness command by this and the tint slider stops changing how
    bright the light looks, which is what lets the eye judge tint and brightness
    one at a time instead of chasing them round in circles.
    """
    before = relative_luminance(_peak(rgb))
    if before <= 0:
        return 1.0
    return relative_luminance(apply_tint(rgb, tint)) / before


def apply_tint_v1(rgb: tuple[int, int, int], tint: float) -> tuple[int, int, int]:
    """The tint model used before luminance was held constant.

    Kept only so stored profiles measured against it can be migrated -- see
    ``async_migrate_entry``. Nothing else should call this.
    """
    if not tint:
        return rgb
    red, green, blue = rgb
    green = clamp(green * (1.0 + tint / 100.0), 0, 255)
    comp = 1.0 - (tint / 100.0) * 0.25
    return (
        int(round(clamp(red * comp, 0, 255))),
        int(round(green)),
        int(round(clamp(blue * comp, 0, 255))),
    )


def split_level(rgb: tuple[int, int, int]) -> tuple[tuple[int, int, int], float]:
    """Separate a requested colour from the level it was asked at.

    ``rgb_color`` conventionally describes a colour and nothing else, with
    brightness carrying the level -- which is why an integration reports it with
    its largest channel at full. Storing a request verbatim instead makes a dim
    red indistinguishable from a dark one, and anything reading the state back
    has to guess: a dashboard icon tinted from ``(80, 0, 0)`` comes out very
    nearly black.

    The correction path already ignores the level, so keeping it in the colour
    also meant a dim request drove the fixture at full and only *reported* itself
    dim. Returns the colour at full level and the level it was carrying.
    """
    peak = max(rgb)
    if not peak:
        return rgb, 0.0
    return (
        tuple(int(round(c * 255.0 / peak)) for c in rgb),
        peak / 255.0,
    )


def rgb_to_hs(rgb: tuple[int, int, int]) -> tuple[float, float]:
    """Hue in degrees and saturation in percent. Level is carried separately."""
    h, _, s = _hls(rgb)
    return h, s


def _hls(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    import colorsys

    r, g, b = (c / 255.0 for c in rgb)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return h * 360.0, v * 100.0, s * 100.0


def hs_to_rgb(hue: float, saturation: float) -> tuple[int, int, int]:
    """Build a fully-bright colour from hue (degrees) and saturation (percent).

    Level is deliberately maxed: Home Assistant carries brightness separately,
    so the colour channel should describe hue and saturation only.
    """
    import colorsys

    r, g, b = colorsys.hsv_to_rgb(
        (hue % 360.0) / 360.0, clamp(saturation, 0.0, 100.0) / 100.0, 1.0
    )
    return (
        int(round(clamp(r * 255, 0, 255))),
        int(round(clamp(g * 255, 0, 255))),
        int(round(clamp(b * 255, 0, 255))),
    )


def corrected_rgb(kelvin: float, kelvin_offset: float, tint: float) -> tuple[int, int, int]:
    """The RGB command that makes a miscalibrated light look like ``kelvin``."""
    return apply_tint(kelvin_to_rgb(kelvin + kelvin_offset), tint)


def corrected_brightness_factor(kelvin: float, kelvin_offset: float, tint: float) -> float:
    """The companion to ``corrected_rgb``: divide brightness by this.

    Cancels the brightness the tint brings with it, so the two axes stay
    independent both while calibrating and when driving the light afterwards.
    """
    return tint_brightness_factor(kelvin_to_rgb(kelvin + kelvin_offset), tint)

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

    Tanner Helland's approximation. Good enough for lamp matching and, more
    importantly, it is the same curve Adaptive Lighting uses, so a calibrated
    light lines up with an uncalibrated one driven from the same kelvin.
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


def apply_tint(rgb: tuple[int, int, int], tint: float) -> tuple[int, int, int]:
    """Shift a colour along the green/magenta axis.

    ``tint`` is a percentage: positive adds green, negative adds magenta
    (i.e. removes green). This is the axis ordinary "warm/cool" cannot reach,
    and the one cheap RGB fixtures are usually wrong on -- a bulb that renders
    warm white with a purple cast is simply short of green.
    """
    if not tint:
        return rgb
    red, green, blue = rgb
    factor = 1.0 + (tint / 100.0)
    green = clamp(green * factor, 0, 255)
    # Compensate red/blue slightly so overall level stays put; a pure green
    # boost would also read as "brighter", which would fight the brightness axis.
    comp = 1.0 - (tint / 100.0) * 0.25
    red = clamp(red * comp, 0, 255)
    blue = clamp(blue * comp, 0, 255)
    return (int(round(red)), int(round(green)), int(round(blue)))


def rgb_to_hs(rgb: tuple[int, int, int]) -> tuple[float, float]:
    """Hue in degrees and saturation in percent. Level is carried separately."""
    import colorsys

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

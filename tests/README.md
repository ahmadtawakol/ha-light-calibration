# Tests

`color_math.py` and `calibration.py` are pure and dependency-free, so these run
offline with no Home Assistant checkout.

```bash
uv run --with pytest pytest tests/
```

`conftest.py` loads the two modules straight from their files into a synthetic
`light_calibration` package. Importing them the normal way would run the real
package `__init__.py` first, which imports Home Assistant.

Most of what is asserted here is a regression. The specific values are load
bearing: the `kelvin_to_rgb` anchors pin this module to Home Assistant's own
colour utility,
and the routing and hue-wrap tests pin bugs that made the light show the wrong
colour entirely.

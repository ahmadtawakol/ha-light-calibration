"""Load the pure modules without pulling in Home Assistant.

``custom_components/light_calibration/__init__.py`` imports Home Assistant, and
importing a submodule normally runs the package ``__init__`` first. So the two
dependency-free modules are loaded straight from their files into a synthetic
``light_calibration`` package -- enough for ``calibration.py``'s
``from .color_math import ...`` to resolve, and nothing else is needed.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

PACKAGE = "light_calibration"
COMPONENT = Path(__file__).resolve().parents[1] / "custom_components" / PACKAGE


def _load(name: str) -> None:
    spec = importlib.util.spec_from_file_location(
        f"{PACKAGE}.{name}", COMPONENT / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)


if PACKAGE not in sys.modules:
    package = types.ModuleType(PACKAGE)
    package.__path__ = [str(COMPONENT)]
    sys.modules[PACKAGE] = package
    _load("color_math")      # first: calibration imports from it
    _load("calibration")

"""A switch to turn the calibration itself on and off.

The point is comparison: flip it while the light is on and the fixture jumps
between its raw output and the corrected one, so you can see exactly what the
calibration bought you.
"""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import CONF_POINTS, DOMAIN
from .entity import CalibrationControlEntity
from .session import CalibrationSession


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    session: CalibrationSession = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([CalibrationSwitch(entry, session)])


class CalibrationSwitch(CalibrationControlEntity, SwitchEntity, RestoreEntity):
    _attr_name = "Calibration"
    _attr_icon = "mdi:eyedropper-variant"

    def __init__(self, entry: ConfigEntry, session: CalibrationSession) -> None:
        super().__init__(entry, session, "enabled")

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if (last := await self.async_get_last_state()) is not None:
            await self._session.async_set_enabled(last.state == "on")

    @property
    def is_on(self) -> bool:
        return self._session.enabled

    @property
    def available(self) -> bool:
        # Nothing to turn on or off until there is a profile.
        return bool(self._entry.data.get(CONF_POINTS))

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._session.async_set_enabled(True)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._session.async_set_enabled(False)
        self.async_write_ha_state()

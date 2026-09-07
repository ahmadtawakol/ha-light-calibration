"""Shared base for the calibration control entities."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .session import CalibrationSession


class CalibrationControlEntity(Entity):
    """Base for the sliders, buttons and status sensor.

    They all live on one device page alongside the calibrated light, so the
    whole calibration happens in a single place.
    """

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry: ConfigEntry, session: CalibrationSession, key: str) -> None:
        self._entry = entry
        self._session = session
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Light Calibration",
            model="Calibrated light",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._session.add_listener(self._handle_update))

    def _handle_update(self) -> None:
        self.async_write_ha_state()

"""Light Calibration: drive a badly-behaved light so it matches a good one."""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path

import voluptuous as vol

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_ORIGINAL_ID,
    CONF_POINTS,
    CONF_REFERENCE,
    CONF_RENAMED_ID,
    CONF_TARGET,
    DOMAIN,
)
from .calibration import DEPTH_POINTS
from .session import CalibrationSession

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# The light, a status sensor, and a switch to compare raw vs corrected output.
# The calibration controls themselves live in the dialog, not as entities.
PLATFORMS = [Platform.LIGHT, Platform.SENSOR, Platform.SWITCH]

CARD_BASE = "/light_calibration"
CARD_FILE = "light-calibration-card.js"
PANEL_URL_PATH = "light-calibration"
PANEL_COMPONENT = "light-calibration-panel"

SERVICE_START = "start_calibration"
SERVICE_ADJUST = "adjust"
SERVICE_SAVE = "save_point"
SERVICE_BACK = "previous_point"
SERVICE_CANCEL = "cancel_calibration"
SERVICE_SET_REFERENCE = "set_reference"
SERVICE_CLEAR = "clear_profile"
SERVICE_FINISH = "finish_calibration"

_ENTRY = vol.Schema({vol.Required("entry_id"): cv.string})
_ADJUST = _ENTRY.extend(
    {
        vol.Optional("warm_cool"): vol.Coerce(float),
        vol.Optional("green_magenta"): vol.Coerce(float),
        vol.Optional("brightness"): vol.Coerce(float),
        vol.Optional("hue_shift"): vol.Coerce(float),
        vol.Optional("saturation"): vol.Coerce(float),
    }
)
_START = _ENTRY.extend({vol.Optional("depth"): vol.In(list(DEPTH_POINTS))})
_SET_REFERENCE = _ENTRY.extend({vol.Required("entity_id"): cv.entity_id})


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the dialog card and the calibration services."""
    await _async_register_card(hass)
    _async_register_services(hass)
    return True


async def _async_register_card(hass: HomeAssistant) -> str:
    """Serve the frontend module and load it, with no manual resource setup.

    The URL carries a hash of the file contents. Home Assistant is commonly
    behind a CDN (a Cloudflare tunnel here) that happily caches .js for hours,
    which silently serves a stale module after an update -- the symptom is a
    blank panel, because the custom element the page needs was defined in a
    build the browser never received. A content-addressed URL cannot go stale.
    """
    path = Path(__file__).parent / "www" / CARD_FILE
    raw = await hass.async_add_executor_job(path.read_bytes)
    digest = hashlib.sha1(raw).hexdigest()[:10]
    url = f"{CARD_BASE}/{digest}/{CARD_FILE}"

    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(url, str(path), False)]
        )
    except RuntimeError:
        pass  # already registered (a reload)
    frontend.add_extra_js_url(hass, url)
    _LOGGER.debug("Registered calibration frontend at %s", url)
    await _async_register_panel(hass, url)
    return url


async def _async_register_panel(hass: HomeAssistant, module_url: str) -> None:
    """Register the calibration panel.

    ``config_panel_domain`` is what makes the integration's Configure button open
    this panel instead of an options-flow form, so calibration is reachable from
    Settings without putting a card on a dashboard. Older cores do not accept the
    argument; fall back to a plain panel so the page still exists.
    """
    kwargs = dict(
        webcomponent_name=PANEL_COMPONENT,
        frontend_url_path=PANEL_URL_PATH,
        module_url=module_url,
        embed_iframe=False,
        require_admin=True,
    )
    # Drop any previous registration so a new module hash actually takes effect.
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    try:
        await panel_custom.async_register_panel(
            hass, config_panel_domain=DOMAIN, **kwargs
        )
    except TypeError:
        _LOGGER.warning(
            "This core does not support config_panel_domain; the calibration "
            "page is still at /%s", PANEL_URL_PATH
        )
        try:
            await panel_custom.async_register_panel(hass, **kwargs)
        except ValueError:
            pass
    except ValueError:
        pass  # already registered


def _async_register_services(hass: HomeAssistant) -> None:
    def _session(call: ServiceCall) -> CalibrationSession | None:
        return hass.data.get(DOMAIN, {}).get(call.data["entry_id"])

    async def _start(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_start(call.data.get("depth"))

    async def _adjust(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_set_values(
                warm_cool=call.data.get("warm_cool"),
                tint=call.data.get("green_magenta"),
                brightness=call.data.get("brightness"),
                hue_shift=call.data.get("hue_shift"),
                saturation=call.data.get("saturation"),
            )

    async def _save(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_next()

    async def _back(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_back()

    async def _finish(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_finish()

    async def _cancel(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_cancel()

    async def _set_reference(call: ServiceCall) -> None:
        entry = hass.config_entries.async_get_entry(call.data["entry_id"])
        if entry:
            hass.config_entries.async_update_entry(
                entry, data={**entry.data, CONF_REFERENCE: call.data["entity_id"]}
            )

    async def _clear(call: ServiceCall) -> None:
        entry = hass.config_entries.async_get_entry(call.data["entry_id"])
        if entry:
            hass.config_entries.async_update_entry(
                entry, data={**entry.data, CONF_POINTS: []}
            )

    for name, handler, schema in (
        (SERVICE_START, _start, _START),
        (SERVICE_ADJUST, _adjust, _ADJUST),
        (SERVICE_SAVE, _save, _ENTRY),
        (SERVICE_BACK, _back, _ENTRY),
        (SERVICE_CANCEL, _cancel, _ENTRY),
        (SERVICE_FINISH, _finish, _ENTRY),
        (SERVICE_SET_REFERENCE, _set_reference, _SET_REFERENCE),
        (SERVICE_CLEAR, _clear, _ENTRY),
    ):
        if not hass.services.has_service(DOMAIN, name):
            hass.services.async_register(DOMAIN, name, handler, schema=schema)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a calibrated light from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    await _async_register_card(hass)
    _async_register_services(hass)
    await _async_prepare_takeover(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = CalibrationSession(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Give the original light its entity_id back."""
    original = entry.data.get(CONF_ORIGINAL_ID)
    renamed = entry.data.get(CONF_RENAMED_ID)
    if not original or not renamed:
        return
    registry = er.async_get(hass)
    if registry.async_get(renamed) is None:
        return
    if registry.async_get(original) is not None:
        registry.async_update_entity(original, new_entity_id=f"{original}_removing")
    registry.async_update_entity(renamed, new_entity_id=original)
    _LOGGER.info("Restored %s to the original light", original)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_prepare_takeover(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Move the real light aside so the virtual one can claim its entity_id."""
    original = entry.data.get(CONF_ORIGINAL_ID)
    renamed = entry.data.get(CONF_RENAMED_ID)
    if not original or not renamed or original == renamed:
        return

    registry = er.async_get(hass)
    if registry.async_get(renamed) is not None:
        return  # already moved

    if registry.async_get(original) is None:
        _LOGGER.warning("Cannot take over %s: entity not in the registry", original)
        return

    registry.async_update_entity(original, new_entity_id=renamed)
    _LOGGER.info("Moved %s aside to %s for calibration takeover", original, renamed)

    if entry.data.get(CONF_TARGET) != renamed:
        hass.config_entries.async_update_entry(
            entry, data={**entry.data, CONF_TARGET: renamed}
        )

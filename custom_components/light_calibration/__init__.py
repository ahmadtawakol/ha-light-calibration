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
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ConfigEntryError
from homeassistant.helpers import (
    config_validation as cv,
    device_registry as dr,
    entity_registry as er,
)
from homeassistant.helpers.typing import ConfigType

from .const import (
    CONF_ORIGINAL_ID,
    CONF_POINTS,
    CONF_REFERENCE,
    CONF_RENAMED_ID,
    CONF_TARGET,
    DOMAIN,
)
from .calibration import DEPTH_POINTS, TYPE_WHITE, migrate_white_point
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
SERVICE_COMPARE = "compare"

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

    async def _compare(call: ServiceCall) -> None:
        if session := _session(call):
            await session.async_compare()

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
        (SERVICE_COMPARE, _compare, _ENTRY),
        (SERVICE_SET_REFERENCE, _set_reference, _SET_REFERENCE),
        (SERVICE_CLEAR, _clear, _ENTRY),
    ):
        if not hass.services.has_service(DOMAIN, name):
            hass.services.async_register(DOMAIN, name, handler, schema=schema)


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Bring a profile measured against the old tint model up to date.

    Tint used to change a colour's brightness as a side effect, and the
    brightness dialled alongside absorbed the difference. Now the two are
    independent, so every stored point that carries a tint has to be restated or
    it would come out both the wrong colour and the wrong brightness.
    """
    if entry.version != 1:
        return False
    if entry.minor_version < 2:
        points = entry.data.get(CONF_POINTS) or []
        migrated = [
            migrate_white_point(p) if p.get("type", TYPE_WHITE) == TYPE_WHITE else p
            for p in points
        ]
        changed = sum(1 for a, b in zip(points, migrated) if a != b)
        if changed:
            _LOGGER.info(
                "%s: restated %d of %d calibration points for the new tint model. "
                "The colours should look as they did; a Quick re-run will "
                "fine-tune anything that drifted",
                entry.title, changed, len(points),
            )
        hass.config_entries.async_update_entry(
            entry, data={**entry.data, CONF_POINTS: migrated}, minor_version=2
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a calibrated light from a config entry."""
    hass.data.setdefault(DOMAIN, {})
    await _async_register_card(hass)
    _async_register_services(hass)
    if not await _async_prepare_takeover(hass, entry):
        raise ConfigEntryError(
            f"{entry.data.get(CONF_ORIGINAL_ID)} is not in the entity registry, so "
            "its entity_id cannot be taken over. The light has to be one Home "
            "Assistant can rename -- a YAML light or a light group cannot be."
        )
    _async_hide_raw(hass, entry)
    hass.data[DOMAIN][entry.entry_id] = CalibrationSession(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _async_adopt_area(hass, entry)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # A reload throws the session away, and with it the snapshot that puts the
    # lights back -- so anything that updates the entry mid-calibration (setting
    # a reference, clearing the profile) would strand both lights at whatever
    # step they were on. Cancel first, while both are still reachable.
    session: CalibrationSession | None = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    if session and session.active:
        await session.async_cancel()
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
    raw = registry.async_get(renamed)
    if raw is None:
        return
    if registry.async_get(original) is not None:
        registry.async_update_entity(original, new_entity_id=f"{original}_removing")
    updates: dict = {"new_entity_id": original}
    if raw.hidden_by is er.RegistryEntryHider.INTEGRATION:
        updates["hidden_by"] = None      # only ever unhide our own hiding
    registry.async_update_entity(renamed, **updates)
    _LOGGER.info("Restored %s to the original light", original)


@callback
def _async_hide_raw(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Keep the displaced real light out of the pickers.

    Two near-identical lights everywhere is the main confusion this integration
    creates, and the ``_raw`` one is an implementation detail -- hidden it still
    works and is still reachable, it just stops being offered.

    Runs on every setup rather than only at takeover, so entries created before
    this existed get hidden too. Marked INTEGRATION rather than USER so removal
    can tell our hiding from the user's and undo only our own.
    """
    renamed = entry.data.get(CONF_RENAMED_ID)
    if not renamed:
        return
    raw = er.async_get(hass).async_get(renamed)
    if raw is None or raw.hidden_by is not None:
        return
    er.async_get(hass).async_update_entity(
        renamed, hidden_by=er.RegistryEntryHider.INTEGRATION
    )
    _LOGGER.info("Hid %s; %s is the one to use", renamed, entry.data.get(CONF_ORIGINAL_ID))


@callback
def _async_effective_area(hass: HomeAssistant, entity_id: str) -> str | None:
    """The area an entity actually shows up in.

    An entity usually has no area of its own and inherits its device's, so both
    have to be consulted -- reading only ``entry.area_id`` finds nothing for most
    real lights.
    """
    entity = er.async_get(hass).async_get(entity_id)
    if entity is None:
        return None
    if entity.area_id:
        return entity.area_id
    if entity.device_id:
        device = dr.async_get(hass).async_get(entity.device_id)
        if device:
            return device.area_id
    return None


@callback
def _async_adopt_area(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Put the calibrated light where the light it replaced was.

    The virtual light lives on its own device, which starts with no area, so
    without this a calibrated light silently drops out of its room -- area
    cards, "turn off the kitchen", and voice all stop finding it.

    Set on the device so the status sensor and switch come along too, and only
    when it has no area yet, so moving it afterwards sticks.
    """
    renamed = entry.data.get(CONF_RENAMED_ID)
    if not renamed:
        return
    area_id = _async_effective_area(hass, renamed)
    if not area_id:
        return
    devices = dr.async_get(hass)
    device = devices.async_get_device(identifiers={(DOMAIN, entry.entry_id)})
    if device is None or device.area_id is not None:
        return
    devices.async_update_device(device.id, area_id=area_id)
    _LOGGER.info("Placed %s in area %s, following %s", entry.title, area_id, renamed)


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_prepare_takeover(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Move the real light aside so the virtual one can claim its entity_id.

    Returns False when the takeover cannot happen, which has to fail the whole
    entry: carrying on would leave the virtual light claiming an entity_id the
    real one still holds -- core renames ours to _2 -- while it drives a target
    that never existed. Every command then goes nowhere, silently.
    """
    original = entry.data.get(CONF_ORIGINAL_ID)
    renamed = entry.data.get(CONF_RENAMED_ID)
    if not original or not renamed or original == renamed:
        return False

    registry = er.async_get(hass)
    if registry.async_get(renamed) is not None:
        return True  # already moved

    if registry.async_get(original) is None:
        _LOGGER.warning("Cannot take over %s: entity not in the registry", original)
        return False

    registry.async_update_entity(original, new_entity_id=renamed)
    _LOGGER.info("Moved %s aside to %s for calibration takeover", original, renamed)

    if entry.data.get(CONF_TARGET) != renamed:
        hass.config_entries.async_update_entry(
            entry, data={**entry.data, CONF_TARGET: renamed}
        )
    return True

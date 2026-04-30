"""Command filtering to block dangerous commands before execution.

Loads blocklist from DB settings (dynamic) with fallback to hardcoded defaults.
Only applies to the /execute API endpoint (not the interactive terminal,
where commands are typed character by character and harder to filter).
"""

import re
import logging

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("citadel.filter")

# Hardcoded fallback patterns (used when DB is not available)
DEFAULT_PATTERNS = [
    r"rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/\s*$",
    r"rm\s+-[a-zA-Z]*f[a-zA-Z]*\s+/",
    r"mkfs\.",
    r"dd\s+.*of=/dev/[sh]d",
    r":\s*\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;",
    r"shutdown\s",
    r"reboot\s*$",
    r"init\s+0",
    r"halt\s*$",
    r"poweroff",
    r">\s*/dev/[sh]d",
    r"chmod\s+(-[a-zA-Z]+\s+)?777\s+/",
    r"chown\s+.*\s+/\s*$",
    r"wget\s+.*\|\s*sh",
    r"curl\s+.*\|\s*sh",
    r"curl\s+.*\|\s*bash",
]


async def check_command(command: str, db: AsyncSession) -> tuple[bool, str]:
    """Check if a command is allowed.

    Loads patterns and enabled flag from DB settings.
    Returns (allowed, reason).
    """
    from app.services.settings_service import get_setting_bool, get_setting_json

    stripped = command.strip()
    if not stripped:
        return False, "Empty command"

    # Check if filtering is enabled
    enabled = await get_setting_bool(db, "command_filter_enabled")
    if not enabled:
        return True, "OK (filter disabled)"

    # Load patterns from DB (falls back to defaults)
    try:
        patterns = await get_setting_json(db, "command_blocklist")
        if not isinstance(patterns, list) or len(patterns) == 0:
            patterns = DEFAULT_PATTERNS
    except Exception:
        patterns = DEFAULT_PATTERNS

    # Check command against patterns
    for pattern_str in patterns:
        try:
            pattern = re.compile(pattern_str, re.IGNORECASE)
            if pattern.search(stripped):
                logger.warning("Blocked command: %s (pattern: %s)", stripped[:100], pattern_str[:50])
                return False, f"Command blocked by security policy"
        except re.error:
            continue  # Skip invalid regex

    return True, "OK"

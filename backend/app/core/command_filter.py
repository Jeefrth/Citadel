"""Command filtering to block dangerous commands before execution.

Only applies to the /execute API endpoint (not the interactive terminal,
where commands are typed character by character and harder to filter).
"""

import re
import logging

logger = logging.getLogger("srv_gest.filter")

# Patterns that match dangerous commands (case-insensitive)
BLOCKED_PATTERNS = [
    r"rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/\s*$",    # rm -rf /
    r"rm\s+-[a-zA-Z]*f[a-zA-Z]*\s+/",              # rm -rf /anything
    r"mkfs\.",                                       # mkfs.ext4 etc
    r"dd\s+.*of=/dev/[sh]d",                        # dd of=/dev/sda
    r":\s*\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;",       # fork bomb :(){ :|:& };
    r"shutdown\s",                                   # shutdown
    r"reboot\s*$",                                   # reboot
    r"init\s+0",                                     # init 0
    r"halt\s*$",                                     # halt
    r"poweroff",                                     # poweroff
    r">\s*/dev/[sh]d",                               # > /dev/sda
    r"chmod\s+(-[a-zA-Z]+\s+)?777\s+/",            # chmod 777 /
    r"chown\s+.*\s+/\s*$",                          # chown ... /
    r"wget\s+.*\|\s*sh",                            # wget ... | sh
    r"curl\s+.*\|\s*sh",                            # curl ... | sh
    r"curl\s+.*\|\s*bash",                          # curl ... | bash
]

_compiled = [re.compile(p, re.IGNORECASE) for p in BLOCKED_PATTERNS]


def check_command(command: str) -> tuple[bool, str]:
    """Check if a command is allowed.

    Returns (allowed, reason).
    """
    stripped = command.strip()

    if not stripped:
        return False, "Empty command"

    for pattern in _compiled:
        if pattern.search(stripped):
            logger.warning("Blocked dangerous command: %s", stripped[:100])
            return False, f"Command blocked by security policy: matches dangerous pattern"

    return True, "OK"

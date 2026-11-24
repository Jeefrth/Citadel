"""Data masking in terminal output (lot 7).

Admin rules (Paramètres > Masquage): a regular expression and a replacement,
applied to everything the server prints before it reaches the user, the live
monitor and the recording. A masked secret is never stored.

Best effort: matching is done per output chunk, so a value split across two
chunks (rare for short tokens, possible for long ones) can slip through.
"""

import json
import logging
import re
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("citadel.masking")
SETTING_KEY = "data_masking_rules"
MAX_RULES = 50

PRESETS = {
    "card": {"name": "Numéro de carte", "pattern": r"\b(?:\d[ -]?){12,15}\d\b", "replacement": "****-****-****-****"},
    "password_assign": {"name": "Mot de passe affiché", "pattern": r"(?i)(pass(?:word|wd)?\s*[:=]\s*)\S+",
                        "replacement": r"\1********"},
    "bearer": {"name": "Jeton Bearer", "pattern": r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{16,}", "replacement": r"\1********"},
    "private_key": {"name": "Clé privée", "pattern": r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)",
                    "replacement": "[clé privée masquée]"},
    "aws_key": {"name": "Clé AWS", "pattern": r"\bAKIA[0-9A-Z]{16}\b", "replacement": "AKIA****************"},
}


@dataclass
class Rule:
    name: str
    regex: re.Pattern
    replacement: str


def validate_rules(raw: list) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_RULES:
        raise ValueError(f"Une liste de {MAX_RULES} règles au plus est attendue")
    out = []
    for r in raw:
        if not isinstance(r, dict):
            raise ValueError("Chaque règle est un objet {name, pattern, replacement, enabled}")
        name, pattern = str(r.get("name", "")).strip()[:100], str(r.get("pattern", ""))
        replacement = str(r.get("replacement", "********"))[:200]
        if not name or not pattern or len(pattern) > 500:
            raise ValueError(f"Règle « {name or '?'} » : nom et motif (500 caractères au plus) obligatoires")
        try:
            rx = re.compile(pattern)
            rx.sub(replacement, "test 4111 1111 1111 1111 password=abc")
        except (re.error, IndexError) as e:
            raise ValueError(f"Règle « {name} » : expression invalide ({e})")
        out.append({"name": name, "pattern": pattern, "replacement": replacement, "enabled": bool(r.get("enabled", True))})
    return out


class Masker:
    def __init__(self, rules: list[Rule]):
        self.rules = rules
        self.hits = 0

    def __bool__(self) -> bool:
        return bool(self.rules)

    def apply(self, data: bytes) -> bytes:
        if not self.rules:
            return data
        text = data.decode("utf-8", errors="surrogateescape")
        for r in self.rules:
            text, n = r.regex.subn(r.replacement, text)
            self.hits += n
        return text.encode("utf-8", errors="surrogateescape")


def build(rules: list[dict]) -> Masker:
    compiled = []
    for r in rules or []:
        if not r.get("enabled", True):
            continue
        try:
            compiled.append(Rule(r["name"], re.compile(r["pattern"]), r.get("replacement", "********")))
        except (re.error, KeyError):
            logger.warning("ignoring invalid masking rule %r", r.get("name"))
    return Masker(compiled)


async def load(db: AsyncSession) -> Masker:
    from app.services.settings_service import get_setting
    try:
        return build(json.loads(await get_setting(db, SETTING_KEY) or "[]"))
    except (ValueError, TypeError):
        logger.warning("invalid %s setting, masking disabled", SETTING_KEY)
        return Masker([])

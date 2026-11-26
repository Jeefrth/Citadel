"""Per-organisation policies (SaaS phase 2)."""
from app.services.org_policy import ip_allowed, parse_allowlist


def test_empty_allowlist_allows_everyone():
    assert ip_allowed("203.0.113.5", parse_allowlist([]))
    assert ip_allowed(None, [])


def test_allowlist_ranges_and_single_addresses():
    nets = parse_allowlist(["10.0.0.0/8", "203.0.113.7", "2001:db8::/32", "garbage"])
    assert len(nets) == 3
    assert ip_allowed("10.1.2.3", nets) and ip_allowed("203.0.113.7", nets) and ip_allowed("2001:db8::1", nets)
    assert not ip_allowed("203.0.113.8", nets)
    assert ip_allowed("::ffff:10.0.0.1", nets)          # IPv4-mapped
    assert not ip_allowed(None, nets) and not ip_allowed("not-an-ip", nets)   # fail closed

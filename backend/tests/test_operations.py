"""Unit tests for lot 5 helpers (no network): Azure parsing, routing, SFTP paths."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app.services import cloud_sync, routing, sftp

SUB = "11111111-2222-3333-4444-555555555555"
VM_ID = f"/subscriptions/{SUB}/resourceGroups/RG-Web/providers/Microsoft.Compute/virtualMachines/web-01"
NIC_ID = f"/subscriptions/{SUB}/resourceGroups/RG-Web/providers/Microsoft.Network/networkInterfaces/web-01-nic"
PIP_ID = f"/subscriptions/{SUB}/resourceGroups/RG-Web/providers/Microsoft.Network/publicIPAddresses/web-01-pip"


def azure_handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if "oauth2/v2.0/token" in url:
        assert b"client_credentials" in request.content
        return httpx.Response(200, json={"access_token": "tok"})
    assert request.headers["Authorization"] == "Bearer tok"
    if "virtualMachines" in url and "statusOnly=true" in url:
        return httpx.Response(200, json={"value": [{"id": VM_ID, "properties": {"instanceView": {"statuses": [
            {"code": "ProvisioningState/succeeded"}, {"code": "PowerState/running"}]}}}]})
    if "virtualMachines" in url:
        if "page=2" in url:
            return httpx.Response(200, json={"value": []})
        return httpx.Response(200, json={"value": [{
            "id": VM_ID, "name": "web-01", "location": "switzerlandnorth", "tags": {"env": "prod"},
            "properties": {"osProfile": {"computerName": "WEB01"},
                           "storageProfile": {"osDisk": {"osType": "Linux"}},
                           "networkProfile": {"networkInterfaces": [{"id": NIC_ID, "properties": {"primary": True}}]}},
        }], "nextLink": url + "&page=2"})
    if "networkInterfaces" in url:
        return httpx.Response(200, json={"value": [{"id": NIC_ID, "properties": {"ipConfigurations": [
            {"properties": {"primary": True, "privateIPAddress": "10.1.0.4", "publicIPAddress": {"id": PIP_ID}}}]}}]})
    if "publicIPAddresses" in url:
        return httpx.Response(200, json={"value": [{"id": PIP_ID, "properties": {"ipAddress": "51.107.1.2"}}]})
    return httpx.Response(404, text=url)


def test_fetch_vms_maps_ips_power_and_pagination():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(azure_handler)) as client:
            return await cloud_sync.fetch_vms(client, {"tenant_id": "t", "client_id": "c", "subscription_ids": [SUB]}, "s")
    vms = asyncio.run(run())
    assert len(vms) == 1
    vm = vms[0]
    assert (vm.name, vm.computer_name, vm.resource_group) == ("web-01", "WEB01", "RG-Web")
    assert (vm.private_ip, vm.public_ip, vm.power_state, vm.os_type) == ("10.1.0.4", "51.107.1.2", "running", "Linux")
    assert vm.tags == {"env": "prod"}


def test_azure_auth_error_is_explicit():
    def deny(request):
        return httpx.Response(401, json={"error": "invalid_client"})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(deny)) as client:
            await cloud_sync.fetch_vms(client, {"tenant_id": "t", "client_id": "c", "subscription_ids": [SUB]}, "s")
    with pytest.raises(RuntimeError, match="authentication failed"):
        asyncio.run(run())


def test_routing_is_direct_without_zone():
    server = SimpleNamespace(ip_address="10.0.0.1", zone=None)

    async def run():
        async with routing.via(server):
            return await routing.tcp_endpoint("10.0.0.1", 5985), await routing.tunnel_for("10.0.0.1")
    assert asyncio.run(run()) == (("10.0.0.1", 5985), None)


def test_routing_orders_active_gateways_by_priority():
    gw = lambda name, prio, active=True: SimpleNamespace(  # noqa: E731
        id=name, name=name, host=f"{name}.example", port=22, username="jump", credential=None,
        use_cert=True, priority=prio, is_active=active)
    server = SimpleNamespace(ip_address="10.9.0.1", zone=SimpleNamespace(gateways=[gw("b", 20), gw("a", 5), gw("off", 1, False)]))
    assert [g.name for g in routing.gateways_of(server)] == ["a", "b"]


def test_routing_context_is_scoped_to_the_block():
    gw = SimpleNamespace(id="g", name="g", host="h", port=22, username="u", credential=None, use_cert=True,
                         priority=1, is_active=True)
    server = SimpleNamespace(ip_address="10.9.0.2", zone=SimpleNamespace(gateways=[gw]))

    async def run():
        async with routing.via(server):
            inside = routing._state("10.9.0.2") is not None
        return inside, routing._state("10.9.0.2") is None
    assert asyncio.run(run()) == (True, True)


@pytest.mark.parametrize("raw,expected", [
    ("", ""), (None, ""), ("/tmp/../etc/./passwd", "/etc/passwd"), ("tmp/x", "/tmp/x"), ("//a//b/", "/a/b"),
])
def test_clean_path(raw, expected):
    assert sftp.clean_path(raw) == expected


def test_clean_path_rejects_nul():
    with pytest.raises(sftp.SftpError):
        sftp.clean_path("/tmp/a\x00b")

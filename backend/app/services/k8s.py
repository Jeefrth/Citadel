"""Kubernetes client (lot 8): REST calls and container exec, with a service
account token. Reached directly or through the zone's SSH gateway (local port
forward, TLS still checked against the real API host name).

Rights are Citadel's (services.k8s_access); the token only needs what Citadel
offers: get/list/watch on namespaces, pods, pods/log, events, deployments,
statefulsets, daemonsets; create on pods/exec; delete on pods; patch on
deployments/statefulsets (and their scale). See docs/kubernetes.md.
"""

import asyncio
import fnmatch
import json
import re
import ssl
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx
import websockets

from app.core.security import decrypt_value
from app.models.kubernetes import K8sCluster
from app.services import routing

WORKLOAD_KINDS = {"deployments": "apps/v1", "statefulsets": "apps/v1", "daemonsets": "apps/v1"}
NAME = r"^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$"


class K8sError(RuntimeError):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _ssl_context(cluster: K8sCluster) -> ssl.SSLContext:
    if cluster.skip_tls_verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    if cluster.ca_cert:
        return ssl.create_default_context(cadata=cluster.ca_cert)
    return ssl.create_default_context()


def _token(cluster: K8sCluster) -> str:
    if not cluster.encrypted_token:
        raise K8sError("Aucun jeton de compte de service enregistré pour ce cluster", 400)
    return decrypt_value(cluster.encrypted_token)


@asynccontextmanager
async def _endpoint(cluster: K8sCluster):
    """(scheme, connect_host, connect_port, real_host) for the API, gateway-aware."""
    host, port = cluster.ip_address, cluster.api_port
    scheme = "https" if cluster.api_url.startswith("https") else "http"
    async with routing.via(cluster):
        h, p = await routing.tcp_endpoint(host, port)
        yield scheme, h, p, host


async def request(cluster: K8sCluster, method: str, path: str, *, params: dict | None = None,
                  json_body=None, content_type: str | None = None, timeout: float = 20, raw: bool = False):
    async with _endpoint(cluster) as (scheme, h, p, host):
        headers = {"Authorization": f"Bearer {_token(cluster)}", "Accept": "application/json",
                   "Host": f"{host}:{cluster.api_port}"}
        if content_type:
            headers["Content-Type"] = content_type
        ext = {"sni_hostname": host} if h != host else {}
        async with httpx.AsyncClient(verify=_ssl_context(cluster), timeout=timeout) as client:
            try:
                r = await client.request(method, f"{scheme}://{h}:{p}{path}", params=params, headers=headers,
                                         content=json.dumps(json_body) if json_body is not None else None,
                                         extensions=ext)
            except httpx.HTTPError as e:
                raise K8sError(f"API Kubernetes injoignable : {type(e).__name__}: {e}")
    if r.status_code >= 400:
        try:
            msg = r.json().get("message") or r.text
        except ValueError:
            msg = r.text
        raise K8sError(f"Kubernetes {r.status_code} : {msg[:400]}", 403 if r.status_code in (401, 403) else
                       404 if r.status_code == 404 else 502)
    return r.text if raw else r.json()


# ── reads ──

def _age(ts: str | None) -> int | None:
    if not ts:
        return None
    try:
        return int((datetime.now(timezone.utc) - datetime.fromisoformat(ts.replace("Z", "+00:00"))).total_seconds())
    except ValueError:
        return None


async def version(cluster: K8sCluster) -> str:
    v = await request(cluster, "GET", "/version")
    return v.get("gitVersion", "?")


async def namespaces(cluster: K8sCluster) -> list[dict]:
    data = await request(cluster, "GET", "/api/v1/namespaces")
    return [{"name": n["metadata"]["name"], "status": (n.get("status") or {}).get("phase"),
             "age_seconds": _age(n["metadata"].get("creationTimestamp"))} for n in data.get("items", [])]


def _pod(p: dict) -> dict:
    st = p.get("status") or {}
    cs = st.get("containerStatuses") or []
    return {
        "name": p["metadata"]["name"], "namespace": p["metadata"]["namespace"],
        "phase": st.get("phase"), "node": (p.get("spec") or {}).get("nodeName"), "ip": st.get("podIP"),
        "ready": f"{sum(1 for c in cs if c.get('ready'))}/{len(cs) or len((p.get('spec') or {}).get('containers', []))}",
        "restarts": sum(c.get("restartCount", 0) for c in cs),
        "containers": [c["name"] for c in (p.get("spec") or {}).get("containers", [])],
        "reason": next((((c.get("state") or {}).get("waiting") or {}).get("reason") for c in cs
                        if (c.get("state") or {}).get("waiting")), None),
        "owner": next(({"kind": o.get("kind"), "name": o.get("name")} for o in p["metadata"].get("ownerReferences") or []), None),
        "age_seconds": _age(p["metadata"].get("creationTimestamp")),
    }


async def pods(cluster: K8sCluster, ns: str) -> list[dict]:
    data = await request(cluster, "GET", f"/api/v1/namespaces/{ns}/pods")
    return sorted((_pod(p) for p in data.get("items", [])), key=lambda x: x["name"])


async def workloads(cluster: K8sCluster, ns: str) -> list[dict]:
    out = []
    for kind in WORKLOAD_KINDS:
        data = await request(cluster, "GET", f"/apis/apps/v1/namespaces/{ns}/{kind}")
        for w in data.get("items", []):
            spec, st = w.get("spec") or {}, w.get("status") or {}
            desired = spec.get("replicas") if kind != "daemonsets" else st.get("desiredNumberScheduled")
            ready = st.get("readyReplicas") if kind != "daemonsets" else st.get("numberReady")
            out.append({"kind": kind, "name": w["metadata"]["name"], "namespace": ns, "desired": desired or 0,
                        "ready": ready or 0, "images": [c.get("image") for c in ((spec.get("template") or {}).get("spec") or {}).get("containers", [])],
                        "age_seconds": _age(w["metadata"].get("creationTimestamp"))})
    return out


async def events(cluster: K8sCluster, ns: str) -> list[dict]:
    data = await request(cluster, "GET", f"/api/v1/namespaces/{ns}/events")
    items = [{"type": e.get("type"), "reason": e.get("reason"), "message": e.get("message"),
              "object": f"{(e.get('involvedObject') or {}).get('kind')}/{(e.get('involvedObject') or {}).get('name')}",
              "count": e.get("count"), "last_seen": e.get("lastTimestamp") or e.get("eventTime")}
             for e in data.get("items", [])]
    return sorted(items, key=lambda x: x["last_seen"] or "", reverse=True)[:200]


async def logs(cluster: K8sCluster, ns: str, pod: str, container: str | None, tail: int, previous: bool) -> str:
    params = {"tailLines": tail, "timestamps": "true"}
    if container:
        params["container"] = container
    if previous:
        params["previous"] = "true"
    return await request(cluster, "GET", f"/api/v1/namespaces/{ns}/pods/{pod}/log", params=params, raw=True, timeout=30)


async def pod_containers(cluster: K8sCluster, ns: str, pod: str) -> list[str]:
    p = await request(cluster, "GET", f"/api/v1/namespaces/{ns}/pods/{pod}")
    return [c["name"] for c in (p.get("spec") or {}).get("containers", [])]


# ── changes ──

async def delete_pod(cluster: K8sCluster, ns: str, pod: str) -> None:
    await request(cluster, "DELETE", f"/api/v1/namespaces/{ns}/pods/{pod}")


async def scale(cluster: K8sCluster, ns: str, kind: str, name: str, replicas: int) -> None:
    if kind not in ("deployments", "statefulsets"):
        raise K8sError("Seuls les deployments et statefulsets se mettent à l'échelle", 400)
    await request(cluster, "PATCH", f"/apis/apps/v1/namespaces/{ns}/{kind}/{name}/scale",
                  json_body={"spec": {"replicas": replicas}}, content_type="application/merge-patch+json")


async def rollout_restart(cluster: K8sCluster, ns: str, kind: str, name: str) -> None:
    if kind not in WORKLOAD_KINDS:
        raise K8sError("Type de charge inconnu", 400)
    stamp = datetime.now(timezone.utc).isoformat()
    await request(cluster, "PATCH", f"/apis/apps/v1/namespaces/{ns}/{kind}/{name}",
                  json_body={"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": stamp}}}}},
                  content_type="application/strategic-merge-patch+json")


# ── exec (interactive shell in a container) ──

SHELL = ["/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"]


class ExecChannel:
    """A TargetChannel (services.terminal_core) over the Kubernetes exec WebSocket
    (v4.channel.k8s.io: 1st byte = stream, 0 stdin, 1 stdout, 2 stderr, 3 status, 4 resize)."""

    def __init__(self, ws, session_id: str):
        self.ws = ws
        self.session_id = session_id
        self.status: dict | None = None

    async def read(self):
        while True:
            try:
                msg = await self.ws.recv()
            except websockets.ConnectionClosed:
                return None
            if isinstance(msg, str):
                msg = msg.encode()
            if not msg:
                continue
            chan, data = msg[0], msg[1:]
            if chan in (1, 2):
                if data:
                    return data
            elif chan == 3:
                try:
                    self.status = json.loads(data or b"{}")
                except ValueError:
                    pass

    async def write(self, data: bytes):
        await self.ws.send(b"\x00" + data)

    async def resize(self, cols: int, rows: int):
        await self.ws.send(b"\x04" + json.dumps({"Width": cols, "Height": rows}).encode())

    async def close(self):
        try:
            await self.ws.close()
        except Exception:  # noqa: BLE001
            pass


async def open_exec(cluster: K8sCluster, ns: str, pod: str, container: str, cols: int, rows: int) -> ExecChannel:
    """Call inside routing.via(cluster) (run_session does it)."""
    host, port = cluster.ip_address, cluster.api_port
    h, p = await routing.tcp_endpoint(host, port)
    q = [("container", container), ("stdin", "true"), ("stdout", "true"), ("stderr", "true"), ("tty", "true")]
    q += [("command", c) for c in SHELL]
    scheme = "wss" if cluster.api_url.startswith("https") else "ws"
    uri = f"{scheme}://{host}:{port}/api/v1/namespaces/{ns}/pods/{pod}/exec?{urlencode(q)}"
    kwargs = {"additional_headers": {"Authorization": f"Bearer {_token(cluster)}"},
              "subprotocols": ["v4.channel.k8s.io"], "max_size": 2 ** 22, "open_timeout": 15}
    if scheme == "wss":
        kwargs["ssl"] = _ssl_context(cluster)
        kwargs["server_hostname"] = host
    if (h, p) != (host, port):
        kwargs.update(host=h, port=p)
    try:
        ws = await websockets.connect(uri, **kwargs)
    except Exception as e:  # noqa: BLE001
        raise K8sError(f"Exec impossible : {type(e).__name__}: {e}")
    ch = ExecChannel(ws, f"k8s-{uuid.uuid4().hex[:16]}")
    await ch.resize(cols, rows)
    return ch


def ns_allowed(patterns: set[str], ns: str) -> bool:
    return any(p == "*" or fnmatch.fnmatchcase(ns, p) for p in patterns)

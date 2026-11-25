#!/usr/bin/env bash
# Citadel test lab: disposable targets on the compose network, for docs/plan-de-test.md.
#   scripts/test-lab.sh up [--rdp]   start the lab (RDP desktop optional: ~1 GB image)
#   scripts/test-lab.sh provision    register the lab in Citadel (nodes, credentials, zone, servers, cluster, rules)
#   scripts/test-lab.sh users        create lab users (operator, viewer, custom role) + access keys
#   scripts/test-lab.sh pause        stop the lab containers (state kept, Citadel unchanged)
#   scripts/test-lab.sh resume       start them again (same k3s token, nothing to re-provision)
#   scripts/test-lab.sh status       show targets and credentials
#   scripts/test-lab.sh down         remove everything (containers, isolated network, data/lab)
# Never point this at production: passwords are fixed and printed.
set -euo pipefail
cd "$(dirname "$0")/.."

NET=citadel_default
ISO=citadel_lab_isolated
OUT=data/lab
K3S_IMAGE=rancher/k3s:v1.31.4-k3s1
RDP_IMAGE=scottyhardy/docker-remote-desktop:latest
CONTAINERS="lab-linux lab-linux2 lab-gw lab-isolated lab-k3s lab-rdp"

pw_admin="Lab-Admin-2026"
pw_user="Lab-User-2026"
pw_gw="Lab-Gw-2026"

jf_login() {
  docker compose exec -T db psql -U "${POSTGRES_USER:-citadel}" -d "${POSTGRES_DB:-citadel}" -tAc \
    "select split_part(email,'@',1) from users where role='ADMIN' and email like '%@%' order by created_at limit 1" 2>/dev/null | head -1
}

ca_pubkey() {
  docker compose exec -T backend python -c "from app.services import ca_service; print(ca_service.get_ca_public_key().strip())" 2>/dev/null | tail -1
}

ssh_target() { # name network users [extra env...]
  local name=$1 net=$2 users=$3; shift 3
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --hostname "$name" --network "$net" --restart unless-stopped \
    -e LAB_USERS="$users" -e LAB_CA_PUBKEY="$(ca_pubkey)" "$@" citadel-lab-ssh >/dev/null
}

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || { echo "Start Citadel first (docker compose up -d)"; exit 1; }
  echo "Building the Linux target image (cached after the first time)..."
  docker build -q -t citadel-lab-ssh -f scripts/lab/Dockerfile.ssh scripts/lab >/dev/null
  docker network inspect "$ISO" >/dev/null 2>&1 || docker network create --internal "$ISO" >/dev/null
  local me; me=$(jf_login)
  local users="deploy:$pw_admin:yes alice:$pw_user:no"
  [ -n "$me" ] && users="$users $me:-:no"
  ssh_target lab-linux "$NET" "$users"
  ssh_target lab-linux2 "$NET" "$users"
  ssh_target lab-isolated "$ISO" "deploy:$pw_admin:yes"
  ssh_target lab-gw "$NET" "gw:$pw_gw:no" -e LAB_GATEWAY=1
  docker network connect "$ISO" lab-gw 2>/dev/null || true

  echo "Starting k3s..."
  docker rm -f lab-k3s >/dev/null 2>&1 || true
  docker run -d --name lab-k3s --hostname lab-k3s --network "$NET" --privileged --restart unless-stopped \
    "$K3S_IMAGE" server --disable traefik --disable metrics-server --tls-san lab-k3s >/dev/null
  for _ in $(seq 1 60); do docker exec lab-k3s kubectl get nodes 2>/dev/null | grep -q " Ready" && break; sleep 3; done
  docker cp deploy/kubernetes/citadel-rbac.yaml lab-k3s:/tmp/rbac.yaml
  docker exec lab-k3s sh -c '
    kubectl apply -f /tmp/rbac.yaml >/dev/null
    for ns in demo prod team-a; do kubectl create ns $ns >/dev/null 2>&1 || true; done
    kubectl -n demo create deployment web --image=nginx:1.27-alpine --replicas=2 >/dev/null 2>&1 || true
    kubectl -n demo create deployment worker --image=busybox:1.36 -- sh -c "while true; do echo job ok password=hunter2 token=Bearer abcdefghijklmnopqrstu; sleep 5; done" >/dev/null 2>&1 || true
    kubectl -n prod create deployment api --image=nginx:1.27-alpine --replicas=3 >/dev/null 2>&1 || true
    kubectl -n prod create deployment broken --image=nginx:does-not-exist >/dev/null 2>&1 || true
    kubectl -n team-a create deployment app --image=busybox:1.36 -- sleep 100000 >/dev/null 2>&1 || true'
  mkdir -p "$OUT" && chmod 700 "$OUT"
  for _ in $(seq 1 20); do docker exec lab-k3s kubectl -n citadel-system get secret citadel-token -o jsonpath='{.data.token}' 2>/dev/null | grep -q . && break; sleep 2; done
  docker exec lab-k3s sh -c 'kubectl -n citadel-system get secret citadel-token -o jsonpath="{.data.token}" | base64 -d' > "$OUT/k3s.token"
  docker exec lab-k3s sh -c 'kubectl -n citadel-system get secret citadel-token -o jsonpath="{.data.ca\.crt}" | base64 -d' > "$OUT/k3s-ca.crt"
  chmod 600 "$OUT"/k3s.*

  if [ "${1:-}" = "--rdp" ]; then
    echo "Starting the RDP desktop (large image)..."
    docker rm -f lab-rdp >/dev/null 2>&1 || true
    docker run -d --name lab-rdp --hostname lab-rdp --network "$NET" --shm-size=1g --restart unless-stopped "$RDP_IMAGE" >/dev/null
  fi
  status
}

status() {
  local me; me=$(jf_login)
  cat <<TXT

Citadel test lab (hostnames resolve from the Citadel backend)

  Linux        lab-linux, lab-linux2 : port 22
                 deploy / $pw_admin   (sudo without password: use as the DEFAULT account)
                 alice  / $pw_user    (no sudo)
                 ${me:-<your login>}  (no password: @USER with an ephemeral certificate, CA trusted)
  Isolated     lab-isolated : port 22, ONLY reachable through the gateway
                 deploy / $pw_admin   (put it in a zone)
  Gateway      lab-gw : port 22, gw / $pw_gw (AllowTcpForwarding yes)
  Kubernetes   https://lab-k3s:6443
                 token : $OUT/k3s.token     CA : $OUT/k3s-ca.crt
                 namespaces demo (web, worker with secrets in its logs), prod (api, broken), team-a (app)
  RDP          lab-rdp : port 3389, ubuntu / ubuntu   (only with "up --rdp")
  Not covered  Windows / WinRM targets (none in the lab)

TXT
  docker ps --filter "name=lab-" --format '  {{.Names}}\t{{.Status}}'
}

provision() {
  [ -f "$OUT/k3s.token" ] || { echo "Start the lab first: scripts/test-lab.sh up"; exit 1; }
  docker compose cp scripts/lab/provision.py backend:/tmp/lab_provision.py >/dev/null 2>&1
  docker compose cp "$OUT/k3s.token" backend:/tmp/k3s.token >/dev/null 2>&1
  docker compose cp "$OUT/k3s-ca.crt" backend:/tmp/k3s-ca.crt >/dev/null 2>&1
  docker compose exec -T backend python /tmp/lab_provision.py
  docker compose exec -T backend rm -f /tmp/k3s.token /tmp/lab_provision.py
}

users() {
  mkdir -p "$OUT" && chmod 700 "$OUT"
  docker compose cp scripts/lab/lab_users.py backend:/tmp/lab_users.py >/dev/null 2>&1
  docker compose exec -T backend python /tmp/lab_users.py > "$OUT/keys.txt"
  chmod 600 "$OUT/keys.txt"
  echo "Lab users (key = Authorization: Bearer <key> on http://localhost:${BACKEND_PORT:-8010}/api):"
  column -t -s $'\t' "$OUT/keys.txt"
}

pause() {
  for c in $CONTAINERS; do docker stop "$c" >/dev/null 2>&1 && echo "  $c en pause"; done
  echo "Labo en pause. Reprise : scripts/test-lab.sh resume"
}

resume() {
  for c in $CONTAINERS; do docker start "$c" >/dev/null 2>&1 && echo "  $c relancé"; done
  for _ in $(seq 1 40); do docker exec lab-k3s kubectl get nodes 2>/dev/null | grep -q " Ready" && break; sleep 3; done
  echo "Labo relancé (k3s prêt)."
}

down() {
  docker compose cp scripts/lab/lab_users.py backend:/tmp/lab_users.py >/dev/null 2>&1 \
    && docker compose exec -T backend python /tmp/lab_users.py --down || true
  for c in $CONTAINERS; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$ISO" >/dev/null 2>&1 || true
  rm -rf "$OUT"
  echo "Lab removed. Remove the lab servers / cluster in Citadel too (or keep them for the next run)."
}

case "${1:-}" in
  up) shift; up "$@" ;;
  provision) provision ;;
  users) users ;;
  pause) pause ;;
  resume) resume ;;
  status) status ;;
  down) down ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac

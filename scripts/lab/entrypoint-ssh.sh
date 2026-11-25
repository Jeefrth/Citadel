#!/bin/sh
# LAB_USERS: "name:password:sudo" separated by spaces (sudo = yes|no)
# LAB_CA_PUBKEY: Citadel SSH CA public key (for @USER / ephemeral certificates)
# LAB_GATEWAY=1: allow TCP forwarding (SSH gateway)
set -e
for spec in $LAB_USERS; do
  name=$(echo "$spec" | cut -d: -f1); pw=$(echo "$spec" | cut -d: -f2); su=$(echo "$spec" | cut -d: -f3)
  id -u "$name" >/dev/null 2>&1 || useradd -m -s /bin/bash "$name"
  if [ -n "$pw" ] && [ "$pw" != "-" ]; then echo "$name:$pw" | chpasswd; else usermod -p '*' "$name"; fi
  if [ "$su" = "yes" ]; then echo "$name ALL=(ALL) NOPASSWD: ALL" > "/etc/sudoers.d/lab-$name"; chmod 440 "/etc/sudoers.d/lab-$name"; fi
done
if [ -n "$LAB_CA_PUBKEY" ]; then
  echo "$LAB_CA_PUBKEY" > /etc/ssh/citadel_ca.pub
  grep -q TrustedUserCAKeys /etc/ssh/sshd_config || echo "TrustedUserCAKeys /etc/ssh/citadel_ca.pub" >> /etc/ssh/sshd_config
fi
if [ "$LAB_GATEWAY" = "1" ]; then
  sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
fi
echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e

# OpenBao server for Citadel (single node, integrated Raft storage).
# TLS is disabled because the listener is only reachable on the internal
# compose network (dev also publishes it on 127.0.0.1). For a remote vault,
# enable TLS and set VAULT_CACERT on the backend.
ui            = true
disable_mlock = true
api_addr      = "http://openbao:8200"
cluster_addr  = "http://openbao:8201"

storage "raft" {
  path    = "/openbao/file"
  node_id = "citadel-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

# Production: replace manual unsealing with auto-unseal, e.g. Azure Key Vault
# seal "azurekeyvault" {
#   tenant_id  = "<tenant>"
#   vault_name = "<key-vault>"
#   key_name   = "citadel-unseal"
# }

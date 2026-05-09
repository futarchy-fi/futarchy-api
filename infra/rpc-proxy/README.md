# rpc-proxy

A Python HTTP proxy that sits between the futarchy checkpoint indexers and a
pool of upstream JSON-RPC endpoints. Solves three classes of failure that come
from running indexers against free, load-balanced public RPCs:

1. **Tip-buffer**: subtracts a per-chain offset from `eth_blockNumber` so the
   indexer never queries a block that hasn't propagated to every upstream.
2. **Failover pool**: rotates through multiple upstreams; transient errors,
   timeouts, null results on recent blocks, and infra-level error strings
   (`too large`, `rate`, `throttl`, …) trigger the next RPC.
3. **Hash pinning**: caches `eth_getBlockByNumber` / `eth_getBlockByHash`
   responses for a short TTL so two upstreams disagreeing about the tip-edge
   block hash can't trigger a reorg-detection loop in the indexer.

See the docstring at the top of `rpc_proxy.py` for the full rationale.

## Layout

- `rpc_proxy.py` — the proxy. One process, one thread per chain, listens on
  `8545` (Gnosis) and `8546` (Mainnet).
- `rpc-proxy.service` — systemd unit. Drops privileges, sets the env-file
  hook, hardens the process.

## Configuration

All tunables are environment variables (defaults are safe):

| Variable | Default | Purpose |
|---|---|---|
| `RPC_PROXY_TIP_BUFFER_GNOSIS` | `20` | Blocks to subtract from Gnosis tip |
| `RPC_PROXY_TIP_BUFFER_MAINNET` | `5` | Blocks to subtract from Mainnet tip |
| `RPC_PROXY_HASH_PIN_TTL` | `30` | Seconds to pin a block-lookup response |
| `RPC_PROXY_REQUEST_TIMEOUT` | `15` | Per-upstream request timeout (s) |
| `GNOSIS_QUICKNODE_RPC_URL` | _(unset)_ | If set, prepended to Gnosis pool |
| `MAINNET_INFURA_RPC_URL` | _(unset)_ | If set, prepended to Mainnet pool |

Defaults live in the systemd unit; secrets (paid RPC URLs) belong in
`/etc/futarchy-rpc-proxy.env` (mode `0600`) so they don't end up in git.

## Deploy (indexer VM)

```sh
# 1. Copy the proxy and unit to the VM
scp infra/rpc-proxy/rpc_proxy.py     <vm>:/tmp/rpc_proxy.py
scp infra/rpc-proxy/rpc-proxy.service <vm>:/tmp/rpc-proxy.service

# 2. Install
ssh <vm> '
  sudo mkdir -p /opt/futarchy-rpc-proxy &&
  sudo mv /tmp/rpc_proxy.py /opt/futarchy-rpc-proxy/ &&
  sudo mv /tmp/rpc-proxy.service /etc/systemd/system/rpc-proxy.service &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now rpc-proxy.service
'

# 3. Verify
ssh <vm> 'curl -s http://127.0.0.1:8545/stats | jq'
ssh <vm> 'sudo journalctl -u rpc-proxy -n 50 --no-pager'
```

Indexer containers reach the proxy at `http://172.17.0.1:8545` (the docker
bridge gateway) when running on the same host.

## /stats

`GET /stats` on either port returns counters for hash-pin hits, failovers,
and per-upstream call/error counts — useful for spotting a degraded RPC.

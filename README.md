# Futarchy API Reference (`api.futarchy.fi`)

This repository serves as the official documentation and public reference for all available endpoints on the `api.futarchy.fi` infrastructure. 

The API Gateway natively routes traffic to 4 underlying services:
1. **Charts API** (`/charts/*`)
2. **TWAP API** (`/*`) — *Root path catch-all*
3. **Registry Indexer** (`/registry/*`)
4. **Candles Indexer** (`/candles/*`)

---

## 🌎 Public Access & Authentication
The `api.futarchy.fi` API Gateway is **fully public**. 

Internally, the backend servers require an `X-Futarchy-Secret` header to block direct/malicious IP access. However, **the AWS API Gateway automatically injects this secret header** into your requests before sending them to the backend. 

This means **frontend clients, developers, and users DO NOT need to provide any secret header** when making requests to `api.futarchy.fi`.

---

## 1. Charts API (`/charts/*`)
*Used to render the unified price charts and handle market events.*

### `GET /charts/api/v2/proposals/:proposalId/chart`
Fetches the unified chart data for a specific proposal (combines registry metadata, candle historical data, and spot prices).
- **Query Params:**
  - `minTimestamp` (optional): Start UNIX timestamp.
  - `maxTimestamp` (optional): End UNIX timestamp.
  - `includeSpot` (optional, boolean): Set to `false` to exclude external Spot price fetching (avoids rate limits). Default is `true`.
- **Example:**
  ```bash
  curl "https://api.futarchy.fi/charts/api/v2/proposals/0x09cb43.../chart?includeSpot=false"
  ```

### `GET /charts/api/v1/spot-candles`
Fetches spot price candles directly from GeckoTerminal. Rate-limited by GeckoTerminal.
- **Query Params:**
  - `ticker` (required): The Coingecko/Geckoterminal ticker ID. Supports `composite::` syntax for rate providers.
  - `minTimestamp` (optional)
  - `maxTimestamp` (optional)

### `GET /charts/warmer`
Returns the status of the background chart caching warmer.
- **Example:** `curl https://api.futarchy.fi/charts/warmer`

### `POST /charts/subgraphs/name/algebra-proposal-candles-v1`
Legacy GraphQL proxy to the Algebra subgraph. Kept for backward compatibility.


---

## 2. TWAP API (Root `/`)
*Used to calculate Time-Weighted Average Prices directly from the blockchain state.*

### `GET /twap/:chainId/:proposalAddress`
Calculates the TWAP logic over a specified time window for a given proposal.
- **Path Params:**
  - `chainId`: e.g., `100` (Gnosis) or `1` (Mainnet).
  - `proposalAddress`: The 0x address of the Kleros/Futarchy proposal.
- **Query Params:**
  - `endTimestamp` (optional): The market close time (Unix). Defaults to "now".
  - `days` (optional): The TWAP window in days looking backward from the end timestamp. Defaults to `5`.
- **Example:**
  ```bash
  # Calculate 5-day TWAP looking back from NOW
  curl "https://api.futarchy.fi/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"
  
  # Calculate 5-day TWAP looking back from a specific date
  curl "https://api.futarchy.fi/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc?endTimestamp=1738886400&days=5"
  ```

### `GET /pools/:chainId/:proposalAddress`
Discovers and returns all 6 pool addresses associated with a proposal.
- **Example:**
  ```bash
  curl "https://api.futarchy.fi/pools/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"
  ```

### `GET /health`
Returns the uptime and health status of the TWAP service.

---

## 3. Subgraph Indexers (Registry & Candles)
*Used to query indexed blockchain data via GraphQL.*

Both endpoints accept standard GraphQL `POST` requests.

### Registry Indexer
- **Endpoint:** `POST /registry/graphql`
- **Purpose:** Queries proposal metadata, market conditions, and organizational data.
- **Example:**
  ```bash
  curl -X POST "https://api.futarchy.fi/registry/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ _metadatas(where: { id: \"last_indexed_block\" }) { value } }"}'
  ```

### Candles Indexer
- **Endpoint:** `POST /candles/graphql`
- **Purpose:** Queries historical OHLCV candle data from the automated market makers.
- **Example:**
  ```bash
  curl -X POST "https://api.futarchy.fi/candles/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ _metadatas { id value } }"}'
  ```

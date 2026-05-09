/**
 * Extract company + currency token symbols from a pool's `name` field.
 *
 * Pool naming conventions by type:
 *   CONDITIONAL     "YES_GNO / YES_sDAI"  → company=GNO, currency=sDAI
 *   EXPECTED_VALUE  "YES_GNO / sDAI"      → company=GNO, currency=sDAI
 *   PREDICTION      "YES_sDAI / sDAI"     → currency=sDAI, company=unknown
 *
 * Walks the pool list in priority order (CONDITIONAL > EXPECTED_VALUE >
 * PREDICTION) so we extract the company symbol from the most informative
 * pool present. Returns { companyToken, currencyToken } where each is
 * either { id: null, symbol: 'X' } or null when unknown.
 */

const PATTERNS = [
    // CONDITIONAL: both sides prefixed with YES_/NO_
    /^(?:YES|NO)_(\w+)\s*\/\s*(?:YES|NO)_(\w+)$/,
    // EXPECTED_VALUE / PREDICTION: only the conditional side prefixed
    /^(?:YES|NO)_(\w+)\s*\/\s*(\w+)$/,
];

const TYPE_PRIORITY = ['CONDITIONAL', 'EXPECTED_VALUE', 'PREDICTION'];

export function extractTokensFromPools(pools) {
    if (!Array.isArray(pools) || pools.length === 0) {
        return { companyToken: null, currencyToken: null };
    }

    for (const type of TYPE_PRIORITY) {
        for (const pool of pools) {
            if (pool?.type !== type || !pool?.name) continue;
            for (const pat of PATTERNS) {
                const m = pool.name.match(pat);
                if (!m) continue;
                const [, left, right] = m;
                // PREDICTION pool ("YES_sDAI / sDAI") leaves company === currency,
                // which is not informative — skip and keep looking.
                if (left === right) {
                    return {
                        companyToken: null,
                        currencyToken: { id: null, symbol: right },
                    };
                }
                return {
                    companyToken:  { id: null, symbol: left },
                    currencyToken: { id: null, symbol: right },
                };
            }
        }
    }

    return { companyToken: null, currencyToken: null };
}

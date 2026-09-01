/**
 * stub-indexer.mjs — programmable in-process GraphQL stub.
 *
 * Stands in for the Checkpoint indexer (registry / candles) when the
 * harness wants to exercise the api's passthrough layer without
 * requiring a live indexer. The api is configured to point at this
 * stub via the REGISTRY_URL / CANDLES_URL env vars (see
 * src/config/endpoints.js).
 *
 * The stub is intentionally dumb — it has no schema, no resolvers,
 * no GraphQL parsing. It responds with whatever the test author
 * registered for the matching operation.
 *
 * Public surface:
 *
 *   const stub = await startStubIndexer({
 *       port: 3003,
 *       responder: (body) => ({ status: 200, json: {data: {...}} }),
 *   });
 *   // stub.url === 'http://127.0.0.1:3003/graphql'
 *   // ...test...
 *   await stub.stop();
 *
 * The responder receives the parsed POST body and must return
 *   { status: <number>, json: <any> }
 *   OR
 *   { status: <number>, body: <string>, contentType?: <string> }
 *
 * If the responder throws, the stub returns 500 + the error message.
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

export async function startStubIndexer({
    port,
    responder = () => ({ status: 200, json: { data: null } }),
    path = '/graphql',
} = {}) {
    if (!port) throw new Error('startStubIndexer: port is required');

    const calls = [];

    const server = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== path) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }

        // Read body
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', async () => {
            let body;
            try {
                body = raw ? JSON.parse(raw) : {};
            } catch (err) {
                res.statusCode = 400;
                res.end(`invalid JSON: ${err.message}`);
                return;
            }

            const callRecord = { receivedAt: Date.now(), body };
            calls.push(callRecord);

            try {
                const result = await responder(body, callRecord);
                callRecord.result = result;

                res.statusCode = result.status ?? 200;
                if (result.json !== undefined) {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(result.json));
                } else if (result.body !== undefined) {
                    if (result.contentType) {
                        res.setHeader('Content-Type', result.contentType);
                    }
                    res.end(result.body);
                } else {
                    res.end();
                }
            } catch (err) {
                callRecord.error = err.message;
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    errors: [{ message: `stub-indexer responder threw: ${err.message}` }],
                }));
            }
        });
    });

    server.listen(port, '127.0.0.1');
    await once(server, 'listening');

    return {
        url: `http://127.0.0.1:${port}${path}`,
        port,
        path,
        // Inspection — what calls have we received?
        calls,
        // Hot-swap the responder mid-test.
        setResponder(fn) { responder = fn; },
        stop() {
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

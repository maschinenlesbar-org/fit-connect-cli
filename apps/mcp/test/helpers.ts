// Test helpers of this server's own tests and the adapters of the conformance tests: a mock
// upstream on the FIT-Connect Routing API (the client's routing.ts: live area answers recorded on
// 2026-11-19, and the route the OpenAPI spec documents), and the client's transport helpers. The
// generic harness (a connection, a config, a log recorder, the HTTP server) is harness.ts.

export * from "@maschinenlesbar.org/fit-connect-client/test/helpers";
export * from "@maschinenlesbar.org/fit-connect-client/test/routing";

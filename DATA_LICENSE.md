# Data license

> **This tool does not include, host, or redistribute any data.**
> `fit-connect-cli` is a *client*. It only accesses data served live by the
> **FIT-Connect Routingdienst**, operated by the **FITKO** (Föderale IT-Kooperation),
> over their public Routing API. That data is the provider's and is governed by
> **their** terms, summarized below. The license of this CLI's own source code is a
> separate matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | FITKO (Föderale IT-Kooperation) — FIT-Connect Routingdienst |
| **API / source** | `https://routing-api-prod.fit-connect.fitko.net` · docs: https://docs.fitko.de/fit-connect/docs/apis/routing-api/ |
| **Underlying source** | Routing information is resolved largely from the **PVOG** (Portalverbund-Online-Gateway), fed by the federal/state **XZuFi** service catalogues, plus FIT-Connect destination registrations. |
| **Data license** | **Not formally declared as an open-data license** on the Routing API. Use is governed by the FIT-Connect terms of service (`termsOfService: https://www.fitko.de/`). |
| **Attribution** | No standard open-data attribution clause is declared; crediting **FITKO / FIT-Connect Routingdienst** as the source is the good-faith default. |
| **Commercial use** | Not explicitly granted or forbidden by an open-data license; assess against the FIT-Connect terms before commercial reuse. |
| **Redistribution / modification** | No open-data redistribution grant is declared. Treat the returned authority data as live operational metadata, not as a redistributable dataset. |

## What the data is

The Routing API returns **Zustellpunkte** (delivery points) and the
human-readable details of the responsible authority for a public service in a
given area: destination id, authority name, contact persons, addresses, and
service-specific notes (legal basis, required documents, deadlines). This is
operational administrative routing metadata, surfaced live — it is not published
here as a static, licensed dataset.

## Notes & caveats

- The Routing API's OpenAPI `info` block declares only a `termsOfService` link to
  `https://www.fitko.de/` and a FITKO contact — **no** `license` field. The
  underlying XZuFi/PVOG catalogue entries are produced by the individual federal
  and state authorities and can carry heterogeneous terms.
- The API is **read-only** for routing. This tool deliberately wraps **only** the
  Routing API; it does **not** implement the FIT-Connect Submission/Destination
  (write) path. No applications, payloads, or personal data are ever submitted.
- The Routing API enforces **bot detection** (a valid `User-Agent` is required;
  requests without one are rejected with `403`) and **rate limiting** (see the
  `RateLimit-*` response headers). The client sends a `User-Agent` by default and
  honours `Retry-After` on `429`.

## Sources

- https://docs.fitko.de/fit-connect/docs/apis/routing-api/ — Routing API documentation
- https://docs.fitko.de/fit-connect/docs/sending/get-destination/ — "Zustellpunkt ermitteln"
- https://schema.fitko.de/fit-connect/routing-api/2.0.0/routing-api.yaml — OpenAPI spec (`info` has no `license`)

---

*Good-faith summary compiled 2026-06-21; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*

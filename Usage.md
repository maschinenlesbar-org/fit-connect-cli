# Usage cookbook

Use-case-driven recipes for the `fit-connect` CLI. For the command reference see
the **[README](README.md)**; for every term see the **[GLOSSARY](GLOSSARY.md)**.

All examples use `--compact` so output is one line per result, easy to pipe into
[`jq`](https://stedolan.github.io/jq/). Drop it for pretty-printed JSON.

> **The two inputs.** A routing lookup needs a **Leistungsschlüssel** (`leikaKey`,
> a 14-digit `99…` key identifying the *service*) and **one area selector**
> (`--ars` / `--ags` / `--area-id`, identifying *where*). This CLI does not
> discover service keys — get them from the FIM-Portal / Leistungskatalog.

## Find who is responsible for a service in a town

The headline use case, in two steps when you only know the place by name:

```bash
# 1) place name -> area id
fit-connect --compact areas "Hanau"
#   -> pick { "id": "940", "name": "Hanau, Brüder-Grimm-Stadt", "type": "kreisfreie Stadt" }

# 2) route the service into that area
fit-connect --compact routes 99123456760610 --area-id 940
```

If you already hold the official codes, do it in one call:

```bash
fit-connect --compact routes 99123456760610 --ars 160510000000
fit-connect --compact routes 99123456760610 --ags 16051000
```

## Pull just the authority name and contact

```bash
fit-connect --compact routes 99123456760610 --ars 160510000000 \
  | jq -r '.routes[]
      | "\(.destinationName)\n  ☎ \(.contactPersons[0].tel // "-")  ✉ \(.contactPersons[0].email // "-")"'
```

## Get the postal address of the responsible authority

```bash
fit-connect --compact routes 99123456760610 --area-id 940 \
  | jq -r '.routes[0].postalAddress
      | "\(.street) \(.houseNumber), \(.zip) \(.city)"'
```

## Search areas

```bash
# By name (returns the place and its Ortsteile)
fit-connect --compact areas "Halle"

# By postal code
fit-connect --compact areas 60311

# Wildcard prefix match
fit-connect --compact areas "Mag*"

# Multiple terms are ANDed — every term must match the same area (narrows it)
fit-connect --compact areas Frankfurt am Main

# Just the top-level (non-Gemeindeteil) candidates
fit-connect --compact areas "Hanau" \
  | jq -r '.areas[] | select(.type != "Gemeindeteil") | "\(.id)\t\(.type)\t\(.name)"'
```

## Page through a large area result

```bash
fit-connect --compact areas "Berlin" --limit 25 --offset 0
fit-connect --compact areas "Berlin" --limit 25 --offset 25
```

## Count registered destinations for a service in an area

```bash
fit-connect --compact routes 99123456760610 --ars 160510000000 | jq '.totalCount'
```

A `totalCount` / `count` of `0` is a valid answer — no destination is registered
for that service in that area. The command still exits `0`.

## Use the legacy v1 routing service

`v2` is the default and current version. `v1` takes the same inputs but its route
results omit the encryption-key parameters; query it explicitly when you need it:

```bash
fit-connect --api-version v1 --compact routes 99123456760610 --area-id 940
fit-connect --api-version v1 info
```

## Check the deployed API version

```bash
fit-connect --compact info
# {"version":{"major":2,"minor":0,"patch":0}}
```

## Scripting patterns

```bash
# Resolve a place name to a single area id in one pipeline
AREA_ID=$(fit-connect --compact areas "Hanau" \
  | jq -r '.areas[] | select(.type=="kreisfreie Stadt") | .id' | head -n1)
fit-connect --compact routes 99123456760610 --area-id "$AREA_ID"

# Loop a service over several areas (ids from `fit-connect areas`)
for AREA in 940 1099 1024; do
  echo "== area $AREA =="
  fit-connect --compact routes 99123456760610 --area-id "$AREA" | jq -r '.routes[].destinationName'
done

# Raise the timeout on a slow connection
fit-connect --timeout 60000 --compact routes 99123456760610 --area-id 940
```

## Exit codes in scripts

```bash
if fit-connect --compact routes 99123456760610 --ars 160510000000 >/tmp/r.json; then
  test "$(jq '.count' /tmp/r.json)" -gt 0 && echo "responsible authority found"
else
  echo "lookup failed (exit $?)" >&2   # 1 = error, 4 = 404
fi
```

| Code | Meaning |
| --- | --- |
| `0` | Success — including an empty `routes: []` / `areas: []` |
| `4` | Not found (`404`) |
| `1` | Other API / network / parse / validation / usage error |

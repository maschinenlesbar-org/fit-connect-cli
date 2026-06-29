# fit-connect-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
finding the responsible German authority for a public service, all powered by the
**[fit-connect](README.md)** CLI over the open
[FIT-Connect Routing API](https://docs.fitko.de/fit-connect/docs/apis/routing-api/)
(`routing-api-prod.fit-connect.fitko.net`).

Each skill teaches Claude how to drive the `fit-connect` CLI to answer a specific,
real-world question — "who handles Wohngeld in Hanau?", "what's the area id for
Halle?", "what do I need to apply for X in Y?" — and to report the answer with the
authority's real contact data rather than guesswork. They encode the parts that
are easy to get wrong (the two-input model, the area-selector rule, the
place→area→route flow) so Claude doesn't rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **fit-connect-find-authority** | Resolves a place to an area, routes a service key to it, and reports the responsible authority's name, contacts and address. | "who is responsible for <service> in Hanau?", "where do I apply for this Leistung in Köln?" |
| **fit-connect-area-lookup** | Searches areas by name or postal code and disambiguates the city from its Ortsteile, returning the id/codes for routing. | "what's the area id for Halle?", "look up 60311", "which areas match Mag\*?" |
| **fit-connect-service-briefing** | Turns a route result's localized info blocks into a citizen-facing "how to apply" briefing (documents, legal basis, deadlines, processing time, contacts). | "what do I need to apply for <service> in <place>?", "how long does it take?" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that
  loads Agent Skills).
- **The `fit-connect` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/fit-connect-cli   # installs the `fit-connect` bin
  ```
  No API key is required — the FIT-Connect Routing API is free, open, and read-only.
- **A Leistungsschlüssel** for routing lookups (a 14-digit `99…` service key). This
  is *not* discoverable through this CLI; the skills will ask for it or point you to
  the FIM-Portal / Leistungskatalog (the `fim-portal` CLI, if installed).

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands
inside Claude Code:

```
/plugin marketplace add maschinenlesbar-org/fit-connect-cli
/plugin install fit-connect@fit-connect-skills
```

The first command registers the marketplace; the second installs the `fit-connect`
plugin, which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/fit-connect-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/fit-connect-find-authority/SKILL.md`. Start a new Claude Code session and the
skills are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from
your request. Just ask in natural language:

> Who is responsible for service 99123456760610 in Hanau?

> What's the area id for Halle (Saale)?

> What do I need to apply for this Leistung in Köln, and how long does it take?

You can also invoke a skill explicitly with its slash command, e.g.
`/fit-connect-find-authority`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`fit-connect` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this API, for example:

- a route lookup needs **two** inputs — a Leistungsschlüssel (the *service*) and
  **exactly one** area selector (`--ags` / `--ars` / `--area-id`, the *where*); zero
  or two selectors is rejected before any request;
- the service key is **not** discoverable through this CLI, so the skills ask for it
  rather than guessing (a wrong key returns a misleading empty result);
- a place name resolves to **many** area rows (the city plus its Ortsteile) — pick
  the top-level entry, not a `Gemeindeteil` (see **fit-connect-area-lookup**);
- an empty `routes: []` (`count: 0`) is a **valid answer**, not an error — it means
  no destination is registered there; the skills report that and suggest a broader
  area;
- the route result's info blocks are localized `{ description: { de, en } }` objects
  whose values may contain HTML — strip tags for a readable briefing (see
  **fit-connect-service-briefing**).

The skills wrap **only** the read-only Routing API; they never submit an application
(the FIT-Connect write path is deliberately out of scope).

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md)
for the dual-licensing / commercial option.

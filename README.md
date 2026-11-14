# Roadwatch

Investigate a road construction contract from its public records. Import the award
report, change orders, invoices and inspections straight from the publisher's website,
record what was paid, note what the road looks like today, and let the investigator
surface the discrepancies worth a closer look — each one quoting its source.

Roadwatch produces **leads for human review**. It never declares corruption, fraud or
misconduct; it points to inconsistencies, states the innocent explanations, and lists
the records needed to resolve them.

## What it does

| Layer | How it works |
|---|---|
| **Map & open data** | Choose the city (Toronto or Montréal), then one or more streets on an OpenStreetMap map (search or click) — a corridor, or several roads done by the same contractor. Roadwatch pulls what that city publishes about them, merges the streets' records (each tagged with the street it matched) and stores each dataset as a citable document. A case belongs to exactly one city; the two cities' data never mix. |
| **Procurement indicators** | Plain code over the pulled data: repeat winner share, work rescheduled within three years, non-competitive awards to the same contractor, year-over-year spike in road-damage complaints, permits held by other contractors, suppliers registered as lobbyists (with communications in the year before an award). Each is a lead with an innocent explanation and a next step, quoting the dataset. |
| **At a glance** | As soon as data is pulled: award value for road work, share by supplier (pie), by year and by street, 311 road-damage trend, permits and lobbying counts — before any investigation runs. |
| **Evidence library** | Import PDFs/web pages from official publishers (toronto.ca, ontario.ca, montreal.ca, canada.ca, auditors general…), upload files, or paste text. Page text is stored with the source link and a file fingerprint. |
| **Spending trail** | Each amount is recorded with its type (award / amendment / payment), tax basis, scope, and an exact quotation that must exist on the cited page. |
| **Financial checks** | Plain arithmetic, no AI: compares like-for-like groups, flags payments over authorization and repeated references. |
| **AI investigation** | Before the model runs, code builds **dossiers**: a dated timeline of everything on the street, a profile per supplier (wins, losses, bid spreads, non-competitive work, lobbying, RENA, audits), the money table, and the full text of the uploaded documents when they fit. **Quick** mode is one pass with tools. **Deep** mode plans 3–6 case-specific hypotheses, tests each with its own reading budget (a fast model, `ROADWATCH_FAST_PROVIDER`), synthesises, then an adversarial review pass checks citations, segment limits and whether innocent explanations were tested against the data. Findings carry a confidence rating (supported / plausible / speculative), the tests performed and what record would change the conclusion; the team's questions get explicit cited answers. The model gets a document index and tools to search and read pages and to filter the pulled open-data rows. It cross-checks the city's data against the uploaded documents and returns findings with citations, counter-explanations and next steps. Findings whose quotations don't exist in the evidence are discarded server-side. |
| **Road condition** | Dated, geolocated observations stored as unverified leads for an engineering check. |
| **Team workspace** | Email + password accounts: the admin invites people (link valid 72 h, emailed when SMTP is configured), each sets their own password; roles viewer / investigator / counsel / admin; password change signs out other devices; admin-issued reset links; deactivation ends sessions at once. A Discussion tab per case: threads anchored to the whole case, a finding or a document page, with citations verified against the record; a findings board (open → investigating → explained / escalated / dismissed, with an owner and note, stable across re-runs); structured **assessments** (summary, legal basis, risk, recommended action, draft/reviewed) pinned on the report. Conclusory language without a citation is posted as "opinion", not blocked. Team notes are sent to the AI with each investigation as leads to verify, never as evidence, and are included in the export. Street cases on the same set of streets in one city, in any order, share one discussion, so people who each opened their own case on those roads work in a single thread; changing a case's streets moves it to that set's discussion, and finding statuses stay per case. |

## Run locally

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
cp .env.example .env            # add ROADWATCH_API_KEY to enable AI
.venv/bin/uvicorn roadwatch.server:app --host 127.0.0.1 --port 8010
```

Open http://127.0.0.1:8010. **Add a sample case** loads a fully fictional case so you
can see how reports look; delete it whenever you like.

### Open data by city

| | Toronto (`open.toronto.ca`) | Montréal (`donnees.montreal.ca`, Données Québec) |
|---|---|---|
| Contracts naming the street | Toronto Bids awarded contracts (daily) | Delegated-authority, executive-committee and borough-council contracts (320k rows, queried server-side) |
| Bidders, bid amounts, awards | Not published (only inside Bid Award Panel PDFs → import them) | **SEAO** (OCDS): every bidder and bid amount per tender; indexed 6 months per pull (`ROADWATCH_SEAO_MONTHS`), coverage grows with each pull |
| Non-competitive contracts | Yes, matched by supplier (dataset has no location) | Not published |
| Estimates vs winning bid | Not published | *Bilan des estimations* (internal estimate, winning bid, number of bids) |
| Planned work | Capital project pipeline (estimated ranges), sidewalk program, road reconstruction + resurfacing programs | 2016–2021 integrated intervention plan per segment (planned works, costs, measured PCI) |
| Open tenders | Toronto Bids open solicitations | (SEAO above) |
| Permits / closures | RoDARS live feed with contractor | Info-travaux permits with organisation and City contract number |
| 311 road-related requests | Yearly archives since 2010 | 2014–today (nid-de-poule, pavage, trottoir, puisard…) |
| Lobbying | Lobbyist Registry: client firms, officials lobbied, dates | Québec's registry is provincial, no bulk download |
| Integrity watchdog | Auditor General reports (REST index, matched by supplier/street/road topics) | Bureau de l'inspecteur général publications index, matched by supplier/street |
| Barred companies | No public suspended-supplier list | **RENA** (Québec register of companies barred from public contracts) checked against every supplier and SEAO bidder, with linked persons and majority shareholders |
| Adjacent construction | Building permits (new buildings, demolitions, >$500k) and development applications on the street | Construction and demolition permits on the street |
| Traffic | Latest intersection counts: vehicles, heavy-vehicle share, pedestrians | Turning-movement counts per intersection and day: vehicles, trucks, truck share |
| Winter severity | Environment Canada daily data (Toronto City) → freeze-thaw days per winter vs local average | Same (Montréal-Trudeau) |
| Pavement condition (map layer) | None published — proxy: City's scheduled resurfacing/reconstruction | Official PCI surveys (2024 arterial, 2022 local) |
| Payments, inspections, warranty | Not published — FOI | Not published — access to information |
| Campaign donations | 2018 only, individuals (corporate banned) — not used | Not used |

Street names are matched case-, accent- and abbreviation-insensitively ("Davenport Rd" = "Davenport Road"; "rue Saint-Denis" = "SAINT-DENIS"). Optional contract limits (from/to cross streets) flag each record as inside or outside the limits by text. Montréal's portal rate-limits bursts, so its queries are paced and cached; SEAO monthly files (~70 MB each) are reduced to a Montréal-only extract once and cached for good.

Indicators computed from this data: repeat winner, rework within three years, non-competitive awards to the same supplier, road-damage complaint spike (with that winter's freeze-thaw count and adjacent building permits stated as context), other contractors' permits, supplier registered as lobbyist, single-bidder tenders, near-identical or inverted bids, winning bid far from estimate, company on RENA (and whether it won anything while barred). All are leads with innocent explanations; none is a conclusion.

Not connectable (no machine-readable source): payments, inspections and warranty records (FOI / access to information), Toronto bidder lists (only in Bid Award Panel PDFs), Toronto council documents (TMMIS blocks scripts — import the PDF URL), Québec's lobbyist registry, corporate ownership (Québec's REQ bulk file is the only route; not implemented), campaign donations (individuals only).

### Your first real case (Toronto)

1. **New case** — e.g. *Davenport Road resurfacing 2024*, contract `24ECS-RD-08MR`.
2. **Map & open data** — search *Davenport Road* or click the road, then **Pull open data**.
   The first pull downloads ~20 MB of city datasets (cached for a day under `data/cache/`) and takes
   about 20 seconds; it adds six documents, the at-a-glance overview and, on **Run financial checks**, the procurement indicators.
3. **Add evidence → Import from official source** and paste the award report link:
   `https://www.toronto.ca/legdocs/mmis/2024/ba/bgrd/backgroundfile-247859.pdf`
4. **Spending → Record amount**: type *Original award*, before tax, quote the line
   `$1,563,742 net of all applicable taxes and charges` from page 1.
5. Add further documents as you obtain them (change orders, payment certificates,
   inspection reports — often via a Freedom of Information request).
6. **AI investigation →** and open the citations.

Where to find Toronto documents: the [Bids Portal](https://www.toronto.ca/business-economy/doing-business-with-the-city/searching-bidding-on-city-contracts/toronto-bids-portal/)
(awards since Oct 2025), [council/committee documents](https://secure.toronto.ca/council/#/search)
(older Bid Award Panel reports — search "award" plus a street name), the
[Auditor General](https://www.torontoauditor.ca/reports/), and [Open Data](https://open.toronto.ca/).
Final payments, invoices and inspection records are usually **not** online and need a
[Freedom of Information request](https://www.toronto.ca/city-government/accountability-operations-customer-service/access-city-information-or-records/freedom-of-information/) ($5 fee).

## Hosting

Roadwatch is a single Python service. With its default SQLite database it needs one instance and
a persistent disk; with MongoDB it needs neither. **Before exposing it to the internet, set `ROADWATCH_ACCESS_KEY`**;
otherwise anyone who finds the URL can read cases and spend your AI quota.

### Render (recommended; `render.yaml` included)

The included blueprint runs on Render's free plan and keeps cases, accounts and discussion in MongoDB Atlas, so
nothing has to survive on the server.

1. Create a free MongoDB Atlas cluster and a database user. Under **Network Access** allow `0.0.0.0/0`: Render's
   free plan has no fixed outbound address, so the database is protected by its password alone; use a long one.
2. Push this folder to a Git repository.
3. In Render: **New → Blueprint**, pick the repo. It asks for three values: `ROADWATCH_MONGODB_URI` (the Atlas
   connection string), `ROADWATCH_ACCESS_KEY` (the administrator's sign-in key) and `ROADWATCH_API_KEY` (your model
   provider key).
4. Deploy. Sign in at the `https://….onrender.com` address with the access key and invite people from **Team & access**.

A free service sleeps after about 15 minutes without visitors and takes about a minute to wake; the downloaded
open-data cache is lost on each restart and fetched again when needed. A paid plan removes the sleeping.
To run on SQLite instead, give the service a persistent disk, point `ROADWATCH_DB` at it and keep a single instance.

### Docker (any host)

```sh
docker build -t roadwatch .
docker run -d -p 8000:8000 -v roadwatch-data:/data \
  -e ROADWATCH_ACCESS_KEY=choose-a-long-key \
  -e ROADWATCH_API_KEY=… -e ROADWATCH_MODEL=gemini-3.8-flash \
  -e ROADWATCH_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
  roadwatch
```

Put it behind HTTPS (Caddy, nginx, or the host's load balancer). Session cookies are
marked `Secure` automatically when the request arrives over HTTPS.

### MongoDB instead of SQLite (optional)

Set `ROADWATCH_MONGODB_URI` and cases, accounts, discussion and the AI counter are stored in MongoDB
(Atlas or self-hosted, version 5 or later) instead of the SQLite file. Nothing else changes.

```sh
.venv/bin/python -m pip install -e '.[mongo]'
# put ROADWATCH_MONGODB_URI=mongodb+srv://… in .env, then copy the existing cases across:
.venv/bin/python -m roadwatch.migrate_mongo
```

The SQLite file is only read by the migration and stays as a backup; remove the variable to go back to it.
In MongoDB a case is one small document plus one document per evidence file, open-data set and report,
so the case list loads without any evidence and a case is not bound by the 16 MB document limit.
With MongoDB the service no longer needs a persistent disk for cases and can run more than one
instance; the open-data cache (`ROADWATCH_CACHE`) is still local files and is re-downloaded when lost.
In Atlas, allow the server's IP address under **Network Access** or connections will time out.

The **Search all cases** box in the sidebar finds every evidence page, in any case, that contains all the words
you type (whole words, ignoring case and accents). It works on both stores; on MongoDB a text index over the
evidence finds the documents, on SQLite every case is scanned.

With MongoDB Atlas and `ROADWATCH_EMBED_MODEL` set, the search dialog also offers **By meaning**: it returns the
pages closest in meaning to what you typed, in any language, using Atlas Vector Search. Each evidence page is cut
into pieces of up to 1,500 characters and embedded once in the background (the text is sent to the embedding
provider); new evidence is picked up the next time the app is opened or searched. It always returns the nearest
pages, so a low similarity means "nothing close", not a match. On a self-hosted MongoDB without Vector Search the
same results come from comparing every stored vector, which is fine for a few thousand pages.

### Environment variables

| Variable | Purpose |
|---|---|
| `ROADWATCH_ACCESS_KEY` | The administrator's bootstrap key (sign in via "Use an access key instead"). Empty = no login, single local user with admin rights. Rotating it signs everyone out. Team members have email + password accounts created from **Team & access**; passwords are stored with scrypt. |
| `ROADWATCH_SIGNUP`, `ROADWATCH_SIGNUP_ROLE` | `open` lets anyone create an account from the sign-in screen (5 per IP per hour, 10+ character password, must accept the workspace rules; email confirmation when SMTP is configured). New accounts get `ROADWATCH_SIGNUP_ROLE` (default `viewer`: read and discuss) until an admin promotes them. `invite` (default) = admin invites only. |
| `ROADWATCH_GUEST` | `on` adds "Continue as a guest" to the sign-in screen: anyone with the address can enter without an account and do what an investigator can (create and delete cases, add records, pull open data, run AI investigations within the daily limit, read the discussion, set finding statuses, export). A guest cannot post, reply or write assessments in the discussion, and cannot see or manage accounts. Default `off`: turning it on gives every visitor the power to change and delete cases. |
| `ROADWATCH_PUBLIC_URL` | Public address used in invite and confirmation links, e.g. `https://roadwatch.example.org`. Defaults to the request's own URL. |
| `ROADWATCH_SMTP_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `ROADWATCH_MAIL_FROM` | Optional. When set, invites and "forgot password" send email (STARTTLS). Without them the admin copies the invite/reset link from the Team dialog. |
| `ROADWATCH_API_KEY`, `ROADWATCH_MODEL`, `ROADWATCH_BASE_URL` | Any OpenAI-compatible chat-completions provider with tool calling. Tested: Gemini (`gemini-3.6-flash`); configured default `gemini-3.8-flash`. |
| `ROADWATCH_DAILY_AI_LIMIT` | AI investigations per UTC day (default 40). Financial checks are unlimited. |
| `ROADWATCH_DB` | SQLite path. Point at the persistent disk. |
| `ROADWATCH_EMBED_MODEL`, `_API_KEY`, `_BASE_URL`, `_DIMENSIONS` | Optional, with MongoDB: turns on search by meaning. Key and URL default to `ROADWATCH_API_KEY` / `ROADWATCH_BASE_URL`; 768 dimensions by default. |
| `ROADWATCH_MONGODB_URI`, `ROADWATCH_MONGODB_DB` | Optional. Store cases in MongoDB instead of SQLite (needs the `mongo` extra). The database name defaults to the one in the URI, else `roadwatch`. |
| `ROADWATCH_CACHE` | Directory for downloaded open-data files (default: next to the database). Safe to delete. |
| `ROADWATCH_ALLOWED_ORIGINS` | Only for dev proxies that rewrite `Host`. |

### Choosing a provider for real use

* **Google free tier** — fine for public procurement records and trying things out, but Google may use free-tier content to improve its products. Don't send confidential or whistleblower material.
* **Paid / enterprise tiers** (Gemini paid tier, Vertex AI in Canada, Azure OpenAI Canada Central) — no training on your data, data residency, audit trail. Required for anything sensitive or for a government deployment.
* **Self-hosted** (Ollama with `qwen3.8:27b` or `gpt-oss:20b`) — nothing leaves your server; lower quality than the hosted frontier models.

Per investigation the model cost is a few cents; the daily cap is a guard against runaway use, not a budget concern.

## Development

### In-app support assistant

**Ask Roadwatch** guides people through the current case, document uploads, spending and investigations. It uses
read-only help/status tools and offers navigation buttons; users submit changes through the normal forms. Chat history
is scoped to the signed-in account and case, works with SQLite or MongoDB, and can be cleared. With no model configured,
the widget clearly shows **Guide mode**. See [the support agent review guide](docs/support-agent.md) for configuration,
architecture, test prompts and the optional live-model check.

### Tests

```sh
.venv/bin/python -m pytest -q
# the same suite on MongoDB (each test uses its own database on this server and drops it afterwards):
ROADWATCH_TEST_MONGODB_URI=mongodb://127.0.0.1:27017 .venv/bin/python -m pytest -q
```

Tests cover like-for-like accounting, decimal differences, duplicate references, quotation
validation, PDF extraction, evidence snapshots, the AI tool loop with a mocked provider
(including fabricated-citation rejection), stale-run protection, URL-import allowlisting,
login, and the daily AI cap.

## Limits

* Scanned PDFs need OCR before import.
* Amounts, scopes and tax bases are entered by a person; the app verifies the quotation exists, not that it was read correctly.
* The AI cannot see documents that aren't in the case. A clean report means "no discrepancy in the records on file", not "nothing happened".
* With open sign-up, anyone can read every case and post in discussions as a viewer; an admin should watch the Team list and deactivate abusers. Self-service password reset and email confirmation require SMTP. There is no two-factor authentication yet. Statements in the discussion about named companies and people are visible to every member and are sent to the AI provider; the notice in the composer says so.
* Open data is matched to the street by name, so a long street's records include work on other segments; the 311 dataset keeps the 400 most recent rows per pull; the permit feed only shows current and scheduled work. Map searches are proxied to OpenStreetMap Nominatim (one request per second).

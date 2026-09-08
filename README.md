# TruthMesh

A fact layer over PDFs. Upload unfamiliar documents; get claims with the passage that
supports each one, and explained relationships between claims that different documents
make about the same thing.

| Relationship | Meaning |
|---|---|
| `agrees` | Two documents independently support the same fact |
| `likely_contradiction` | The conflict looks real, one context question remains |
| `context_difference` | Different figures, reconciled by period, scope or unit |
| `insufficient_context` | The system abstains, and says why |

Built on three Delhivery filings; generalization tested on three unrelated macroeconomic
documents (Economic Survey, RBI, IMF).

---

## Setup and run

**Requires:** Docker Desktop. Nothing else.

```bash
git clone https://github.com/samraddh10/truthmesh.git
cd truthmesh
cp .env.example .env        # set AWS_REGION or GROQ_API_KEY
docker compose up -d --build
```

Open **http://localhost:5173** → create a collection → upload **at least two PDFs**.

> One document produces facts and no relationships: corroboration needs two sources. Use
> all three from a dataset in `datasets/`.

Migrations run automatically — the `migrate` service must exit cleanly before api and
worker start.

### Model access

Only the worker calls a model, and it exits at startup if neither provider is configured.
Pick one:

```bash
AWS_REGION=us-east-1                      # Bedrock, via the Converse action
BEDROCK_MODEL_ID=moonshotai.kimi-k2.5
# or
GROQ_API_KEY=gsk_...
```

Bedrock credentials come from the AWS SDK default chain (SSO profile, env vars, instance
role). **Enable the model for your region first** under *Bedrock console → Model access*,
or every call returns `AccessDeniedException`.

The model needs two properties:

- **Tool use** — Bedrock has no `response_format`, so the JSON Schema is sent as a forced
  tool call. Required.
- **Image input** — for rendering and transcribing table-like pages. Optional; without it
  those pages fall back to native text and log `visual_route_failed`.

The default `moonshotai.kimi-k2.5` has the first, not the second. Anthropic models on
Bedrock have both.

### Verify

```bash
docker compose ps                  # postgres healthy + api, web, worker
curl http://localhost:3000/ready   # {"ok":true,...}
docker compose logs -f worker
npm install && npm test            # 474 tests
```

`sample-output/` is reviewable with no credentials at all.

---

## Video demo

**[▶ Watch the demo (< 3 min)](#)** *(link to be added)*

| Time | Case shown |
|---|---|
| 0:00 | A PDF uploaded and processed, with progress |
| 0:25 | **Case 1 — Corroboration**, both sources cited |
| 1:00 | **Case 2 — Likely contradiction**, with evidence |
| 1:35 | **Case 3 — Context-resolved difference** |
| 2:10 | **Case 4 — A real failure** and how it is handled |
| 2:40 | Generalization result and one trade-off |

---

## Approach

Five stages. Each can fail without destroying the others' work.

| Stage | What it does |
|---|---|
| **Parse** | PDF.js text with coordinates → lines, columns, blocks; table-like and scanned pages routed to multimodal transcription |
| **Extract** | Bounded chunks under a Zod-defined schema; claims cite `[B1]` block handles, never invented page numbers |
| **Verify** | Three separate questions: does the block exist, is the quote really in it, does the quote state what the claim says |
| **Normalize** | decimal.js throughout; scale words, Indian numbering, percentages; periods, scopes and entities resolved |
| **Compare** | Exact entity/predicate match ∪ pgvector top-k → deterministic checks → the model labels the pair from both claims and their evidence |

**Architecture** — four Compose services: `web` (React + Vite), `api` (Fastify), `worker`
(pg-boss consumer), `postgres` (pgvector). API and worker share the schema and the PDF
volume; only the worker holds a model key. Node 24 + TypeScript, Drizzle, unpdf,
decimal.js, local `@huggingface/transformers` embeddings at 768 dims.

### Decisions and trade-offs

| Decision | Trade-off accepted |
|---|---|
| **A claim is never overwritten when another document disagrees.** Disagreement is two claims plus a relationship; there is no "resolved" value in the schema. | The UI must teach the reader to hold two numbers at once. |
| **No confidence score is stored or shown.** A number reads as a calibrated probability whatever the label says. Rationale, differing dimensions and open questions are shown instead. | Harder to sort or threshold on. |
| **Citation existence and entailment are separate fields.** A quote can be genuinely present and still not support the claim. | Two flags to reason about, not one. |
| **A claim supported only by a model transcription stays in review.** The model wrote both the claim and the transcription — one witness, not two. | Lower recall on table-heavy pages. |
| **Abstention is first-class.** `insufficient_context` appears in the same list, same shape, as `contradicts`. | Some pairs end in a non-answer. |
| **Rounding tolerance comes from each source's own precision**, not one blanket epsilon. | Why 8,142 Cr and 81,415 mn agree, while (1,229) and (1,003.79) mn do not. |
| **Money never passes through a JS number.** Postgres `NUMERIC` → decimal string → decimal.js. | Slightly more plumbing everywhere. |

### AI tools used

Built with **Claude Code** as a pair programmer across every phase — schema, pipeline,
React interface and evaluation harness. `superjoin-implementation-plan.md` was written
first and followed phase by phase; `docs/` holds the longer findings.

---

## Limitations and next steps

**What does not work yet:**

- **Accuracy is not measured.** The harness implements all six metrics against a
  50-claim / 25-pair hand-reviewed gold set and runs — but every run so far hit throttling
  before scoring enough output. It prints `not measured`, not a zero. See
  `evaluation/results/`.
- **Grounding may be too strict.** True facts have been rejected on entailment
  ("BSE and NSE" as `proposed_listing_exchanges`). The gold set is what would settle the
  threshold, and it has not run.
- **Table transcription is unreliable.** The visual route asks for structured rows and
  often gets Markdown back; that is rejected, and the page falls back to native text.
- **The pipeline is call-hungry.** ~1 call per chunk, per difficult page, per ambiguous
  entity — several hundred for a 227-page collection. Throttling, not model speed, is the
  binding constraint.
- **Page labels degrade on unfamiliar documents** — 96.8% coverage on the development set,
  65.6% on the held-out one. Display detail only; nothing locates a page by label.
- **Entity resolution is conservative.** Uncertain names stay unmerged, costing recall to
  avoid merging a parent with its subsidiary.

**Next:**

1. Run the gold set on a quota that survives a full pass, then re-tune entailment.
2. Incremental ingestion, so a fourth document does not reparse the first three.
3. Bounding-box highlights everywhere — implemented, but only where the parser stored a box.
4. Grounded Q&A over accepted claims, citing stored evidence and surfacing conflicts.

---

## Notes

### Observed failures (real ones)

- **Provider throttling** stopping extraction — classified transient, backed off, abandoned
  after repeated failure, surfaced in the Issues view instead of crashing.
- **A run reporting `completed` having extracted nothing** — the issue-resolution sweep cut
  on when a problem was *first* seen, not last, so fresh failures were marked resolved.
  Fixed, with a regression test that fails against the old cutoff.
- **Entity adjudication costing hours per document** — it asked the model about three
  candidates for every distinct subject, uncapped. Now bounded.

### Layout

```
apps/web            React review interface
apps/api            Fastify HTTP API
apps/worker         pg-boss consumer running the pipeline
packages/pipeline   parsing, extraction, normalization, comparison
packages/db         Drizzle schema and migrations
packages/contracts  Zod contracts shared by API and web
evaluation          gold set, scorer, freeze manifest, results
docs                scope, difficult pages, extraction, comparison, evaluation
```

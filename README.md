# Synapse document renderer

A standalone, stateless document microservice in its own Git repository, prepared for Cloud Run. The PHP/Apache app lives in the separate `Synapse` repository and calls this service over HTTPS. This repository contains the document inspection/editing code, PDF rendering, fonts, tests, Dockerfile and Cloud Build configuration. It contains no uploaded documents, application credentials or user database.

The local checkouts are siblings:

```text
projects/
  Synapse/                    PHP/Apache application, its own Git repository
  Synapse-document-renderer/   This microservice, its own Git repository
```

Run build, test and deployment commands from this repository root. The container needs no files or dependencies from the Synapse checkout. Synapse only needs the deployed service URL and bearer token; it does not need this source checkout on the Apache host. No cloud deployment or remote Git repository has been created yet.

The root `.htaccess` denies Apache access to this source checkout under the local projects folder. Run the API through Node or its Cloud Run container.

The layout problem starts before PDF generation: rebuilding a DOCX from extracted text discards its styles, tables, images, headers and section settings. This service edits selected paragraphs in the original DOCX package, leaving other archive parts unchanged, then uses LibreOffice Writer to export PDF. Playwright Chromium prints trusted HTML/CSS when there is no uploaded template. Playwright is not a Word or existing-PDF editor.

PDF-only CVs are retained byte for byte by the PHP app. Changing their text while preserving the design requires an editable DOCX source. DOCX output retains the original package and paragraph/run formatting; replacement text inherits the first source text run's character formatting. No sections, skills or employment records are reordered in preserve mode. Mixed-format paragraphs may need manual adjustment in Word.

## Build and test

```bash
docker build -t synapse-document-renderer .
docker run --rm -e RUN_CONVERSION_TESTS=1 synapse-document-renderer node --test test/renderer.test.mjs
```

The build installs the pinned Playwright version and its matching Chromium, LibreOffice Writer, Carlito/Caladea/Liberation fonts, and bundled Inter/Poppins/Inconsolata regular and bold fonts. These match the free font families found in the owner's uploaded templates. Their OFL notices are included in `fonts/`. Other fonts must be available to the renderer to reproduce their metrics. Word and LibreOffice can have rendering differences; the original DOCX structure is preserved, but pixel-identical Word output is not guaranteed. Keep the factual and visual review before approval.

The PDF page-count guard compares the revised DOCX with an unedited conversion using the same fonts/engine. Edits that add pages return `409 layout_overflow`; the service does not shrink fonts or silently switch templates. This catches page growth, not every possible line-wrap or alignment change.

The PHP app supplies source paragraph text budgets to the AI. If a generated cover letter adds pages, it makes at most one shortening request with tighter budgets and the prior edits, then renders again. Persistent overflow stops preparation. Both AI requests count toward the existing budget; factual review and approval remain required.

For development without Docker, install dependencies in this repository, copy `.env.example` to a private `.env`, set a random renderer token of at least 32 characters, and provide LibreOffice and Chromium:

```bash
npm ci --omit=dev --ignore-scripts
node --env-file=.env src/server.mjs
node --test test/renderer.test.mjs
RUN_CONVERSION_TESTS=1 node --test test/renderer.test.mjs
```

`LIBREOFFICE_BINARY` and `CHROMIUM_PATH` can select local executables. Conversion tests require LibreOffice; the build pipeline enables them inside the image. The PHP app never needs `npm run build` or a Node web server.

## API

All POST endpoints require `Authorization: Bearer <DOCUMENT_RENDERER_TOKEN>` and `Content-Type: application/json`. The token must be at least 32 non-whitespace characters. `GET /healthz` is public and returns only readiness. No CORS access is granted, and tokens never go to browsers.

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /v1/inspect-docx` | `{ "document": "<base64 DOCX>" }` | SHA-256 and `{part,index,text,editable}` paragraphs |
| `POST /v1/render-docx` | `{ "document": "<base64 DOCX>", "format": "pdf", "edits": [{"part":"word/document.xml","index":6,"original":"Exact old paragraph","text":"Revised paragraph"}] }` | PDF bytes, or DOCX bytes for `format=docx`; page count in `X-Document-Pages` |
| `POST /v1/render-html` | `{ "html": "<html>...</html>" }` | Chromium PDF bytes using print CSS and `@page` |

Edits must match the source paragraph exactly. Missing, stale, repeated and complex paragraph edits are rejected. Paragraphs with fields, drawings, explicit line breaks, tabs or hyperlinks require source editing in Word. Plain paragraphs inside tables or text boxes can be changed without removing the surrounding design. Source headers and footers are included in inspection. No filename, URL, output path or shell command can be provided by callers.

The service limits source DOCX to 10 MiB, expanded archives to 32 MiB/1,000 entries, requests to 16 MiB, and output to 20 MiB/ten pages. Macros, embedded objects, active content, external media relationships and non-raster embedded media are rejected. Public web/font/image requests and document scripts are disabled in Chromium. Embed needed HTML fonts/images as data URLs. Each Word conversion uses a unique private temporary directory/profile removed on success or failure. Document payloads and tokens are never logged or saved to a database/bucket. A fresh browser context is closed after each HTML request. Only one expensive request runs per instance; overlaps return 429.

## Cloud Run later

No deployment is performed by preparing this repository. When ready, authenticate `gcloud`, select a billing-enabled project and an available region, then run from this repository root:

```bash
PROJECT_ID=your-project-id REGION=your-region bash deploy.sh
```

The script enables the required services, creates an Artifact Registry repository, builds and runs conversion tests, creates a dedicated runtime service account and secret if absent, and deploys the container. It preserves an existing secret. It scales to zero, limits instances to two, sets concurrency to one and uses a 75-second request timeout. The HTTPS endpoint permits network access from the external Apache host; every document request is authenticated by the service's bearer token. The dedicated service account receives access only to its renderer secret. No default project-wide runtime account is used. Cloud Build's build account needs permission to write to the selected repository.

For a Cloud Build repository connection later, connect this repository and use its root `cloudbuild.yaml`; the root `Dockerfile` is the image build context. `.gcloudignore` and `.dockerignore` exclude local dependencies, Git metadata, environment files and test output from uploads/builds. The PHP application is not part of that build.

In the PHP site's private `.env`, set:

```dotenv
DOCUMENT_RENDERER_URL=https://your-renderer-url.run.app
DOCUMENT_RENDERER_TOKEN=the-same-private-secret
```

Retrieve the existing secret using your own authorized Secret Manager access and paste it privately. Do not put it in a URL, source control, screenshots, browser JavaScript or shell command arguments. The PHP client requires public HTTPS, verifies TLS, rejects local/private/reserved destinations and does not follow redirects. Missing renderer configuration stops preserve-mode generation with a clear setup message; it never falls back to a different design. Restart persistent PHP workers after environment changes.

Choose **Settings → Documents → Keep my uploaded design** (the default). Select the desired master CV and upload the editable DOCX cover letter template in the document library. AI proposes paragraph text only, and existing factual review/approval gates still apply. Profile/CV exports use the source document in preserve mode. A cover letter based on an uploaded template must be regenerated from that template or edited in Word and uploaded; the plain-text editor would discard its design and is therefore available only when no template is being preserved or the user chooses the simple layout.

On a DOCX document, **Create PDF preview** saves a private derived PDF using the same source design and no AI edits. The extracted-text view does not represent the source layout. Previews retain ownership checks and document version links.

References: [Playwright PDF](https://playwright.dev/docs/api/class-page#page-pdf), [LibreOffice conversion parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html), [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract), [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

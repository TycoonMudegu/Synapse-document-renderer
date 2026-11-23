#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project ID}"
: "${REGION:?Set REGION to your Cloud Run region}"
SERVICE_NAME="${SERVICE_NAME:-synapse-document-renderer}"
REPOSITORY="${REPOSITORY:-synapse}"
SECRET_NAME="${SECRET_NAME:-synapse-document-renderer-token}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-synapse-renderer}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/document-renderer:latest"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"
if ! gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$REPOSITORY" --repository-format docker --location "$REGION" --project "$PROJECT_ID"
fi
if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" --display-name 'Synapse document renderer' --project "$PROJECT_ID"
fi
if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
    openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$SECRET_NAME" --replication-policy automatic --data-file=- --project "$PROJECT_ID"
fi
# A newly created service account can take over a minute to become visible to Secret Manager.
retry_delay=2
for attempt in {1..8}; do
    if binding_output="$(gcloud secrets add-iam-policy-binding "$SECRET_NAME" --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role roles/secretmanager.secretAccessor --project "$PROJECT_ID" 2>&1)"; then
        break
    else
        binding_status=$?
    fi
    if [[ "$binding_output" != *"Service account ${SERVICE_ACCOUNT_EMAIL} does not exist"* || "$attempt" -eq 8 ]]; then
        printf '%s\n' "$binding_output" >&2
        exit "$binding_status"
    fi
    printf 'Waiting for service account propagation; retrying secret access binding in %ss (attempt %s/8).\n' "$retry_delay" "$attempt" >&2
    sleep "$retry_delay"
    retry_delay=$((retry_delay * 2))
    if ((retry_delay > 30)); then
        retry_delay=30
    fi
done
gcloud builds submit . --config cloudbuild.yaml --substitutions "_IMAGE=${IMAGE}" --project "$PROJECT_ID"
gcloud run deploy "$SERVICE_NAME" --image "$IMAGE" --region "$REGION" --project "$PROJECT_ID" \
    --service-account "$SERVICE_ACCOUNT_EMAIL" --set-secrets "DOCUMENT_RENDERER_TOKEN=${SECRET_NAME}:latest" \
    --port 8080 --cpu 1 --memory 2Gi --concurrency 1 --timeout 75s --min-instances 0 --max-instances 2 \
    --allow-unauthenticated
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --project "$PROJECT_ID" --format 'value(status.url)'
printf '%s\n' 'Set DOCUMENT_RENDERER_URL to this URL in the PHP .env. Copy the secret into DOCUMENT_RENDERER_TOKEN privately. Existing secrets are never rotated by this script.'

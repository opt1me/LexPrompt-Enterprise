// LexPrompt Stage 1 — the SAME system docker-compose.yml runs locally,
// provisioned in Azure. §5.1's whole argument is that local and Azure
// differ in deployment, not in code: one auth path with two issuers
// (Keycloak locally, Entra here), one gateway with two caller-auth modes
// (mtls locally, entra here), one set of credential-resolver adapters
// (env/file locally, managed-identity/key-vault here). Nothing below
// should read as a second design.
//
// Deliberately NOT provisioned (Task 25 point 6): Postgres, Blob Storage,
// or private endpoints for either. Those are Stage 2. A template that
// provisions a database Stage 1 never touches would be infrastructure
// nobody has tested and a bill nobody expected.
targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment. Used to derive the resource group name and a short unique token for globally-unique resource names (Key Vault, Container Registry).')
param environmentName string

@minLength(1)
@description('Azure region for all resources.')
param location string

// ---------------------------------------------------------------------
// P4 / S27 (owner decision 5): NO DEFAULT, deliberately. `azd up` prompts
// for this because there is no committed answer here — see
// apps/gateway/src/config.ts's own refusal to default it, and
// .env.example's identical refusal for the compose stack. A default here,
// even an innocuous-looking one, would be this template silently deciding
// a firm's contractual data-processing scope on its behalf.
// ---------------------------------------------------------------------
@description('Comma-separated processing blocs this deployment permits (any of UK, EU, US, other). Must match the operator'
  + '\'s own contracts and data provisions with each configured model provider — this template has no view of its own '
  + 'about which jurisdictions are acceptable, and does not guess. There is no default; azd will prompt.')
param allowedJurisdictions string

// --- api's own end-user OIDC config (apps/api/src/config.ts) -----------
@description('The Entra issuer apps/api validates tokens against, e.g. https://login.microsoftonline.com/<tenant>/v2.0. Also used, unmodified, as the browser-facing issuer (VITE_OIDC_ISSUER) — unlike the local Keycloak stack, Entra needs no split between an in-network and a published issuer URL.')
param oidcIssuer string

@description('The audience apps/api requires of every token — the Application ID URI (or client id) of api\'s own Entra App Registration.')
param oidcAudience string

@description('Claim carrying the subject identifier. "oid" for Entra.')
param oidcSubjectClaim string = 'oid'

@description('Claim carrying group membership.')
param oidcGroupsClaim string = 'groups'

@description('Comma-separated claim=value pairs apps/api additionally requires of every token, e.g. tid=<tenant-guid>. NOT JSON — apps/api/src/config.ts\'s parseRequiredClaims rejects a literal "{}" and anything else that is not "claim=value" pairs.')
param oidcRequiredClaims string

@description('Which of the directory's groups map to which LexPrompt role, as comma-separated issuer|group|role triples. NO DEFAULT: apps/api refuses to start unset, because a deployment with no mapping comes up healthy and refuses every user. Under Entra the group values are security-group OBJECT IDS, not display names.')
param oidcRoleMappings string

@description('Client id of the web SPA\'s own Entra App Registration (public client), baked into the web build as VITE_OIDC_CLIENT_ID.')
param oidcClientId string

@description('OAuth scope(s) the web SPA requests at sign-in, baked in as VITE_OIDC_SCOPE, e.g. "openid profile email api://<api-app-id>/access_as_user".')
param oidcScope string

// --- the gateway's OWN caller-auth config (apps/gateway/src/config.ts) -
@description('Tenant id the gateway trusts for its caller-auth check (GATEWAY_ENTRA_TENANT_ID).')
param gatewayEntraTenantId string

@description('Audience of the gateway\'s OWN Entra App Registration — what api requests a token FOR when calling the gateway (GATEWAY_ENTRA_AUDIENCE). A different registration from api\'s own (oidcAudience above): api is a token ISSUER\'s audience for end users, the gateway is a service-to-service audience for exactly one caller.')
param gatewayEntraAudience string

@description('Existing Cognitive Services / Azure AI Foundry account resource id the gateway is granted Cognitive Services OpenAI User on. Leave empty if every configured model uses a non-Azure provider (key-vault or env credential sources) — the role assignment is skipped rather than failing.')
param openAiResourceId string = ''

@secure()
@description('The full content of models.json (Task 5) — the gateway\'s model allowlist. Mounted as a Container Apps secret volume, never an environment variable, so it never appears in the portal\'s app-settings blade or in `azd env get-values`. Its `credential` entries name managed-identity or key-vault sources; it carries no provider key itself.')
param modelsJsonContent string

// --- azd's placeholder-image bootstrap (see containerApps.bicep) -------
param apiImageName string = ''
param gatewayImageName string = ''
param webImageName string = ''

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var namePrefix = 'lex${substring(resourceToken, 0, 8)}'

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: { 'azd-env-name': environmentName }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    openAiResourceId: openAiResourceId
  }
}

module keyVault 'modules/keyVault.bicep' = {
  name: 'keyVault'
  scope: rg
  params: {
    location: location
    // Key Vault names are globally unique across Azure and capped at 24
    // characters — namePrefix (11 chars: "lex" + 8-char token) plus "-kv"
    // stays comfortably inside that.
    name: '${namePrefix}-kv'
    tenantId: subscription().tenantId
    gatewayPrincipalId: identity.outputs.gatewayPrincipalId
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: rg
  params: {
    location: location
    name: '${namePrefix}-log'
  }
}

module containerApps 'modules/containerApps.bicep' = {
  name: 'containerApps'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
    logAnalyticsCustomerId: monitoring.outputs.customerId
    logAnalyticsSharedKey: monitoring.outputs.primarySharedKey
    apiIdentityResourceId: identity.outputs.apiIdentityResourceId
    apiPrincipalId: identity.outputs.apiPrincipalId
    gatewayIdentityResourceId: identity.outputs.gatewayIdentityResourceId
    gatewayPrincipalId: identity.outputs.gatewayPrincipalId
    webIdentityResourceId: identity.outputs.webIdentityResourceId
    webPrincipalId: identity.outputs.webPrincipalId
    allowedJurisdictions: allowedJurisdictions
    oidcIssuer: oidcIssuer
    oidcAudience: oidcAudience
    oidcSubjectClaim: oidcSubjectClaim
    oidcGroupsClaim: oidcGroupsClaim
    oidcRequiredClaims: oidcRequiredClaims
    oidcRoleMappings: oidcRoleMappings
    oidcClientId: oidcClientId
    oidcScope: oidcScope
    gatewayEntraTenantId: gatewayEntraTenantId
    gatewayEntraAudience: gatewayEntraAudience
    modelsJsonContent: modelsJsonContent
    apiImageName: apiImageName
    gatewayImageName: gatewayImageName
    webImageName: webImageName
  }
}

// Consumed by azure.yaml's `web` service (`docker.buildArgs`) via azd's
// environment-variable interpolation — every output here lands in
// `.azure/<env>/.env` under its own name, and `${VAR}` in azure.yaml reads
// it from there. This is how the web build gets api's real, just-provisioned
// These feed `azd`'s build step. The api FQDN is NOT among them: the SPA is
// built with VITE_API_BASE_URL=/api and reaches the API through web's own
// nginx, so no cross-origin URL has to be known before `azd provision` runs.
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerApps.outputs.registryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerApps.outputs.registryName
// `api` has no public ingress and the browser calls /api on its OWN origin,
// so there is no public API base URL to emit. Kept as the internal FQDN for
// diagnostics; azure.yaml no longer bakes it into the bundle.
output API_INTERNAL_FQDN string = containerApps.outputs.apiInternalFqdn
output OIDC_ISSUER_BROWSER string = oidcIssuer
output OIDC_CLIENT_ID string = oidcClientId
output OIDC_SCOPE string = oidcScope
output GATEWAY_FQDN string = containerApps.outputs.gatewayFqdn
output WEB_FQDN string = containerApps.outputs.webFqdn
output KEY_VAULT_URI string = keyVault.outputs.vaultUri

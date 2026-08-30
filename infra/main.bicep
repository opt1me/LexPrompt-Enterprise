// LexPrompt Stage 1 — the SAME system docker-compose.yml runs locally,
// provisioned in Azure. §5.1's whole argument is that local and Azure
// differ in deployment, not in code: one auth path with two issuers
// (Keycloak locally, Entra here), one gateway with two caller-auth modes
// (mtls locally, entra here), one set of credential-resolver adapters
// (env/file locally, managed-identity/key-vault here). Nothing below
// should read as a second design.
//
// Stage 2 adds the two stores this system now depends on — a PostgreSQL
// Flexible Server and a Storage account — each with public network access
// disabled and a private endpoint into a VNet the Container Apps environment
// is integrated with. Stage 1's own note here said they were deliberately
// absent; they are present now, and the sentence that has NOT changed with
// them is the egress one: a VNet-integrated environment gives the stores a
// private INBOUND path and does nothing whatever to `api`'s OUTBOUND
// traffic, so Spike 2 is still open and README.md still says so.
//
// NO CREDENTIAL IS A PARAMETER WITH A DEFAULT, AN OUTPUT, OR AN APP
// SETTING. The Postgres admin password and the two application role
// passwords are read out of this template's own Key Vault with getSecret(),
// which ARM resolves into the deployment's scrubbed secure-parameter slot.
// That has a consequence worth stating rather than discovering: the FIRST
// `azd provision` against a fresh subscription fails, because the vault it
// creates is empty and those three secrets do not exist yet. That failure
// is loud, names the vault and the secret, and is fixed by one
// `az keyvault secret set` per secret followed by a second `azd provision`.
// README.md's Azure section walks it in order. The alternative — a password
// parameter, or an azd environment value — would put a live credential in
// `.azure/<env>/.env` on somebody's laptop, which is the thing this whole
// arrangement exists not to do.
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

// --- Stage 2: the two stores -------------------------------------------
//
// The four numeric/boolean knobs below appear in `infra/main.parameters.json`
// as LITERAL JSON values rather than as `${AZD_VAR}` interpolations, and the
// duplication of the number is deliberate rather than sloppy: azd substitutes
// `${…}` textually, so an interpolated value always arrives as a JSON STRING,
// and a string handed to an `int` or `bool` parameter is a deployment that
// fails at parameter validation with a type error that reads as a template
// bug. An operator changes them by editing that file. The defaults here are
// what a deployment gets with no parameters file at all.
@description('Postgres server admin role name. This role runs the ONE psql step that creates lexprompt_migrator and lexprompt_app (see README.md); apps/api never signs in as it.')
param postgresAdministratorLogin string = 'lexprompt_admin'

@description('Name of the Key Vault secret holding the Postgres server admin password. The value is NEVER a parameter here — this template reads it with getSecret(), so it exists in the vault and in the deployment\'s scrubbed secure slot and nowhere else. Create it before the second `azd provision`.')
param postgresAdminPasswordSecretName string = 'postgres-admin-password'

@description('Name of the Key Vault secret holding lexprompt_app\'s password. Same handling as the admin secret above. This is the password YOU give the role when you run the psql step; nothing derives it, and nothing but the vault holds it.')
param databaseAppPasswordSecretName string = 'database-app-password'

@description('Name of the Key Vault secret holding lexprompt_migrator\'s password.')
param databaseMigratorPasswordSecretName string = 'database-migrator-password'

@description('Days of automated Postgres backup retention. The operator\'s decision; §17 Q3 (retention) is open and this template does not answer it.')
param postgresBackupRetentionDays int = 14

@description('Postgres max_connections, DECLARED rather than inherited from the SKU default. See infra/modules/postgres.bicep for the arithmetic against API_DATABASE_POOL_MAX (10, defaulted in both environments) and api\'s replica count (3).')
param postgresMaxConnections int = 100

@description('Enable Entra authentication on the Postgres server alongside password auth. Password auth stays enabled either way — apps/api reads a DSN and has no token-refresh path for a database role.')
param postgresEntraAuthentication bool = false

@description('Days a deleted blob stays recoverable. Deleting a matter genuinely purges its bytes; this is how long an administrator can still undo that.')
param blobSoftDeleteRetentionDays int = 7

@description('The blob container documents live in. One value, used to create the container AND to set API_BLOB_CONTAINER, so the two cannot drift.')
param blobContainerName string = 'documents'

// --- azd's placeholder-image bootstrap (see containerApps.bicep) -------
param apiImageName string = ''
param gatewayImageName string = ''
param webImageName string = ''

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var namePrefix = 'lex${substring(resourceToken, 0, 8)}'

// Computed here rather than taken from `keyVault.outputs.vaultName`, because
// `getSecret()` needs a vault symbol resolvable at compile time and a module
// output is not one. The same expression is passed INTO the module below, so
// the two cannot disagree.
var keyVaultName = '${namePrefix}-kv'

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
    name: keyVaultName
    tenantId: subscription().tenantId
    gatewayPrincipalId: identity.outputs.gatewayPrincipalId
  }
}

// The vault this template just created, referenced as `existing` so
// `getSecret()` can read the three passwords out of it. `getSecret()` is
// only valid when assigned DIRECTLY to a @secure() module parameter — it
// cannot be put in a variable or interpolated into a string — which is why
// the two DSNs are composed inside containerApps.bicep from ordinary
// @secure() parameters rather than here.
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
  scope: rg
}

module network 'modules/network.bicep' = {
  name: 'network'
  scope: rg
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  scope: rg
  params: {
    location: location
    name: '${namePrefix}-pg'
    vnetId: network.outputs.vnetId
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    administratorLogin: postgresAdministratorLogin
    administratorLoginPassword: vault.getSecret(postgresAdminPasswordSecretName)
    backupRetentionDays: postgresBackupRetentionDays
    maxConnections: postgresMaxConnections
    entraAuthentication: postgresEntraAuthentication
    tenantId: subscription().tenantId
  }
  dependsOn: [ keyVault ]
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: rg
  params: {
    location: location
    // Storage account names are globally unique, 3-24 characters, lowercase
    // letters and digits ONLY — no hyphens, which is why this one is not
    // '${namePrefix}-st'. namePrefix is 11 lowercase alphanumeric characters.
    name: '${namePrefix}st'
    vnetId: network.outputs.vnetId
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    apiPrincipalId: identity.outputs.apiPrincipalId
    containerName: blobContainerName
    blobSoftDeleteRetentionDays: blobSoftDeleteRetentionDays
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
    apiClientId: identity.outputs.apiClientId
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
    // Stage 2: the environment joins the VNet the two private endpoints
    // live in, and `api` is given the two DSNs and the blob account URL.
    infrastructureSubnetId: network.outputs.infrastructureSubnetId
    postgresFqdn: postgres.outputs.fullyQualifiedDomainName
    postgresDatabaseName: postgres.outputs.databaseName
    databaseAppPassword: vault.getSecret(databaseAppPasswordSecretName)
    databaseMigratorPassword: vault.getSecret(databaseMigratorPasswordSecretName)
    databaseWorkerPassword: vault.getSecret(databaseWorkerPasswordSecretName)
    blobAccountUrl: storage.outputs.blobAccountUrl
    blobContainer: storage.outputs.containerName
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
// Stage 2 diagnostics. A hostname, an account name and a container name —
// no DSN, no account key, no SAS. Both stores have public network access
// disabled, so neither of these resolves to anything usable from outside
// the environment's VNet; they are here so a deployer can run the two
// checks in README.md's Azure checklist without hunting in the portal.
output POSTGRES_FQDN string = postgres.outputs.fullyQualifiedDomainName
output POSTGRES_ADMIN_LOGIN string = postgres.outputs.administratorLogin
output BLOB_ACCOUNT_NAME string = storage.outputs.accountName
output BLOB_CONTAINER string = storage.outputs.containerName

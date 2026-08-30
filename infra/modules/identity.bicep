// Three user-assigned managed identities. Only ONE of them is a credential
// in the sense §5's Security/Risk review cares about: `gatewayIdentity`,
// which is granted the two provider-facing roles below and is the only
// principal this whole template ever points at a Cognitive Services
// resource or a Key Vault secret (S1: the gateway holds the only
// credentials). `apiIdentity` carries no Azure RBAC role at all — it
// exists purely so its principal id can be named as the gateway's single
// allowed caller (`GATEWAY_ENTRA_ALLOWED_OIDS`, containerApps.bicep).
// `webIdentity` carries no RBAC role either; it exists solely so the `web`
// container app can pull its own image from the registry via identity-based
// pull (containerApps.bicep's `AcrPull` assignments) instead of an
// admin-enabled registry password, which would be exactly the kind of app
// setting §5's "no key is a parameter, an output, or an app setting" rules
// out. Neither `apiIdentity` nor `webIdentity` can read a provider secret
// or call a provider — this file is where that boundary is drawn.
// ---------------------------------------------------------------------
// STAGE 2 CHANGED ONE SENTENCE ABOVE, AND THE CHANGE IS NAMED HERE RATHER
// THAN LEFT TO BE INFERRED FROM A DIFF.
//
// "`apiIdentity` carries no Azure RBAC role at all" is no longer true. It
// now carries exactly one, and the two data-plane grants Stage 2 needs are
// listed here in full so this file remains the place a reviewer reads to
// find out what each identity can do:
//
//  1. **Storage Blob Data Contributor**, granted to `apiIdentity` and
//     SCOPED TO THE ONE CONTAINER — not to the account, not to the
//     resource group, not to the subscription, and not Owner. §6.5 says
//     the document bytes are "reachable only through the API's managed
//     identity", and this is that sentence.
//
//     The assignment itself lives in `infra/modules/storage.bicep`, not in
//     this file, and it cannot live here: the container is a resource
//     `storage.bicep` declares, so the symbol needed to scope the
//     assignment only exists there — and `storage.bicep` already takes
//     `apiPrincipalId` from this module's output, so moving the assignment
//     here would make the two modules depend on each other in a cycle.
//     Named in both places is the honest answer to a requirement that says
//     "name them explicitly in identity.bicep".
//
//  2. **The Postgres database role**, if the operator chooses Entra
//     authentication for the server (`postgresEntraAuthentication`). This
//     one is NOT expressible in Bicep at all, and pretending otherwise
//     would be worse than saying so: granting a managed identity a
//     non-admin Postgres role is `SELECT pgaadauth_create_principal(...)`
//     followed by ordinary `GRANT`s, run over psql by the server's Entra
//     administrator — the same manual step, on the same connection, as
//     creating `lexprompt_migrator` and `lexprompt_app`. The only thing
//     Bicep could do instead is make `apiIdentity` a SERVER ADMINISTRATOR,
//     which is a much larger grant than the design asks for and is
//     deliberately not done. README.md's Azure section carries the psql.
//
// `gatewayIdentity` is unchanged and still holds the only PROVIDER
// credentials. `webIdentity` is unchanged and still holds nothing but
// AcrPull.
// ---------------------------------------------------------------------
metadata description = 'User-assigned managed identities for api and gateway.'

param location string
param namePrefix string

// The gateway's own Azure OpenAI / Foundry resource, if one is deployed
// alongside this template. Left empty, the role assignment below is
// skipped rather than failing the deployment — an operator using only
// third-party providers (OpenAI, Anthropic, OpenRouter via Key Vault
// secrets) has no Cognitive Services resource to grant against, and this
// module must not invent a requirement the design doesn't have. Resolved
// as an EXISTING resource, so it must already exist in this resource
// group by the time this module runs; a cross-resource-group Foundry
// resource is out of scope for this template (documented in README.md).
param openAiResourceId string = ''

var hasOpenAi = !empty(openAiResourceId)

// Well-known built-in role definition ids. Not created by this template —
// referenced only. Verify against `az role definition list --name "..."`
// before relying on them; this environment has no `az` to check them with.
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd' // Cognitive Services OpenAI User

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-api'
  location: location
}

resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-gateway'
  location: location
}

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-web'
  location: location
}

// Cognitive Services OpenAI User, scoped to the operator's own OpenAI /
// Foundry resource — the ONLY Azure RBAC role this template grants outside
// the Key Vault one in keyVault.bicep, and both go to the gateway's
// identity alone (S1: the gateway holds the only credentials).
resource gatewayOpenAiRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (hasOpenAi) {
  name: guid(openAiResourceId, gatewayIdentity.id, openAiUserRoleId)
  scope: openAiExisting
  properties: {
    principalId: gatewayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
  }
}

// `existing` reference is declared even when hasOpenAi is false: Bicep
// still needs a symbol to resolve, but `last(split(...))` on an empty
// string just names a resource that is never deployed against because the
// assignment above is conditioned out.
resource openAiExisting 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: hasOpenAi ? last(split(openAiResourceId, '/')) : 'unused'
}

output apiPrincipalId string = apiIdentity.properties.principalId
output apiClientId string = apiIdentity.properties.clientId
output apiIdentityResourceId string = apiIdentity.id
output gatewayPrincipalId string = gatewayIdentity.properties.principalId
output gatewayClientId string = gatewayIdentity.properties.clientId
output gatewayIdentityResourceId string = gatewayIdentity.id
output webPrincipalId string = webIdentity.properties.principalId
output webIdentityResourceId string = webIdentity.id

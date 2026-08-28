// A vault with RBAC authorisation and NO secrets defined in the template.
// An operator adds provider keys after `azd up` with
// `az keyvault secret set --vault-name <name> --name <secretName> --value <key>`,
// which is what keeps a key out of the repository, out of `azd env`, and
// out of any deployment log — the same property compose gets locally by
// reading `.env`, which this repo's `.gitignore` already keeps unstaged.
metadata description = 'Key Vault (RBAC) holding provider secrets the gateway reads at runtime.'

param location string
param name string
param tenantId string
// The gateway's managed identity — the ONLY principal granted read access
// to secrets in this vault (S1: the gateway holds the only credentials;
// `api` and `web` are never granted anything here).
param gatewayPrincipalId string

var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // No `accessPolicies`, no `secrets` child resource: RBAC-only, and the
    // one thing this template is not allowed to do is define what a secret
    // named here would actually contain.
  }
}

resource gatewaySecretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, gatewayPrincipalId, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
  }
}

output vaultUri string = vault.properties.vaultUri
output vaultName string = vault.name
output vaultResourceId string = vault.id

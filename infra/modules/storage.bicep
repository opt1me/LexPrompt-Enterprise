// The Storage account holding document bytes — the Azure counterpart of
// docker-compose.yml's `azurite` service, reached through the same
// `@azure/storage-blob` SDK by the same file (`apps/api/src/blob/store.ts`).
// Azurite is MICROSOFT'S OWN emulator, never MinIO and never anything
// "S3-compatible" (S30), so the two environments differ in the credential
// material and in nothing else.
//
// S2's stronger property is "no credential exists where managed identity is
// available", and this file expresses it three ways rather than one:
//
//   1. `allowSharedKeyAccess: false` — the account has no key-based auth AT
//      ALL. Not "we choose not to use the key": the platform refuses a
//      request signed with one. That makes the absence structural rather
//      than a habit, and it is what makes points 2 and 3 more than good
//      intentions.
//   2. There is no connection-string output. An output is a place a
//      credential would be, and README.md's Azure checklist greps for one.
//   3. `publicNetworkAccess: 'Disabled'` plus a private endpoint, so even a
//      credential that did exist would have nowhere to present it from.
//
// The API's managed identity is granted Storage Blob Data Contributor ON THE
// CONTAINER — not on the account, not on the resource group, not on the
// subscription, and not Owner. The assignment lives at the bottom of this
// file rather than in identity.bicep, and identity.bicep says why: the
// container symbol only exists here, and moving the assignment there would
// make identity.bicep depend on this module while this module already
// depends on identity.bicep for the principal id.
metadata description = 'Storage account and one private container for document bytes. No key auth, no public access, no credential output.'

param location string
param name string

@description('Resource id of the VNet the private endpoint\'s DNS zone is linked to.')
param vnetId string

@description('Resource id of the subnet the private endpoint\'s NIC lands in.')
param privateEndpointSubnetId string

@description('Principal id of the API\'s user-assigned managed identity — the ONLY principal granted anything on this account, and only on the one container.')
param apiPrincipalId string

@description('Container name. Must equal API_BLOB_CONTAINER, which containerApps.bicep sets from this same value; apps/api/src/config.ts defaults it to "documents" and the compose stack sets the same string.')
param containerName string = 'documents'

@allowed([ 'Standard_LRS', 'Standard_ZRS', 'Standard_GRS' ])
@description('Redundancy. LRS by default: geo-replicating a firm\'s client documents to a paired region is a data-residency decision the operator makes, not one this template makes for them.')
param skuName string = 'Standard_ZRS'

@description('Days a deleted blob is recoverable. The operator sets it; deleting a matter genuinely purges its bytes, and this window is how long that purge stays reversible by an administrator. §17 Q3 (retention) is open and README.md says so rather than implying an answer.')
@minValue(1)
@maxValue(365)
param blobSoftDeleteRetentionDays int = 7

@description('Days a deleted CONTAINER is recoverable. A separate window from the blob one above, because losing the container loses every document at once.')
@minValue(1)
@maxValue(365)
param containerSoftDeleteRetentionDays int = 30

// Storage Blob Data Contributor. Not Owner, not Contributor, and not scoped
// to the account: read/write/delete blobs inside ONE container and nothing
// else. `apps/api` needs exactly this — it writes bytes before inserting a
// row and deletes them on a matter cascade — and nothing more.
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

var dnsZoneName = 'privatelink.blob.core.windows.net'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  sku: { name: skuName }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    // The one that turns "we use managed identity" into "a key cannot be
    // used". With this false, the account keys still exist as objects but
    // authenticate nothing, so an account key leaked from anywhere is inert.
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      // No bypass for "AzureServices": that bypass is how a locked-down
      // account quietly becomes reachable by every first-party service in
      // the platform, which is not the same as being reachable by this
      // deployment's API.
      bypass: 'None'
      defaultAction: 'Deny'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: blobSoftDeleteRetentionDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: containerSoftDeleteRetentionDays
    }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    // Private. `allowBlobPublicAccess: false` above already makes any other
    // value inert, and both are set so neither is load-bearing alone.
    publicAccess: 'None'
  }
}

// ---- the private endpoint, and the DNS that makes it usable -------------

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${name}-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${name}-pls'
        properties: {
          privateLinkServiceId: account.id
          groupIds: [ 'blob' ]
        }
      }
    ]
  }
}

resource dnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: dnsZoneName
  location: 'global'
}

resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dnsZone
  name: '${name}-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnetId }
    registrationEnabled: false
  }
}

resource dnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: { privateDnsZoneId: dnsZone.id }
      }
    ]
  }
  dependsOn: [ dnsLink ]
}

// ---- the one role assignment, at container scope ------------------------

resource apiBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, apiPrincipalId, blobDataContributorRoleId)
  scope: container
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
  }
}

// OUTPUTS: the account URL and the container name. Deliberately NOTHING
// else — see this file's header, and README.md's Azure checklist, which
// greps `infra` and `azure.yaml` for a credential-shaped string and expects
// no match.
output blobAccountUrl string = account.properties.primaryEndpoints.blob
output containerName string = container.name
output accountName string = account.name

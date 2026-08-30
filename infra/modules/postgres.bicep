// PostgreSQL Flexible Server, version 16 — the Azure counterpart of
// docker-compose.yml's `postgres` service.
//
// The compose service is on the `internal` network with no published port,
// because it holds the firm's matters and must be unreachable from the host
// and have no route out. This module is the same property expressed in
// Azure: `publicNetworkAccess: 'Disabled'` plus one private endpoint into
// the Container Apps environment's own VNet, with a private DNS zone so the
// server's own FQDN resolves to the private address from inside the
// environment and to nothing at all from anywhere else.
//
// THERE ARE NO FIREWALL RULES IN THIS FILE, and their absence is the point
// rather than an omission: with public network access disabled there is
// nothing a firewall rule could allow, and a template that carried an
// `AllowAllAzureIps` rule "just in case" would silently re-open the server
// to every Azure tenant. Adding one is a deliberate act and there is nothing
// here to copy.
//
// WHAT THIS MODULE DOES NOT DO, named rather than left to be discovered:
// it does not create `lexprompt_migrator` or `lexprompt_app`. Those two
// roles and their grants are `infra/postgres/init.sql` locally, and one
// `psql` run by the Flexible Server admin here — see README.md's Azure
// section. `000_preconditions.sql` refuses the migration with a message
// naming that step when they are absent, which is why the refusal exists
// rather than letting a `GRANT` fail with "role does not exist".
metadata description = 'PostgreSQL Flexible Server 16, private endpoint only, no firewall rules.'

param location string
param name string

@description('Resource id of the VNet the private endpoint\'s DNS zone is linked to.')
param vnetId string

@description('Resource id of the subnet the private endpoint\'s NIC lands in. Must NOT be the Container Apps infrastructure subnet — that one is delegated, and a private endpoint cannot live in a delegated subnet.')
param privateEndpointSubnetId string

@description('The server admin role name. This is the role that runs the one psql step creating lexprompt_migrator and lexprompt_app; the API never signs in as it.')
param administratorLogin string

@secure()
@description('The server admin password. NO DEFAULT, and this parameter is never given one: main.bicep sources it from the Key Vault this template creates, with getSecret(), so the value exists in the vault and in the deployment\'s scrubbed secure-parameter slot and nowhere else. It is never an output of this module — an output is a place a credential would be, and this template has none.')
param administratorLoginPassword string

@description('Database name. The same name the compose stack uses, so one DSN shape covers both environments.')
param databaseName string = 'lexprompt'

@description('Compute SKU. Declared rather than defaulted because it is the single input that decides how much this costs and how many connections it can accept.')
param skuName string = 'Standard_D2ds_v5'

@allowed([ 'Burstable', 'GeneralPurpose', 'MemoryOptimized' ])
param skuTier string = 'GeneralPurpose'

@description('Provisioned storage, in GB. Auto-grow is DISABLED below, so this is a hard ceiling and a full disk is a loud failure rather than a surprise bill. Raise it deliberately.')
@minValue(32)
param storageSizeGb int = 128

@description('Days of automated backup retention. The operator sets this; the design has no view on how long a firm keeps its matters (README says so in as many words, and §17 Q3 is open).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 14

@allowed([ 'Enabled', 'Disabled' ])
@description('Geo-redundant backup. Off by default: replicating a firm\'s matters to a paired region is a data-residency decision, and §12\'s residency answers are the operator\'s, not this template\'s.')
param geoRedundantBackup string = 'Disabled'

// -------------------------------------------------------------------------
// THE CAP THAT WOULD OTHERWISE BE INHERITED.
//
// Three undeclared caps have already bitten this project — Fastify's 1 MiB
// bodyLimit, nginx's 1 MiB client_max_body_size and busboy's fieldSize —
// and every one of them was a library default nobody had written down. A
// Flexible Server's `max_connections` is the same shape: it is derived from
// the SKU's memory, it is invisible in this template unless it is named, and
// exceeding it does not degrade — it refuses new connections outright with
// "sorry, too many clients already", which surfaces as a 500 from a route
// that worked yesterday under a load nobody changed.
//
// The arithmetic that has to hold:
//
//     API_DATABASE_POOL_MAX  x  api maxReplicas  +  headroom  <=  maxConnections
//
// apps/api/src/config.ts defaults API_DATABASE_POOL_MAX to 10 and neither
// environment sets it; containerApps.bicep scales `api` to at most 3
// replicas. 10 x 3 = 30, plus the migration pool, plus whatever an operator
// has open in psql. 100 leaves real headroom at that shape, and it is the
// same number docker-compose.yml now names explicitly for the local
// container rather than inheriting from the postgres image.
//
// Changing the SKU does NOT change this value, deliberately: a smaller SKU
// with 100 declared connections refuses to start rather than silently
// running with fewer than the pool arithmetic assumes.
// -------------------------------------------------------------------------
@description('Postgres max_connections. Declared, never inherited from the SKU default — see this file\'s own comment for the arithmetic against API_DATABASE_POOL_MAX and api\'s replica count.')
@minValue(50)
param maxConnections int = 100

@description('Enable Microsoft Entra authentication ALONGSIDE password authentication. Password auth stays on either way: apps/api reads a DSN and has no token-refresh path for a Postgres role, so turning password auth off would leave it unable to connect. Entra auth is here for the operator who wants the admin step done as a directory identity rather than as a stored password.')
param entraAuthentication bool = false

@description('Tenant id, required when entraAuthentication is true and ignored otherwise.')
param tenantId string = ''

var dnsZoneName = 'privatelink.postgres.database.azure.com'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: '16'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    storage: {
      storageSizeGB: storageSizeGb
      // Off deliberately — see the storageSizeGb parameter's own note. A
      // silently growing disk is a bill nobody approved.
      autoGrow: 'Disabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    network: {
      // The whole point of this module. With this Disabled there is no
      // public endpoint to firewall, which is why there are no firewall
      // rules below.
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    authConfig: {
      activeDirectoryAuth: entraAuthentication ? 'Enabled' : 'Disabled'
      passwordAuth: 'Enabled'
      tenantId: entraAuthentication ? tenantId : ''
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// TLS, declared rather than assumed. Flexible Server enforces TLS by default
// today; naming both settings means a future default change does not quietly
// let a plaintext connection through, and it means the DSN's own
// `sslmode=verify-full` is met by a server that actually requires it.
//
// These are applied one after another rather than in parallel: two
// concurrent configuration writes against one server race, and max_connections
// is a static parameter that restarts the server when it changes.
resource requireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'on'
    source: 'user-override'
  }
}

resource minTlsVersion 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'ssl_min_protocol_version'
  properties: {
    value: 'TLSv1.2'
    source: 'user-override'
  }
  dependsOn: [ requireSecureTransport ]
}

resource maxConnectionsConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'max_connections'
  properties: {
    value: string(maxConnections)
    source: 'user-override'
  }
  dependsOn: [ minTlsVersion ]
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
          privateLinkServiceId: server.id
          groupIds: [ 'postgresqlServer' ]
        }
      }
    ]
  }
}

resource dnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: dnsZoneName
  location: 'global'
}

// Without this link the zone exists and resolves for nobody. A private
// endpoint whose DNS is not linked is the failure mode that looks like a
// firewall problem: the connection times out, the endpoint is green in the
// portal, and the server's FQDN is still resolving to its public address —
// which is refused, because public access is disabled. README.md's Azure
// checklist has the one dig command that tells the two apart.
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
        name: 'postgres'
        properties: { privateDnsZoneId: dnsZone.id }
      }
    ]
  }
  dependsOn: [ dnsLink ]
}

// OUTPUTS: a hostname, a database name, and an admin login. NO CONNECTION
// STRING, and no password.
//
// The task brief asked this module to output "the two connection strings the
// API reads". It cannot, and should not: those two DSNs name lexprompt_app
// and lexprompt_migrator, which are created by a psql step this template
// does not run, with passwords this template never sees — and a DSN carries
// a password, so an output of one would be exactly the credential-in-an-
// output that storage.bicep is forbidden from having. main.bicep composes
// the two DSNs from this FQDN plus two passwords read out of Key Vault, and
// hands them to containerApps.bicep as @secure() parameters.
output fullyQualifiedDomainName string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
output administratorLogin string = administratorLogin
output serverName string = server.name

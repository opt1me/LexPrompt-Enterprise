// A Log Analytics workspace for the Container Apps environment's own
// platform logs and the gateway's `call.started`/`call.finished` log line
// (§10) — retained 90 days, per Task 25's point 5. Nothing else is
// provisioned here: no Application Insights component, because nothing in
// Stage 1 emits traces or metrics beyond what Container Apps writes to
// this workspace by default.
metadata description = 'Log Analytics workspace backing the Container Apps environment.'

param location string
param name string

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: name
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

output workspaceResourceId string = workspace.id
output customerId string = workspace.properties.customerId
#disable-next-line outputs-should-not-contain-secrets -- read by containerApps.bicep to wire the environment's log destination; not a provider credential.
output primarySharedKey string = workspace.listKeys().primarySharedKey

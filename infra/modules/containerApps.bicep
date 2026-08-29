// The Container Apps environment, a registry to push service images into,
// and the three apps: web (external), api (external — see note below) and
// gateway (internal only). This is the Azure counterpart of
// docker-compose.yml's three services and its network topology, not a
// second design: §5.1's argument is that local and Azure differ in
// deployment, not in code, and this file is where that has to be true or
// false as a checkable fact.
metadata description = 'Container Apps environment, registry and the three services.'

param location string
param namePrefix string

param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string

param apiIdentityResourceId string
param apiPrincipalId string
param gatewayIdentityResourceId string
param gatewayPrincipalId string
param webIdentityResourceId string
param webPrincipalId string

// P4 / S27: passed straight through from main.bicep, which itself declares
// NO default (see main.bicep's own comment). Repeating a default here,
// even innocuously, would reintroduce exactly the guess this design
// refuses to make on an operator's behalf.
param allowedJurisdictions string

// api's own end-user auth (apps/api/src/config.ts: API_ISSUER, API_AUDIENCE,
// API_SUBJECT_CLAIM, API_GROUPS_CLAIM, API_REQUIRED_CLAIMS) — identical in
// shape to what docker-compose.yml sets from Keycloak's values (§5.1 row 1),
// consumed by the same code path.
param oidcIssuer string
param oidcAudience string
param oidcSubjectClaim string
param oidcGroupsClaim string
// `claim=value` pairs, comma-separated — e.g. `tid=<tenant-guid>` — NOT a
// JSON object. apps/api/src/config.ts's `parseRequiredClaims` splits on
// `,` and then on the first `=`; `.env.example`'s own comment says a
// literal `"{}"` is not accepted. (This is corrected from the task brief,
// which wrote this value as `{"tid":"<tenant>"}` — see the Task 25 report.)
param oidcRequiredClaims string

// The web SPA's own Entra App Registration (public client) and the scope
// it requests. Not named in the brief's "three/five OIDC values" list
// (those are all API_*-side validation config), but VITE_OIDC_CLIENT_ID and
// VITE_OIDC_SCOPE are exactly what docker-compose.yml's `web.build.args`
// bakes in locally from OIDC_CLIENT_ID / OIDC_SCOPE — parity with compose
// requires them here too, or the deployed web app has no way to sign in.
param oidcClientId string
param oidcScope string

// The gateway's OWN app registration (what `api` requests a token FOR when
// calling the gateway) and the tenant it trusts — apps/gateway/src/config.ts's
// `parseCaller` 'entra' branch: GATEWAY_ENTRA_TENANT_ID, GATEWAY_ENTRA_AUDIENCE,
// GATEWAY_ENTRA_ALLOWED_OIDS. The allowed-subject value is NOT a parameter —
// it is `apiPrincipalId` above, computed at deploy time, because the
// property being asserted ("the gateway's only caller is this specific
// api instance's own identity") must not be typeable as anything else.
param gatewayEntraTenantId string
param gatewayEntraAudience string

// Content of models.json (Task 5 / Task 25 point 4): mounted as a
// Container Apps SECRET VOLUME, never an inline environment variable, so
// it is invisible in the portal's app-settings blade and in
// `azd env get-values`. The file's own `credential` entries name either
// `managed-identity` (resolved via the gateway's identity directly) or
// `key-vault` (resolved via that identity's Key Vault Secrets User role) —
// this parameter never itself carries a provider API key.
@secure()
param modelsJsonContent string

// azd's placeholder-image bootstrap: `azd provision` must be able to create
// all three Container Apps before any image has been built, so each image
// parameter defaults to a public placeholder and `azd deploy` (which `azd up`
// runs immediately afterwards) overwrites it with the real, just-built image.
// Standard azd pattern for `host: containerapp` services — not a stub left
// unfinished.
param apiImageName string = ''
param gatewayImageName string = ''
param webImageName string = ''

var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: replace('${namePrefix}acr', '-', '')
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false // identity-based pull only — no registry password to leak
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

resource apiAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, apiPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource gatewayAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, gatewayPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource webAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, webPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: webPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-web'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${webIdentityResourceId}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      // Externally reachable — this is the one app a browser loads directly.
      ingress: { external: true, targetPort: 80, transport: 'auto', allowInsecure: false }
      registries: [ { server: registry.properties.loginServer, identity: webIdentityResourceId } ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: !empty(webImageName) ? webImageName : placeholderImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            // nginx proxies /api/ here. `api` has no public ingress, so this is
            // the only route to it and the browser stays same-origin — the same
            // shape compose has, with only this value differing.
            //
            // `.internal.` is the environment's private DNS zone: resolvable
            // from inside this Container Apps environment and nowhere else.
            { name: 'API_UPSTREAM', value: '${namePrefix}-api.internal.${environment.properties.defaultDomain}' }
            // Azure DNS, not Docker's embedded 127.0.0.11. nginx resolves the
            // upstream per request through this, so an api revision replacing
            // its address does not leave the proxy pointing at nothing.
            { name: 'NGINX_RESOLVER', value: '168.63.129.16' }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
  dependsOn: [ webAcrPull ]
}

resource gatewayApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-gateway'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${gatewayIdentityResourceId}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: false          // internal only: no route from the internet
        targetPort: 8081
        transport: 'http'
        allowInsecure: false
      }
      registries: [ { server: registry.properties.loginServer, identity: gatewayIdentityResourceId } ]
      secrets: [
        // The ONLY secret this app defines. Its value is model METADATA —
        // endpoints, jurisdictions, and which credential source to use for
        // each — never a provider key itself (S1). It is a secret rather
        // than a plain env var solely so it is absent from the app-settings
        // blade and from `azd env get-values` (Task 25 point 4).
        { name: 'models-json', value: modelsJsonContent }
      ]
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: !empty(gatewayImageName) ? gatewayImageName : placeholderImage
          resources: { cpu: json('0.5'), memory: '1.0Gi' }
          env: [
            { name: 'GATEWAY_PORT', value: '8081' }
            { name: 'GATEWAY_MODELS_FILE', value: '/config/models.json' }
            { name: 'GATEWAY_ALLOWED_JURISDICTIONS', value: allowedJurisdictions }
            { name: 'GATEWAY_CALLER_AUTH', value: 'entra' }
            { name: 'GATEWAY_ENTRA_TENANT_ID', value: gatewayEntraTenantId }
            { name: 'GATEWAY_ENTRA_AUDIENCE', value: gatewayEntraAudience }
            // The gateway's one allowed caller: api's OWN managed identity
            // principal id, computed here rather than typed by an operator.
            { name: 'GATEWAY_ENTRA_ALLOWED_OIDS', value: apiPrincipalId }
            { name: 'GATEWAY_PUBLIC_ORIGIN', value: 'https://${webApp.properties.configuration.ingress.fqdn}' }
            // No OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY: no
            // key is a parameter, an output, or an app setting (point 3).
            // Every credential models.json declares resolves at runtime via
            // this container's managed identity or Key Vault.
          ]
          volumeMounts: [ { volumeName: 'models-config', mountPath: '/config' } ]
        }
      ]
      volumes: [
        {
          name: 'models-config'
          storageType: 'Secret'
          secrets: [ { secretRef: 'models-json', path: 'models.json' } ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
  dependsOn: [ gatewayAcrPull ]
}

// `api` is INTERNAL ONLY, and the reasoning that once made it external is
// recorded here because it was half right.
//
// True: the web app is a static SPA whose JS runs in the USER's browser, so
// it is the browser, not the `web` container, that issues the API calls.
// False: the conclusion that `api` therefore needs a public hostname. The
// `web` container is also an nginx reverse proxy, so the browser calls
// /api on its OWN origin and nginx forwards over the environment's internal
// network — the same shape compose has, with only the upstream address
// differing.
//
// The earlier version shipped a public api FQDN baked into the bundle as an
// absolute cross-origin URL, and `apps/api` implements no CORS at all: every
// browser request would have failed preflight. The app worked in compose and
// would have been broken on the first click in Azure, at the one layer local
// development cannot exercise. Same-origin everywhere removes the CORS
// question entirely and leaves no public API surface to defend.
//
// CORRECTED (Task 26): this comment used to justify itself by saying
// docker-compose.yml publishes `api` on 8080:8080 "for the same reason".
// It no longer does. Compose now puts `api` on the `internal` network ONLY,
// with no published port, reached through `web`'s nginx proxy at /api —
// because outbound access in Docker comes from being attached to any
// non-internal network, so a routable attachment gave `api` a default route
// while the topology still read as "api is not on egress". The two
// environments therefore differ here in TOPOLOGY, which §5.1 row 9
// (ingress) is the row for, and the local shape is the stricter of the two:
// compose proves the egress denial, Azure only expresses it (Spike 2).
resource apiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentityResourceId}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      // INTERNAL ONLY, matching compose, where `api` publishes no port at all.
      // A browser reaches it through `web`'s nginx proxy at /api, so it is
      // same-origin in both environments.
      //
      // It was `external: true`, and that was a real defect rather than a
      // preference: `apps/api` implements no CORS at all, so a public api
      // hostname made every browser call cross-origin and every request would
      // have failed preflight — an app that works in compose and is broken on
      // the first click in Azure, at the one layer local development cannot
      // exercise. Same-origin everywhere means there is no CORS policy in this
      // system to get wrong, and no public API surface to defend.
      ingress: { external: false, targetPort: 8080, transport: 'http', allowInsecure: false }
      registries: [ { server: registry.properties.loginServer, identity: apiIdentityResourceId } ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: !empty(apiImageName) ? apiImageName : placeholderImage
          resources: { cpu: json('0.5'), memory: '1.0Gi' }
          env: [
            { name: 'API_PORT', value: '8080' }
            { name: 'API_ISSUER', value: oidcIssuer }
            { name: 'API_AUDIENCE', value: oidcAudience }
            { name: 'API_SUBJECT_CLAIM', value: oidcSubjectClaim }
            { name: 'API_GROUPS_CLAIM', value: oidcGroupsClaim }
            { name: 'API_REQUIRED_CLAIMS', value: oidcRequiredClaims }
            { name: 'API_WORKSPACE_ID', value: '00000000-0000-0000-0000-000000000001' }
            { name: 'API_GATEWAY_URL', value: 'https://${gatewayApp.properties.configuration.ingress.fqdn}' }
            // NO API_MTLS_*: apps/api/src/config.ts's own comment says this
            // set is "Absent in a firm deployment, where the gateway trusts
            // this process's managed identity instead" — setting any one of
            // the three would make `parseMtls` require all three and build
            // an mTLS dispatcher nothing on the gateway side expects,
            // because the gateway here runs GATEWAY_CALLER_AUTH=entra, not
            // mtls.
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
  dependsOn: [ apiAcrPull ]
}

output registryLoginServer string = registry.properties.loginServer
output registryName string = registry.name
// Internal FQDN — `api` has no public ingress. Emitted for diagnostics only;
// nothing outside the Container Apps environment can resolve it.
output apiInternalFqdn string = apiApp.properties.configuration.ingress.fqdn
output gatewayFqdn string = gatewayApp.properties.configuration.ingress.fqdn
output webFqdn string = webApp.properties.configuration.ingress.fqdn

// The VNet the Container Apps environment sits in, and the subnet the two
// private endpoints land in.
//
// This module exists ONLY because Stage 2 introduced two stores that must
// not be reachable from the internet. Stage 1 had nothing worth putting
// behind a private endpoint — the gateway holds credentials but reaching it
// needs a token, and `web` is static files — so the environment had no VNet
// at all and the template said so plainly. That sentence in README.md has
// changed with this module, and it changed NARROWLY: a VNet-integrated
// environment gives the two stores a private INBOUND path. It does not
// restrict `api`'s OUTBOUND traffic in any way. Container Apps still gives
// every replica default outbound internet access unless a route table, a
// NAT gateway or a firewall is put in front of it, and none of those is
// created here. So the local stack still proves the egress denial and Azure
// still only expresses it — Spike 2 is open, exactly as before.
//
// DECLARED CAP, not inherited (the three undeclared-cap defects this project
// has already found were all a default nobody wrote down): the address space
// below is fixed and small, and the infrastructure subnet's size is the
// hard ceiling on how many replicas this environment can ever run. A
// Consumption-only environment takes a /23 and allocates addresses to
// revisions and replicas out of it; running out shows up as revisions that
// will not start, with no message about addresses. If this environment has
// to grow past that, the subnet is what has to grow, and it cannot be
// resized in place.
metadata description = 'VNet, the Container Apps infrastructure subnet, and the private-endpoint subnet.'

param location string
param namePrefix string

@description('Address space for the whole VNet. Must not overlap anything the firm peers this to; there is no way for this template to know what that is, so it is a parameter rather than a constant.')
param vnetAddressPrefix string = '10.20.0.0/16'

@description('The Container Apps environment\'s infrastructure subnet. A Consumption-only environment (this one declares no workload profiles) requires a /23 AND a delegation to Microsoft.App/environments; the workload-profiles shape takes a /27 and no delegation. The two are not interchangeable and picking the wrong one fails at environment creation with a message about the subnet, not about the shape.')
param infrastructureSubnetPrefix string = '10.20.0.0/23'

@description('The subnet the Postgres and Blob private endpoints put their NICs in. Separate from the infrastructure subnet deliberately: private endpoints cannot live in a delegated subnet.')
param privateEndpointSubnetPrefix string = '10.20.2.0/24'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${namePrefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ vnetAddressPrefix ] }
    subnets: [
      {
        name: 'infrastructure'
        properties: {
          addressPrefix: infrastructureSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          // Private endpoints refuse to deploy into a subnet with network
          // policies enforced on them. This is the documented requirement,
          // not a relaxation: it disables NSG/UDR enforcement for the
          // private-endpoint NICs in this subnet, which hold no workload.
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output infrastructureSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id

env              = "dev"
dashboard_domain = "app.dev.dormeto.com"
auth_domain      = "auth.app.dev.dormeto.com"
local_dev        = true
smoke_user       = true
routers = [
  { name = "dmt-dev", region = "eu-west-1", controller = "dmt-dev-controller", onboarder = "dmt-dev-onboarder" },
]
organization_id = "o-vvk0115ixn"
# The manager's IP lists (R6b), read by every router (dmt-dev's own censys list stays in its Terraform).
ip_lists = [
  { name = "ipsum", url = "https://raw.githubusercontent.com/stamparm/ipsum/master/ipsum.txt" },
  { name = "aws", url = "https://ip-ranges.amazonaws.com/ip-ranges.json" },
  { name = "gcp", url = "https://www.gstatic.com/ipranges/cloud.json" },
  { name = "digitalocean", url = "https://digitalocean.com/geo/google.csv" },
]

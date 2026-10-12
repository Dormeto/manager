env              = "dev"
dashboard_domain = "app.dev.dormeto.com"
auth_domain      = "auth.app.dev.dormeto.com"
local_dev        = true
smoke_user       = true
routers = [
  { name = "dmt-dev", region = "eu-west-1", controller = "dmt-dev-controller", onboarder = "dmt-dev-onboarder" },
]
organization_id = "o-vvk0115ixn"

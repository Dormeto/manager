# The command role's permissions for the Kubernetes proxies of private EKS endpoints (R10.6, manager 0.20.0), in the
# account's partition.
mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "222222222222" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws-us-gov" }
  }
}

variables {
  manager_account_id = "121014831971"
  envs               = ["dev"]
  boundary_policy    = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
}

run "the_command_role_manages_the_kubernetes_proxies_network" {
  command = plan

  assert {
    condition = [for s in jsondecode(aws_iam_role_policy.command.policy).Statement : s if s.Sid == "KubeProxyNetworkRead"] == [{
      Sid = "KubeProxyNetworkRead", Effect = "Allow", Resource = "*"
      Action = ["ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeNetworkInterfaces"]
    }]
    error_message = "The command role must describe security groups, subnets, VPCs and network interfaces."
  }
  assert {
    condition = [for s in jsondecode(aws_iam_role_policy.command.policy).Statement : s.Condition if s.Sid == "KubeProxySecurityGroups"] == [{
      StringEquals = { "aws:ResourceTag/dormeto:role" = "kubernetes-proxy" }
    }]
    error_message = "Egress and deletion only on security groups tagged dormeto:role = kubernetes-proxy."
  }
  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.command.policy).Statement : s.Resource if s.Sid == "KubeProxyCreateSecurityGroup"] == ["arn:aws-us-gov:ec2:*:*:vpc/*"]
    error_message = "The proxy's group is created in the account's VPCs and in those shared with it (RAM), whose ARN carries their owner's account."
  }
  assert {
    condition     = [for s in jsondecode(aws_iam_role_policy.command.policy).Statement : s.Resource if s.Sid == "KubeProxyCreateTaggedSecurityGroup"] == ["arn:aws-us-gov:ec2:*:222222222222:security-group/*"]
    error_message = "The proxy's group itself is the account's own, in its partition."
  }
  assert {
    condition = [for s in jsondecode(aws_iam_role_policy.command.policy).Statement : s.Resource if s.Sid == "KubeProxyClusterGroups"] == [["arn:aws-us-gov:ec2:*:222222222222:security-group/*"]]
    error_message = "Ingress on security groups, in the account and partition, tagged aws:eks:cluster-name."
  }
}

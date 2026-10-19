output "dashboard_url" {
  description = "SaaS dashboard (sign up here)"
  value       = local.dashboard_url
}

output "api_url" {
  description = "API base URL (used by the iOS SDK and widget)"
  value       = local.api_url
}

output "widget_url" {
  description = "Web chat widget script"
  value       = "${local.dashboard_url}/widget.js"
}

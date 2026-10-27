output "nameservers" {
  value = aws_route53_zone.app.name_servers
}
output "site_url" {
  value = var.custom_domain_enabled ? "https://${var.domain}" : "https://${aws_cloudfront_distribution.web.domain_name}"
}
output "cloudfront_domain" {
  value = aws_cloudfront_distribution.web.domain_name
}
output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}
output "web_bucket" {
  value = aws_s3_bucket.web.id
}
output "content_bucket" {
  value = aws_s3_bucket.content.id
}
output "table_name" {
  value = aws_dynamodb_table.application.name
}
output "lambda_function_name" {
  value = aws_lambda_function.api.function_name
}
output "deployment_role_arn" {
  value     = aws_iam_role.deployment.arn
  sensitive = true
}
output "public_config" {

  value = {
    apiBaseUrl = "/api", region = var.region, userPoolId = aws_cognito_user_pool.users.id, userPoolClientId = aws_cognito_user_pool_client.web.id, release = "bootstrap"
  }

}

data "archive_file" "bootstrap_api" {

  type        = "zip"
  output_path = "${path.module}/.terraform/bootstrap-api.zip"
  source {

    filename = "index.js"
    content  = "exports.handler = async () => ({statusCode:503,headers:{'content-type':'application/json'},body:JSON.stringify({error:'Application deployment pending'})});"

  }

}
resource "aws_iam_role" "api" {

  name = "${local.name}-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "lambda.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })

}
resource "aws_cloudwatch_log_group" "api" {

  name              = "/aws/lambda/${local.name}-api"
  retention_in_days = 7

}
resource "aws_iam_role_policy" "api" {

  name = "project-data-only"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
      {
        Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"], Resource = [aws_dynamodb_table.application.arn, "${aws_dynamodb_table.application.arn}/index/*"]
      },
      {
        Effect = "Allow", Action = ["dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.application.arn
      },
      {
        Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.content.arn}/*"
      },
      {
        Effect = "Allow", Action = ["bedrock:InvokeModel"], Resource = "arn:aws:bedrock:us-east-2::foundation-model/meta.llama3-3-70b-instruct-v1:0"
      }
    ]
  })

}
resource "aws_lambda_function" "api" {

  function_name                  = "${local.name}-api"
  role                           = aws_iam_role.api.arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = data.archive_file.bootstrap_api.output_path
  source_code_hash               = data.archive_file.bootstrap_api.output_base64sha256
  memory_size                    = 256
  timeout                        = 15
  reserved_concurrent_executions = 5
  environment {
    variables = {
      TABLE_NAME           = aws_dynamodb_table.application.name, CONTENT_BUCKET = aws_s3_bucket.content.id, RELEASE_SHA = "bootstrap", CONTENT_RELEASE = var.content_release, SCHOOL_AI_ENABLED = tostring(var.school_ai_enabled)
      USER_POOL_ID         = aws_cognito_user_pool.users.id, SITE_URL = "https://${var.domain}"
      PARENT_EMAIL_ENABLED = tostring(var.parent_email_enabled), PARENT_EMAIL_FROM = "updates@${var.domain}", PARENT_EMAIL_ALLOWED_RECIPIENTS = join(",", var.parent_email_allowed_recipients)
    }
  }
  depends_on = [aws_iam_role_policy.api, aws_cloudwatch_log_group.api]
  lifecycle {
    ignore_changes = [filename, source_code_hash, environment[0].variables["RELEASE_SHA"]]
  }

}
resource "aws_apigatewayv2_api" "app" {

  name          = "${local.name}-api"
  protocol_type = "HTTP"

}
resource "aws_apigatewayv2_integration" "api" {

  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 15000

}
resource "aws_apigatewayv2_authorizer" "users" {

  api_id           = aws_apigatewayv2_api.app.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "verified-school-user-pool"
  jwt_configuration {

    audience = [aws_cognito_user_pool_client.web.id]
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.users.id}"

  }

}
resource "aws_apigatewayv2_route" "public" {

  for_each  = toset(["GET /api/health", "GET /api/catalog", "GET /api/lessons/{chapterId}"])
  api_id    = aws_apigatewayv2_api.app.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"

}
resource "aws_apigatewayv2_route" "private" {

  api_id               = aws_apigatewayv2_api.app.id
  route_key            = "$default"
  target               = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type   = "JWT"
  authorizer_id        = aws_apigatewayv2_authorizer.users.id
  authorization_scopes = ["aws.cognito.signin.user.admin"]

}
resource "aws_cloudwatch_log_group" "gateway" {

  name              = "/sls-hackathon-2026/http-api"
  retention_in_days = 7

}
resource "aws_apigatewayv2_stage" "live" {

  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_rate_limit  = 5
    throttling_burst_limit = 10
  }
  access_log_settings {

    destination_arn = aws_cloudwatch_log_group.gateway.arn
    format = jsonencode({
      requestId = "$context.requestId", route = "$context.routeKey", status = "$context.status", responseLength = "$context.responseLength", integrationError = "$context.integrationErrorMessage"
    })

  }

}
resource "aws_lambda_permission" "gateway" {

  statement_id  = "HttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*/*"

}

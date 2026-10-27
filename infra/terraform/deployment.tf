data "aws_iam_openid_connect_provider" "github" {

  arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"

}
resource "aws_iam_role" "deployment" {

  name = "${local.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = "sts:AssumeRoleWithWebIdentity", Principal = {
        Federated = data.aws_iam_openid_connect_provider.github.arn
        }, Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com", "token.actions.githubusercontent.com:sub" = var.github_oidc_subject
        }
      }
    }]
  })

}
resource "aws_iam_role_policy" "deployment" {

  name = "project-release-only"
  role = aws_iam_role.deployment.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = [aws_s3_bucket.web.arn, aws_s3_bucket.content.arn]
      },
      {
        Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.web.arn}/*"
      },
      {
        Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = ["${aws_s3_bucket.content.arn}/content/*", "${aws_s3_bucket.content.arn}/media/*"]
      },
      {
        Effect = "Allow", Action = ["lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:GetFunctionConfiguration", "lambda:GetFunction"], Resource = aws_lambda_function.api.arn
      },
      {
        Effect = "Allow", Action = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], Resource = aws_cloudfront_distribution.web.arn
      }
    ]
  })

}

# Parent email uses the existing API/table. No sending is enabled until the private
# controlled-recipient allowlist and explicit activation flag are supplied.
resource "aws_sesv2_email_identity" "parent_updates" {
  email_identity = var.domain
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_route53_record" "parent_email_dkim" {
  count   = 3
  zone_id = aws_route53_zone.app.zone_id
  name    = "${aws_sesv2_email_identity.parent_updates.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain}"
  type    = "CNAME"
  ttl     = 300
  records = ["${aws_sesv2_email_identity.parent_updates.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "parent_updates" {
  email_identity         = aws_sesv2_email_identity.parent_updates.email_identity
  mail_from_domain       = "mail-from.${var.domain}"
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_route53_record" "parent_email_mail_from_mx" {
  zone_id = aws_route53_zone.app.zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.parent_updates.mail_from_domain
  type    = "MX"
  ttl     = 300
  records = ["10 feedback-smtp.${var.region}.amazonses.com"]
}

resource "aws_route53_record" "parent_email_mail_from_spf" {
  zone_id = aws_route53_zone.app.zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.parent_updates.mail_from_domain
  type    = "TXT"
  ttl     = 300
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_iam_role_policy" "parent_email" {
  name = "bounded-parent-email"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["cognito-idp:AdminGetUser"], Resource = aws_cognito_user_pool.users.arn }
      ], var.parent_email_enabled && length(var.parent_email_allowed_recipients) > 0 ? [
      {
        Effect = "Allow", Action = ["ses:SendEmail"], Resource = aws_sesv2_email_identity.parent_updates.arn
        Condition = {
          StringEquals                = { "ses:FromAddress" = "updates@${var.domain}" }
          "ForAllValues:StringEquals" = { "ses:Recipients" = var.parent_email_allowed_recipients }
        }
      }
      ] : [], var.parent_email_enabled && length(var.parent_email_allowed_recipients) > 0 ? [
      {
        Effect = "Allow", Action = ["ses:ApplyTrackingConfigurationOverrides"], Resource = "*"
        Condition = {
          StringEquals = {
            "ses:OpenTrackingEnabled"  = "DISABLED"
            "ses:ClickTrackingEnabled" = "DISABLED"
          }
        }
      }
    ] : [])
  })
}
